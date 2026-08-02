import { createHash } from "node:crypto";
import fs from "node:fs";

const HASH_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_HASH_CONCURRENCY = 4;
const DEFAULT_HASH_AGGREGATE_BYTES = 1024 * 1024 * 1024;

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

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive safe integer");
  }
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function configuredHashConcurrency(value = process.env.SVN_MCP_HASH_CONCURRENCY): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 32
    ? parsed
    : DEFAULT_HASH_CONCURRENCY;
}

export function configuredHashAggregateBytes(value = process.env.SVN_MCP_MAX_HASH_BYTES): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed >= 1024 * 1024
    ? parsed
    : DEFAULT_HASH_AGGREGATE_BYTES;
}

export async function regularFileBytesWithinBudget(
  paths: readonly string[],
  signal?: AbortSignal,
  maxBytes = configuredHashAggregateBytes()
): Promise<{ ok: true; bytes: number } | { ok: false; bytes: number; maxBytes: number }> {
  const sizes = await mapWithConcurrency(paths, Math.min(16, configuredHashConcurrency() * 2), async (filePath) => {
    signal?.throwIfAborted();
    try {
      const stat = await fs.promises.stat(filePath);
      return stat.isFile() ? stat.size : 0;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      return 0;
    }
  });
  let bytes = 0;
  for (const size of sizes) {
    bytes += size;
    if (!Number.isSafeInteger(bytes) || bytes > maxBytes) {
      return { ok: false, bytes, maxBytes };
    }
  }
  return { ok: true, bytes };
}
