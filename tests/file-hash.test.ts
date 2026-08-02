import { describe, expect, it } from "@jest/globals";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mapWithConcurrency, sha256File } from "../src/fileHash.js";

describe("bounded-memory file hashing", () => {
  it("matches SHA-256 across multiple asynchronous read chunks", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "svn-agent-hash-"));
    const file = path.join(directory, "large.bin");
    try {
      const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a);
      fs.writeFileSync(file, bytes);
      await expect(sha256File(file)).resolves.toBe(createHash("sha256").update(bytes).digest("hex"));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("honors cancellation before reading a file", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "svn-agent-hash-cancel-"));
    const file = path.join(directory, "cancel.bin");
    const controller = new AbortController();
    try {
      fs.writeFileSync(file, Buffer.alloc(1024, 0x5a));
      controller.abort();
      await expect(sha256File(file, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds concurrent asynchronous work", async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency(
      Array.from({ length: 20 }, (_, index) => index),
      4,
      async (value) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return value * 2;
      }
    );

    expect(peak).toBeLessThanOrEqual(4);
    expect(results).toEqual(Array.from({ length: 20 }, (_, index) => index * 2));
  });
});
