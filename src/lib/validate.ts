import type { Tag } from "./data-item";

export type ValidationResult =
  | { valid: true }
  | { valid: false; error: string };

// --- Format patterns ---

// SHA-256 hex: exactly 64 lowercase hex characters
const SHA256_HEX = /^[0-9a-f]{64}$/;

// ISO-8601 timestamp with timezone (the SDK uses datetime.now(UTC).isoformat())
const ISO8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

// UTC date: YYYY-MM-DD
const DATE_UTC = /^\d{4}-\d{2}-\d{2}$/;

// UUID v4 (the SDK uses uuid.uuid4())
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Non-negative integer as string
const NON_NEGATIVE_INT = /^(0|[1-9]\d*)$/;

// Semver: digits and dots only — no pre-release, no build metadata, no letters
const SEMVER = /^\d+\.\d+\.\d+$/;

// Namespace: must be a SHA-256 hash (SDK hashes the plaintext namespace before building the DataItem)
const NAMESPACE = SHA256_HEX;

// Minimum SDK version the proxy will accept
const MIN_SDK_VERSION = [0, 2, 0] as const;

const MAX_DATA_ITEM_SIZE = 12_288; // 12KB

const EXPECTED_TAG_COUNT = 9;
const EXPECTED_BODY_FIELD_COUNT = 5;

// --- Helpers ---

function fail(error: string): ValidationResult {
  return { valid: false, error };
}

