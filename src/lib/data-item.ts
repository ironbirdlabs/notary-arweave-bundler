import crypto from "crypto";

export type Tag = { name: string; value: string };

export interface ParsedDataItem {
  id: string;
  signatureType: number;
  owner: string;
  target: string | undefined;
  anchor: string | undefined;
  tags: Tag[];
  rawData: Buffer;
  isValid: () => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Binary parsing for ANS-104 signature type 1 (Arweave RSA-4096)
// ---------------------------------------------------------------------------

// Layout (type 1):
//   [0-1]       Signature type  (2 bytes LE, must be 1)
//   [2-513]     Signature       (512 bytes)
//   [514-1025]  Owner modulus   (512 bytes)
//   [1026]      Target flag     (1 byte, 0 or 1)
//   [+0|+32]    Target          (32 bytes if flag=1)
//   [next]      Anchor flag     (1 byte, 0 or 1)
//   [+0|+32]    Anchor          (32 bytes if flag=1)
//   [next 8]    Tag count       (8 bytes LE)
//   [next 8]    Tag bytes len   (8 bytes LE)
//   [next N]    Tags (Avro)     (N = tag bytes length)
//   [rest]      Data payload

const SIG_TYPE_OFFSET = 0;
export const SIG_OFFSET = 2;
export const SIG_LENGTH = 512;
const OWNER_OFFSET = SIG_OFFSET + SIG_LENGTH; // 514
const OWNER_LENGTH = 512;
const FLAGS_START = OWNER_OFFSET + OWNER_LENGTH; // 1026

export function parseDataItem(buffer: Buffer): ParsedDataItem {
  const sigType = buffer.readUInt16LE(SIG_TYPE_OFFSET);
  if (sigType !== 1) {
    throw new Error(`Unsupported signature type: ${sigType}, only type 1 (Arweave RSA-4096) is supported`);
  }

  const signature = buffer.subarray(SIG_OFFSET, SIG_OFFSET + SIG_LENGTH);
  const owner = buffer.subarray(OWNER_OFFSET, OWNER_OFFSET + OWNER_LENGTH);

  let offset = FLAGS_START;

  // Target
  const targetFlag = buffer[offset++];
  let target: Buffer | undefined;
  if (targetFlag === 1) {
    target = buffer.subarray(offset, offset + 32);
    offset += 32;
  }

  // Anchor
  const anchorFlag = buffer[offset++];
  let anchor: Buffer | undefined;
  if (anchorFlag === 1) {
    anchor = buffer.subarray(offset, offset + 32);
    offset += 32;
  }

  // Tags
  const tagCount = Number(buffer.readBigUInt64LE(offset));
  offset += 8;
  const tagBytesLength = Number(buffer.readBigUInt64LE(offset));
  offset += 8;

  const tagBytes = buffer.subarray(offset, offset + tagBytesLength);
  const tags = tagBytesLength > 0 ? decodeAvroTags(tagBytes) : [];
  if (tags.length !== tagCount) {
    throw new Error(`Tag count mismatch: header says ${tagCount}, Avro decoded ${tags.length}`);
  }
  offset += tagBytesLength;

  // Data payload
  const data = buffer.subarray(offset);

  // ID = base64url(SHA-256(signature))
  const id = crypto.createHash("sha256").update(signature).digest("base64url");

  // Owner as base64url (the standard Arweave representation)
  const ownerB64 = bufferToBase64url(owner);

  return {
    id,
    signatureType: sigType,
    owner: ownerB64,
    target: target ? bufferToBase64url(target) : undefined,
    anchor: anchor ? anchor.toString("utf-8").replace(/\0+$/, "") || undefined : undefined,
    tags,
    rawData: data,
    isValid: () => verifyDataItem(signature, owner, target, anchor, tagBytes, data),
  };
}

// ---------------------------------------------------------------------------
// Avro tag decoding
// ---------------------------------------------------------------------------

function decodeAvroTags(buf: Buffer): Tag[] {
  const tags: Tag[] = [];
  let offset = 0;

  while (offset < buf.length) {
    // Read block count (zigzag varint)
    const [blockCount, bytesRead] = readZigzagVarint(buf, offset);
    offset += bytesRead;
    if (blockCount === 0) break;

    const count = Math.abs(blockCount);
    // If block count is negative, next varint is byte size of block (skip it)
    if (blockCount < 0) {
      const [, skip] = readZigzagVarint(buf, offset);
      offset += skip;
    }

    for (let i = 0; i < count; i++) {
      const [nameLen, nBytes] = readZigzagVarint(buf, offset);
      offset += nBytes;
      const name = buf.subarray(offset, offset + nameLen).toString("utf-8");
      offset += nameLen;

      const [valueLen, vBytes] = readZigzagVarint(buf, offset);
      offset += vBytes;
      const value = buf.subarray(offset, offset + valueLen).toString("utf-8");
      offset += valueLen;

      tags.push({ name, value });
    }
  }

  return tags;
}

function readZigzagVarint(buf: Buffer, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = offset;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }

  // Zigzag decode: (n >>> 1) ^ -(n & 1)
  return [(result >>> 1) ^ -(result & 1), pos - offset];
}

// ---------------------------------------------------------------------------
// Deep hash (SHA-384)
// ---------------------------------------------------------------------------

type DeepHashChunk = Uint8Array | DeepHashChunk[];

async function deepHash(data: DeepHashChunk): Promise<Uint8Array> {
  if (data instanceof Uint8Array) {
    const tag = concatBuffers(
      strToUtf8("blob"),
      strToUtf8(data.byteLength.toString()),
    );
    const tagHash = sha384(tag);
    const dataHash = sha384(data);
    return sha384(concatBuffers(tagHash, dataHash));
  }

  const tag = concatBuffers(
    strToUtf8("list"),
    strToUtf8(data.length.toString()),
  );
  let acc = sha384(tag);
  for (const chunk of data) {
    const chunkHash = await deepHash(chunk);
    acc = sha384(concatBuffers(acc, chunkHash));
  }
  return acc;
}

function sha384(data: Uint8Array): Uint8Array {
  return crypto.createHash("sha-384").update(data).digest();
}

function strToUtf8(s: string): Uint8Array {
  return Buffer.from(s, "utf-8");
}

function concatBuffers(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.byteLength + b.byteLength);
  result.set(a, 0);
  result.set(b, a.byteLength);
  return result;
}

// ---------------------------------------------------------------------------
// RSA-PSS verification
// ---------------------------------------------------------------------------

async function verifyDataItem(
  signature: Buffer,
  owner: Buffer,
  target: Buffer | undefined,
  anchor: Buffer | undefined,
  tagBytes: Buffer,
  data: Buffer,
): Promise<boolean> {
  // Build the deep hash input:
  // ["dataitem", "1", "1", owner, target, anchor, tags, data]
  const signatureData = await deepHash([
    strToUtf8("dataitem"),
    strToUtf8("1"),      // format version (always "1")
    strToUtf8("1"),      // signatureType.toString() (1 = RSA-4096 PSS)
    owner,
    target ?? new Uint8Array(0),
    anchor ?? new Uint8Array(0),
    tagBytes,
    data,
  ]);

  // Build RSA public key from owner modulus
  const n = bufferToBase64url(owner);
  const publicKey = crypto.createPublicKey({
    key: { kty: "RSA", e: "AQAB", n },
    format: "jwk",
  });

  return crypto.verify(
    "sha256",
    signatureData,
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    },
    signature,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bufferToBase64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}
