import crypto from "crypto";
import { SIG_OFFSET, SIG_LENGTH } from "./data-item";

export function assembleBundle(dataItems: Buffer[]): Buffer {
  const headerBuffers: Buffer[] = [];

  // 32-byte item count (little-endian)
  headerBuffers.push(Buffer.from(longTo32ByteArray(dataItems.length)));

  // Index: 32-byte size + 32-byte ID per item
  for (const item of dataItems) {
    const signature = item.subarray(SIG_OFFSET, SIG_OFFSET + SIG_LENGTH);
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
