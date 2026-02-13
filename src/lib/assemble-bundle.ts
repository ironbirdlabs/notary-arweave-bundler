import { longTo32ByteArray } from "@dha-team/arbundles";
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
