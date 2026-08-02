import { describe, expect, it } from "@jest/globals";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256File } from "../src/fileHash.js";

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
});
