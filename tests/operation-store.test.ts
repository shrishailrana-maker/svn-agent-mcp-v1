import { describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEnvelope } from "../src/envelope.js";
import {
  DurableOperationStore,
  stableOperationFingerprint,
  withDurableOperation
} from "../src/operationStore.js";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";

describe("durable operation receipts", () => {
  it("replays a completed receipt after a process-store restart", async () => {
    const directory = temporaryDirectory();
    try {
      let now = Date.parse("2026-08-02T10:00:00Z");
      const options = { directory, now: () => now, staleAfterMs: 60_000 };
      const firstStore = new DurableOperationStore(options);
      const fingerprint = stableOperationFingerprint({ paths: ["a.txt"], revision: "42" });
      const started = firstStore.begin({ operationId: OPERATION_ID, kind: "svn_update", fingerprint });
      expect(started.status).toBe("execute");
      if (started.status !== "execute") throw new Error("expected execute");
      const result = createEnvelope({ ok: true, command: "svn update", cwd: directory, revision: 42 });
      firstStore.settle(started, result);

      now += 1_000;
      const restarted = new DurableOperationStore(options);
      const replay = restarted.begin({ operationId: OPERATION_ID, kind: "svn_update", fingerprint });
      expect(replay).toMatchObject({ status: "replay", state: "completed", result: { ok: true, revision: 42 } });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses mismatched reuse and reports concurrent or stale work distinctly", () => {
    const directory = temporaryDirectory();
    try {
      let now = 1_000;
      const store = new DurableOperationStore({ directory, now: () => now, staleAfterMs: 500 });
      const fingerprint = stableOperationFingerprint({ paths: ["a.txt"] });
      expect(store.begin({ operationId: OPERATION_ID, kind: "svn_commit", fingerprint }).status).toBe("execute");
      expect(store.begin({
        operationId: OPERATION_ID,
        kind: "svn_commit",
        fingerprint: stableOperationFingerprint({ paths: ["b.txt"] })
      }).status).toBe("conflict");
      expect(store.begin({ operationId: OPERATION_ID, kind: "svn_commit", fingerprint }).status).toBe("in_progress");
      now += 501;
      expect(store.begin({ operationId: OPERATION_ID, kind: "svn_commit", fingerprint })).toMatchObject({
        status: "stale",
        createdAt: 1_000
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("executes once, replays failures, and rejects an in-progress concurrent retry", async () => {
    const directory = temporaryDirectory();
    try {
      const store = new DurableOperationStore({ directory });
      const fingerprint = stableOperationFingerprint({ path: "a.txt", target: "crlf" });
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      let executions = 0;
      const firstPromise = withDurableOperation({
        operationId: OPERATION_ID,
        kind: "eol_fix_verified",
        fingerprint,
        command: "eol_fix_verified",
        cwd: directory,
        store,
        execute: async () => {
          executions += 1;
          await blocked;
          return createEnvelope({ ok: false, command: "eol_fix_verified", cwd: directory, note: "fixture failure" });
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const concurrent = await withDurableOperation({
        operationId: OPERATION_ID,
        kind: "eol_fix_verified",
        fingerprint,
        command: "eol_fix_verified",
        cwd: directory,
        store,
        execute: async () => createEnvelope({ ok: true, command: "unexpected", cwd: directory })
      });
      expect(concurrent).toMatchObject({ ok: false, code: "OPERATION_IN_PROGRESS" });
      release();
      const first = await firstPromise;
      expect(first).toMatchObject({ ok: false, operation_id: OPERATION_ID });

      const replay = await withDurableOperation({
        operationId: OPERATION_ID,
        kind: "eol_fix_verified",
        fingerprint,
        command: "eol_fix_verified",
        cwd: directory,
        store,
        execute: async () => createEnvelope({ ok: true, command: "unexpected", cwd: directory })
      });
      expect(replay).toMatchObject({ ok: false, operation_id: OPERATION_ID, idempotent_replay: true });
      expect(executions).toBe(1);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers a stale operation once and persists the recovered receipt", async () => {
    const directory = temporaryDirectory();
    try {
      let now = 10_000;
      const store = new DurableOperationStore({ directory, now: () => now, staleAfterMs: 100 });
      const fingerprint = stableOperationFingerprint({ paths: ["a.txt"], messageHash: "abc" });
      expect(store.begin({ operationId: OPERATION_ID, kind: "svn_commit", fingerprint }).status).toBe("execute");
      now += 101;
      const recovered = await withDurableOperation({
        operationId: OPERATION_ID,
        kind: "svn_commit",
        fingerprint,
        command: "svn commit",
        cwd: directory,
        store,
        execute: async () => createEnvelope({ ok: false, command: "must not run", cwd: directory }),
        recoverStale: async ({ createdAt }) => ({
          ...createEnvelope({ ok: true, command: "svn commit (recovered)", cwd: directory, revision: 77 }),
          recovered_from_created_at: createdAt
        })
      });
      expect(recovered).toMatchObject({
        ok: true,
        revision: 77,
        operation_id: OPERATION_ID,
        operation_recovered: true
      });
      const replay = store.begin({ operationId: OPERATION_ID, kind: "svn_commit", fingerprint });
      expect(replay).toMatchObject({ status: "replay", result: { revision: 77 } });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses to execute when an existing receipt is unreadable", () => {
    const directory = temporaryDirectory();
    try {
      fs.writeFileSync(path.join(directory, `${OPERATION_ID}.json`), "{not-json", "utf8");
      const store = new DurableOperationStore({ directory });
      const started = store.begin({
        operationId: OPERATION_ID,
        kind: "svn_update",
        fingerprint: stableOperationFingerprint({ paths: ["a.txt"] })
      });

      expect(started).toMatchObject({
        status: "conflict",
        note: "operation receipt is unreadable; refusing retry"
      });
      expect(fs.readFileSync(path.join(directory, `${OPERATION_ID}.json`), "utf8")).toBe("{not-json");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never removes unfinished receipts during retention cleanup", () => {
    const directory = temporaryDirectory();
    try {
      let now = 1_000;
      const firstId = "11111111-1111-4111-8111-111111111111";
      const secondId = "22222222-2222-4222-8222-222222222222";
      const store = new DurableOperationStore({
        directory,
        now: () => now,
        ttlMs: 10,
        maxRecords: 10,
        maxBytes: 100_000
      });
      const fingerprint = stableOperationFingerprint({ paths: ["a.txt"] });
      expect(store.begin({ operationId: firstId, kind: "svn_commit", fingerprint }).status).toBe("execute");
      now += 100;
      expect(store.begin({ operationId: secondId, kind: "svn_update", fingerprint }).status).toBe("execute");

      expect(fs.existsSync(path.join(directory, `${firstId}.json`))).toBe(true);
      expect(store.begin({ operationId: firstId, kind: "svn_commit", fingerprint }).status).toBe("in_progress");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes an abandoned receipt lock before beginning after restart", () => {
    const directory = temporaryDirectory();
    try {
      const lock = path.join(directory, `${OPERATION_ID}.lock`);
      fs.writeFileSync(lock, "abandoned", "utf8");
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(lock, old, old);

      const store = new DurableOperationStore({ directory, lockStaleMs: 1_000 });
      expect(store.begin({
        operationId: OPERATION_ID,
        kind: "svn_update",
        fingerprint: stableOperationFingerprint({ paths: ["a.txt"] })
      }).status).toBe("execute");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns a typed failure when the receipt store remains locked", async () => {
    const directory = temporaryDirectory();
    try {
      fs.writeFileSync(path.join(directory, `${OPERATION_ID}.lock`), "active", "utf8");
      const store = new DurableOperationStore({ directory, lockWaitMs: 1, lockStaleMs: 60_000 });
      const result = await withDurableOperation({
        operationId: OPERATION_ID,
        kind: "svn_update",
        fingerprint: stableOperationFingerprint({ paths: ["a.txt"] }),
        command: "svn update",
        cwd: directory,
        store,
        execute: async () => createEnvelope({ ok: true, command: "must not run", cwd: directory })
      });

      expect(result).toMatchObject({
        ok: false,
        code: "OPERATION_STORE_FAILED",
        operation_id: OPERATION_ID,
        note: "operation receipt store unavailable: operation receipt lock is busy"
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a new operation when unfinished receipts consume store capacity", () => {
    const directory = temporaryDirectory();
    try {
      const store = new DurableOperationStore({ directory, maxRecords: 1 });
      const fingerprint = stableOperationFingerprint({ paths: ["a.txt"] });
      expect(store.begin({ operationId: OPERATION_ID, kind: "svn_commit", fingerprint }).status).toBe("execute");

      expect(store.begin({
        operationId: "22222222-2222-4222-8222-222222222222",
        kind: "svn_update",
        fingerprint
      })).toMatchObject({
        status: "conflict",
        note: "operation receipt capacity is exhausted by retained records"
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("prunes a terminal receipt to admit a new operation at the record cap", () => {
    const directory = temporaryDirectory();
    try {
      const store = new DurableOperationStore({ directory, maxRecords: 1 });
      const fingerprint = stableOperationFingerprint({ paths: ["a.txt"] });
      const first = store.begin({ operationId: OPERATION_ID, kind: "svn_update", fingerprint });
      expect(first.status).toBe("execute");
      if (first.status !== "execute") throw new Error("expected execute");
      store.settle(first, createEnvelope({ ok: true, command: "svn update", cwd: directory, revision: 1 }));

      expect(store.begin({
        operationId: "22222222-2222-4222-8222-222222222222",
        kind: "svn_update",
        fingerprint
      }).status).toBe("execute");
      expect(fs.existsSync(path.join(directory, `${OPERATION_ID}.json`))).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("compacts settlement so the complete store remains inside its byte cap", () => {
    const directory = temporaryDirectory();
    try {
      const maxBytes = 40_000;
      const store = new DurableOperationStore({ directory, maxRecords: 2, maxBytes });
      const fingerprint = stableOperationFingerprint({ paths: ["a.txt"] });
      const started = store.begin({ operationId: OPERATION_ID, kind: "svn_update", fingerprint });
      expect(started.status).toBe("execute");
      if (started.status !== "execute") throw new Error("expected execute");
      store.settle(started, {
        ...createEnvelope({ ok: true, command: "svn update", cwd: directory, revision: 1 }),
        changed_paths: Array.from({ length: 5_000 }, (_, index) => ({ status: "U", path: `src/file-${index}.txt` }))
      });

      const totalBytes = fs.readdirSync(directory)
        .map((name) => fs.statSync(path.join(directory, name)).size)
        .reduce((sum, size) => sum + size, 0);
      expect(totalBytes).toBeLessThanOrEqual(maxBytes);
      expect(store.begin({ operationId: OPERATION_ID, kind: "svn_update", fingerprint })).toMatchObject({
        status: "replay",
        result: { ok: true, truncated: true }
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes stale orphan lock and temporary files during cleanup", () => {
    const directory = temporaryDirectory();
    try {
      const orphanLock = path.join(directory, "22222222-2222-4222-8222-222222222222.lock");
      const orphanTemp = path.join(directory, ".22222222-2222-4222-8222-222222222222.33333333-3333-4333-8333-333333333333.tmp");
      fs.writeFileSync(orphanLock, "orphan", "utf8");
      fs.writeFileSync(orphanTemp, "orphan", "utf8");
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(orphanLock, old, old);
      fs.utimesSync(orphanTemp, old, old);

      const store = new DurableOperationStore({ directory, lockStaleMs: 1_000 });
      expect(store.begin({
        operationId: OPERATION_ID,
        kind: "svn_update",
        fingerprint: stableOperationFingerprint({ paths: ["a.txt"] })
      }).status).toBe("execute");
      expect(fs.existsSync(orphanLock)).toBe(false);
      expect(fs.existsSync(orphanTemp)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses an operation store located inside a working copy", async () => {
    const root = temporaryDirectory();
    try {
      fs.mkdirSync(path.join(root, ".svn"));
      const directory = path.join(root, "local-operation-receipts");
      const store = new DurableOperationStore({ directory });
      let executed = false;
      const result = await withDurableOperation({
        operationId: OPERATION_ID,
        kind: "svn_update",
        fingerprint: stableOperationFingerprint({ paths: ["a.txt"] }),
        command: "svn update",
        cwd: root,
        store,
        execute: async () => {
          executed = true;
          return createEnvelope({ ok: true, command: "must not run", cwd: root });
        }
      });

      expect(result).toMatchObject({
        ok: false,
        code: "OPERATION_STORE_FAILED",
        note: "operation receipt store must be outside every SVN working copy"
      });
      expect(executed).toBe(false);
      expect(fs.existsSync(directory)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to replay a malformed terminal envelope", () => {
    const directory = temporaryDirectory();
    try {
      const fingerprint = stableOperationFingerprint({ paths: ["a.txt"] });
      fs.writeFileSync(path.join(directory, `${OPERATION_ID}.json`), JSON.stringify({
        schema: 1,
        operationId: OPERATION_ID,
        kind: "svn_update",
        fingerprint,
        state: "completed",
        lease: "lease",
        createdAt: 1,
        updatedAt: 2,
        result: {}
      }), "utf8");
      const store = new DurableOperationStore({ directory });

      expect(store.begin({ operationId: OPERATION_ID, kind: "svn_update", fingerprint })).toMatchObject({
        status: "conflict",
        note: "operation receipt is incomplete"
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses malformed path and conflict items inside a terminal envelope", () => {
    const directory = temporaryDirectory();
    try {
      const fingerprint = stableOperationFingerprint({ paths: ["a.txt"] });
      const malformed = createEnvelope({ ok: true, command: "svn update", cwd: directory });
      (malformed.changed_paths as unknown[]) = [null];
      (malformed.conflicts as unknown[]) = [{ path: 12, type: "text" }];
      fs.writeFileSync(path.join(directory, `${OPERATION_ID}.json`), JSON.stringify({
        schema: 1,
        operationId: OPERATION_ID,
        kind: "svn_update",
        fingerprint,
        state: "completed",
        lease: "lease",
        createdAt: 1,
        updatedAt: 2,
        result: malformed
      }), "utf8");
      const store = new DurableOperationStore({ directory });

      expect(store.begin({ operationId: OPERATION_ID, kind: "svn_update", fingerprint })).toMatchObject({
        status: "conflict",
        note: "operation receipt is incomplete"
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "svn-agent-operations-"));
}