function parseSemver(s: string): [number, number, number] | null {
  const match = s.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

function semverGte(a: [number, number, number], b: readonly [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true; // equal
}

// --- Main validation ---

export function validateDataItem(
  signatureType: number,
  tags: Tag[],
  rawData: Buffer,
  totalSize: number,
  target: string | undefined,
  anchor: string | undefined,
): ValidationResult {
  // Size limit
  if (totalSize > MAX_DATA_ITEM_SIZE) {
    return fail(`DataItem exceeds maximum size of ${MAX_DATA_ITEM_SIZE} bytes`);
  }

  // Signature type must be Arweave RSA-4096
  if (signatureType !== 1) {
    return fail(`Invalid signature type: ${signatureType}, expected 1 (Arweave RSA-4096)`);
  }

  // Target and anchor must not be set — the SDK never uses these fields,
  // and they would allow 32 bytes each of arbitrary unvalidated data on-chain
  if (target !== undefined) {
    return fail("DataItem must not have a target field");
  }
  if (anchor !== undefined) {
    return fail("DataItem must not have an anchor field");
  }

  // Exact tag count — no extra tags allowed
  if (tags.length !== EXPECTED_TAG_COUNT) {
    return fail(`Expected exactly ${EXPECTED_TAG_COUNT} tags, got ${tags.length}`);
  }

  // Build tag map and check for duplicate tag names
  const tagMap = new Map<string, string>();
  for (const tag of tags) {
    if (tagMap.has(tag.name)) {
      return fail(`Duplicate tag: ${tag.name}`);
    }
    tagMap.set(tag.name, tag.value);
  }

  // Validate each tag exists and has correct format/value
  const appName = tagMap.get("App-Name");
  if (appName !== "agentsystems-notary") {
    return fail(`Invalid or missing App-Name tag: expected "agentsystems-notary", got "${appName}"`);
  }

  const contentType = tagMap.get("Content-Type");
  if (contentType !== "application/json") {
    return fail(`Invalid or missing Content-Type tag: expected "application/json", got "${contentType}"`);
  }

  const hashTag = tagMap.get("Hash");
  if (!hashTag || !SHA256_HEX.test(hashTag)) {
    return fail(`Invalid or missing Hash tag: must be 64 lowercase hex chars`);
  }

  const namespaceTag = tagMap.get("Namespace");
  if (!namespaceTag || !NAMESPACE.test(namespaceTag)) {
    return fail(`Invalid or missing Namespace tag: must be a SHA-256 hash (64 lowercase hex chars)`);
  }

  const sessionIdTag = tagMap.get("Session-ID");
  if (!sessionIdTag || !UUID.test(sessionIdTag)) {
    return fail(`Invalid or missing Session-ID tag: must be a valid UUID`);
  }

  const sequenceTag = tagMap.get("Sequence");
  if (!sequenceTag || !NON_NEGATIVE_INT.test(sequenceTag)) {
    return fail(`Invalid or missing Sequence tag: must be a non-negative integer`);
  }

  const notarizedAtTag = tagMap.get("Notarized-At");
  if (!notarizedAtTag || !ISO8601.test(notarizedAtTag)) {
    return fail(`Invalid or missing Notarized-At tag: must be ISO-8601 with timezone`);
  }

  const notarizedDateTag = tagMap.get("Notarized-Date-UTC");
  if (!notarizedDateTag || !DATE_UTC.test(notarizedDateTag)) {
    return fail(`Invalid or missing Notarized-Date-UTC tag: must be YYYY-MM-DD`);
  }

  const sdkVersionTag = tagMap.get("SDK-Version");
  if (!sdkVersionTag || !SEMVER.test(sdkVersionTag)) {
    return fail(`Invalid or missing SDK-Version tag: must be valid semver`);
  }

  // Minimum SDK version
  const parsedVersion = parseSemver(sdkVersionTag);
  if (!parsedVersion || !semverGte(parsedVersion, MIN_SDK_VERSION)) {
    return fail(`SDK-Version ${sdkVersionTag} is below minimum ${MIN_SDK_VERSION.join(".")}`);
  }

  // Notarized-Date-UTC must be consistent with Notarized-At
  const dateFromTimestamp = notarizedAtTag.slice(0, 10);
  if (notarizedDateTag !== dateFromTimestamp) {
    return fail(`Notarized-Date-UTC (${notarizedDateTag}) does not match date in Notarized-At (${dateFromTimestamp})`);
  }

  // Parse and validate JSON body
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawData.toString("utf-8"));
  } catch {
    return fail("Data payload is not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("Data payload must be a JSON object");
  }

  // Exact field count — no extra fields allowed
  const bodyKeys = Object.keys(parsed);
  if (bodyKeys.length !== EXPECTED_BODY_FIELD_COUNT) {
    return fail(`Expected exactly ${EXPECTED_BODY_FIELD_COUNT} fields in body, got ${bodyKeys.length}`);
  }

  // Validate each body field exists, is a string, and has correct format
  const { hash, namespace, notarized_at, sdk_version, v } = parsed as Record<string, unknown>;

  if (typeof hash !== "string" || !SHA256_HEX.test(hash)) {
    return fail(`Invalid or missing body field "hash": must be 64 lowercase hex chars`);
  }

  if (typeof namespace !== "string" || !NAMESPACE.test(namespace)) {
    return fail(`Invalid or missing body field "namespace": must be a SHA-256 hash (64 lowercase hex chars)`);
  }

  if (typeof notarized_at !== "string" || !ISO8601.test(notarized_at)) {
    return fail(`Invalid or missing body field "notarized_at": must be ISO-8601 with timezone`);
  }

  if (typeof sdk_version !== "string" || !SEMVER.test(sdk_version)) {
    return fail(`Invalid or missing body field "sdk_version": must be valid semver`);
  }

  if (v !== "1") {
    return fail(`Invalid or missing body field "v": must be "1"`);
  }

  // Cross-validate tags against body — values must match exactly
  if (hashTag !== hash) {
    return fail(`Hash tag ("${hashTag}") does not match body hash ("${hash}")`);
  }

  if (namespaceTag !== namespace) {
    return fail(`Namespace tag ("${namespaceTag}") does not match body namespace ("${namespace}")`);
  }

  if (notarizedAtTag !== notarized_at) {
    return fail(`Notarized-At tag ("${notarizedAtTag}") does not match body notarized_at ("${notarized_at}")`);
  }

  if (sdkVersionTag !== sdk_version) {
    return fail(`SDK-Version tag ("${sdkVersionTag}") does not match body sdk_version ("${sdk_version}")`);
  }

  return { valid: true };
}
