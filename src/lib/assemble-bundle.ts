import crypto from "crypto";

export function assembleBundle(dataItems: Buffer[]): Buffer {
  const headerBuffers: Buffer[] = [];

  // 32-byte item count (little-endian)
  headerBuffers.push(Buffer.from(longTo32ByteArray(dataItems.length)));

  // Index: 32-byte size + 32-byte ID per item
  for (const item of dataItems) {
    // Signature starts at offset 2 (after 2-byte signature type), 512 bytes for RSA-4096
    const signature = item.subarray(2, 514);
    const id = crypto.createHash("sha256").update(signature).digest();

    headerBuffers.push(Buffer.from(longTo32ByteArray(item.length)));
    headerBuffers.push(id);
  }

  // Concatenate: header + all DataItem binaries
  return Buffer.concat([...headerBuffers, ...dataItems]);
}

function longTo32ByteArray(long: number): Uint8Array {
  const buf = new Uint8Array(32);
  for (let i = 0; i < 8 && long > 0; i++) {
    buf[i] = long & 0xff;
    long = Math.floor(long / 256);
  }
  return buf;
}
