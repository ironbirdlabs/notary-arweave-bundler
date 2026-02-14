#!/usr/bin/env node
// Crafts a valid ANS-104 DataItem and sends it to the bundler endpoint.
// Usage: node test-endpoint.js <endpoint-url> [api-key]

const crypto = require("crypto");
const https = require("https");

const ENDPOINT = process.argv[2];
const API_KEY = process.argv[3];

if (!ENDPOINT) {
  console.error("Usage: node test-endpoint.js <endpoint-url> [api-key]");
  process.exit(1);
}

// --- Avro encoding ---

function zigzagEncode(n) {
  return (n << 1) ^ (n >> 31);
}

function encodeVarint(n) {
  const bytes = [];
  let v = zigzagEncode(n);
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return Buffer.from(bytes);
}

function encodeAvroTags(tags) {
  const parts = [];
  // block count (positive = number of items)
  parts.push(encodeVarint(tags.length));
  for (const { name, value } of tags) {
    const nb = Buffer.from(name, "utf8");
    const vb = Buffer.from(value, "utf8");
    parts.push(encodeVarint(nb.length));
    parts.push(nb);
    parts.push(encodeVarint(vb.length));
    parts.push(vb);
  }
  // terminating zero block
  parts.push(encodeVarint(0));
  return Buffer.concat(parts);
}

// --- Deep hash (Arweave) ---

function sha384(data) {
  return crypto.createHash("sha384").update(data).digest();
}

function strToUtf8(s) {
  return Buffer.from(s, "utf8");
}

function concatBuffers(a, b) {
  const c = new Uint8Array(a.length + b.length);
  c.set(a, 0);
  c.set(b, a.length);
  return c;
}

function deepHash(data) {
  if (data instanceof Uint8Array) {
    const tag = sha384(strToUtf8("blob" + data.byteLength));
    const dataHash = sha384(data);
    return sha384(concatBuffers(tag, dataHash));
  }
  const tag = strToUtf8("list" + data.length);
  let acc = sha384(tag);
  for (const chunk of data) {
    const chunkHash = deepHash(chunk);
    acc = sha384(concatBuffers(acc, chunkHash));
  }
  return acc;
}

// --- Build and send ---

async function main() {
  console.log("Generating RSA-4096 key pair (this takes a moment)...");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 4096,
  });

  // Extract modulus (owner) as raw 512-byte buffer
  const jwk = publicKey.export({ format: "jwk" });
  const owner = Buffer.from(jwk.n, "base64url"); // 512 bytes

  // Build tags and data
  const now = new Date();
  const hash = crypto.randomBytes(32).toString("hex");
  const namespace = crypto.randomBytes(32).toString("hex");
  const sessionId = crypto.randomUUID();
  const notarizedAt = now.toISOString().replace(/Z$/, "+00:00").replace(/(\.\d{3})\d*/, "$1");
  const dateUtc = now.toISOString().slice(0, 10);
  const sdkVersion = "0.2.0";

  const tags = [
    { name: "App-Name", value: "agentsystems-notary" },
    { name: "Content-Type", value: "application/json" },
    { name: "Hash", value: hash },
    { name: "Namespace", value: namespace },
    { name: "Session-ID", value: sessionId },
    { name: "Sequence", value: "0" },
    { name: "Notarized-At", value: notarizedAt },
    { name: "Notarized-Date-UTC", value: dateUtc },
    { name: "SDK-Version", value: sdkVersion },
  ];

  const dataPayload = JSON.stringify({
    v: "1",
    hash,
    namespace,
    notarized_at: notarizedAt,
    sdk_version: sdkVersion,
  });

  const tagBytes = encodeAvroTags(tags);
  const dataBuffer = Buffer.from(dataPayload, "utf8");

  // Compute deep hash for signing
  const signatureInput = [
    strToUtf8("dataitem"),
    strToUtf8("1"),
    strToUtf8("1"),
    owner,
    new Uint8Array(0), // no target
    new Uint8Array(0), // no anchor
    tagBytes,
    dataBuffer,
  ];
  const hash384 = deepHash(signatureInput);

  // Sign with RSA-PSS SHA-256
  const signature = crypto.sign("sha256", hash384, {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
  });

  // Assemble binary DataItem
  const parts = [];

  // Signature type: 1 (LE 2 bytes)
  const sigType = Buffer.alloc(2);
  sigType.writeUInt16LE(1);
  parts.push(sigType);

  // Signature (512 bytes)
  parts.push(signature);

  // Owner (512 bytes)
  parts.push(owner);

  // Target flag: 0
  parts.push(Buffer.from([0]));

  // Anchor flag: 0
  parts.push(Buffer.from([0]));

  // Tag count (8 bytes LE)
  const tagCount = Buffer.alloc(8);
  tagCount.writeBigUInt64LE(BigInt(tags.length));
  parts.push(tagCount);

  // Tag bytes length (8 bytes LE)
  const tagBytesLen = Buffer.alloc(8);
  tagBytesLen.writeBigUInt64LE(BigInt(tagBytes.length));
  parts.push(tagBytesLen);

  // Tags
  parts.push(tagBytes);

  // Data
  parts.push(dataBuffer);

  const dataItem = Buffer.concat(parts);
  const id = crypto.createHash("sha256").update(signature).digest().toString("base64url");

  console.log(`DataItem size: ${dataItem.length} bytes`);
  console.log(`DataItem ID: ${id}`);
  console.log(`Sending to ${ENDPOINT}...`);

  // Send via HTTPS
  const url = new URL(ENDPOINT);
  const headers = { "Content-Type": "application/octet-stream" };
  if (API_KEY) headers["x-api-key"] = API_KEY;

  const req = https.request(
    { hostname: url.hostname, path: url.pathname, method: "POST", headers },
    (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        console.log(`Status: ${res.statusCode}`);
        console.log(`Response: ${body}`);
      });
    }
  );
  req.write(dataItem);
  req.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
