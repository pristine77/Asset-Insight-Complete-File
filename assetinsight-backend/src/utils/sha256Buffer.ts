import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";

export const SHA256_BUFFER_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Hash the exact bytes without passing a multi-GiB Buffer to one native update.
 * Subarrays are zero-copy views. Yield between bounded updates so durable job
 * heartbeat/ownership timers can run while hashing a large original-image ZIP.
 * Chunk boundaries do not change SHA-256 or existing immutable object keys.
 */
export async function sha256Buffer(buffer: Buffer): Promise<string> {
  const hash = createHash("sha256");
  for (let offset = 0; offset < buffer.length; offset += SHA256_BUFFER_CHUNK_BYTES) {
    hash.update(buffer.subarray(offset, Math.min(offset + SHA256_BUFFER_CHUNK_BYTES, buffer.length)));
    if (offset + SHA256_BUFFER_CHUNK_BYTES < buffer.length) await setImmediate();
  }
  return hash.digest("hex");
}
