import { createHash } from "node:crypto";
import fs from "node:fs";

const HASH_BUFFER_BYTES = 1024 * 1024;

export async function sha256File(filePath: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath, {
    highWaterMark: HASH_BUFFER_BYTES,
    ...(signal ? { signal } : {})
  });
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}
