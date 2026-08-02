import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { failEnvelope } from "./envelope.js";
import { realPathOfNearestExisting } from "./guards.js";
import type { ToolEnvelope } from "./types.js";

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 256;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_LOCK_WAIT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const TERMINAL_RECEIPT_RESERVE_BYTES = 16 * 1024;

type StoredState = "in_progress" | "completed" | "failed";

type StoredOperation = {
  schema: 1;
  operationId: string;
  kind: string;
  fingerprint: string;
  state: StoredState;
  lease: string;
  createdAt: number;
  updatedAt: number;
  result?: unknown;
};

export type OperationExecution = {
  status: "execute";
  operationId: string;
  kind: string;
  fingerprint: string;
  lease: string;
  createdAt: number;
};

export type OperationStart = OperationExecution | {
  status: "replay";
  operationId: string;
  state: "completed" | "failed";
  result: ToolEnvelope;
} | {
  status: "conflict" | "in_progress";
  operationId: string;
  note: string;
} | {
  status: "stale";
  operationId: string;
  kind: string;
  fingerprint: string;
  createdAt: number;
  note: string;
};

export class DurableOperationStore {
  readonly directory: string;
  readonly #now: () => number;
  readonly #staleAfterMs: number;
  readonly #ttlMs: number;
  readonly #maxRecords: number;
  readonly #maxBytes: number;
  readonly #lockWaitMs: number;
  readonly #lockStaleMs: number;

  constructor(options: {
    directory?: string;
    now?: () => number;
    staleAfterMs?: number;
    ttlMs?: number;
    maxRecords?: number;
    maxBytes?: number;
    lockWaitMs?: number;
    lockStaleMs?: number;
  } = {}) {
    this.directory = path.resolve(options.directory ?? defaultOperationDirectory());
    this.#now = options.now ?? Date.now;
    this.#staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
    this.#lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  }

  begin(input: { operationId?: string; kind: string; fingerprint: string }): OperationStart {
    const operationId = input.operationId ?? randomUUID();
    if (!OPERATION_ID.test(operationId)) {
      return { status: "conflict", operationId, note: "operationId must be a UUID" };
    }
    this.#ensureDirectory();
    return this.#withFileLock(path.join(this.directory, ".store.lock"), () => {
      this.#cleanup(operationId);
      return this.#withLock(operationId, () => this.#beginLocked(input, operationId));
    });
  }

  async beginAsync(input: { operationId?: string; kind: string; fingerprint: string }): Promise<OperationStart> {
    const operationId = input.operationId ?? randomUUID();
    if (!OPERATION_ID.test(operationId)) {
      return { status: "conflict", operationId, note: "operationId must be a UUID" };
    }
    this.#ensureDirectory();
    return this.#withFileLockAsync(path.join(this.directory, ".store.lock"), async () => {
      this.#cleanup(operationId);
      return this.#withFileLockAsync(
        path.join(this.directory, `${operationId}.lock`),
        () => this.#beginLocked(input, operationId)
      );
    });
  }

  #beginLocked(input: { operationId?: string; kind: string; fingerprint: string }, operationId: string): OperationStart {
    const recordExists = fs.existsSync(this.#recordPath(operationId));
    const existing = this.#read(operationId);
    if (recordExists && !existing) {
      return { status: "conflict", operationId, note: "operation receipt is unreadable; refusing retry" };
    }
    if (existing) {
      if (existing.kind !== input.kind || existing.fingerprint !== input.fingerprint) {
        return { status: "conflict", operationId, note: "operationId is already bound to different inputs" };
      }
      if (existing.state === "completed" || existing.state === "failed") {
        if (!isToolEnvelope(existing.result)) {
          return { status: "conflict", operationId, note: "operation receipt is incomplete" };
        }
        return { status: "replay", operationId, state: existing.state, result: existing.result };
      }
      if (this.#now() - existing.updatedAt > this.#staleAfterMs) {
        return {
          status: "stale",
          operationId,
          kind: existing.kind,
          fingerprint: existing.fingerprint,
          createdAt: existing.createdAt,
          note: "operation receipt is stale after an interrupted execution"
        };
      }
      return { status: "in_progress", operationId, note: "operation is already in progress" };
    }

    const now = this.#now();
    const record: StoredOperation = {
      schema: 1,
      operationId,
      kind: input.kind,
      fingerprint: input.fingerprint,
      state: "in_progress",
      lease: randomUUID(),
      createdAt: now,
      updatedAt: now
    };
    this.#pruneTerminalForCapacity(1, Math.max(TERMINAL_RECEIPT_RESERVE_BYTES, storedBytes(record)), operationId);
    if (!this.#hasCapacityFor(record, operationId)) {
      return { status: "conflict", operationId, note: "operation receipt capacity is exhausted by retained records" };
    }
    this.#write(record);
    return {
      status: "execute",
      operationId,
      kind: input.kind,
      fingerprint: input.fingerprint,
      lease: record.lease,
      createdAt: now
    };
  }

  locationError(): string | null {
    return containingWorkingCopy(realPathOfNearestExisting(this.directory))
      ? "operation receipt store must be outside every SVN working copy"
      : null;
  }

  settle(execution: OperationExecution, result: ToolEnvelope): void {
    this.#withFileLock(path.join(this.directory, ".store.lock"), () => {
      this.#cleanup(execution.operationId);
      this.#withLock(execution.operationId, () => {
      const existing = this.#read(execution.operationId);
      if (!existing || existing.state !== "in_progress" || existing.lease !== execution.lease
          || existing.kind !== execution.kind || existing.fingerprint !== execution.fingerprint) {
        throw new Error("operation lease no longer owns the receipt");
      }
      this.#pruneTerminalForCapacity(0, TERMINAL_RECEIPT_RESERVE_BYTES, execution.operationId);
      this.#write(this.#terminalRecordWithinCapacity(existing, result));
      });
    });
  }

  async settleAsync(execution: OperationExecution, result: ToolEnvelope): Promise<void> {
    await this.#withFileLockAsync(path.join(this.directory, ".store.lock"), async () => {
      this.#cleanup(execution.operationId);
      await this.#withFileLockAsync(path.join(this.directory, `${execution.operationId}.lock`), () => {
        const existing = this.#read(execution.operationId);
        if (!existing || existing.state !== "in_progress" || existing.lease !== execution.lease
            || existing.kind !== execution.kind || existing.fingerprint !== execution.fingerprint) {
          throw new Error("operation lease no longer owns the receipt");
        }
        this.#pruneTerminalForCapacity(0, TERMINAL_RECEIPT_RESERVE_BYTES, execution.operationId);
        this.#write(this.#terminalRecordWithinCapacity(existing, result));
      });
    });
  }

  recover(stale: Extract<OperationStart, { status: "stale" }>, result: ToolEnvelope): void {
    this.#withFileLock(path.join(this.directory, ".store.lock"), () => {
      this.#cleanup(stale.operationId);
      this.#withLock(stale.operationId, () => {
      const existing = this.#read(stale.operationId);
      if (!existing || existing.state !== "in_progress" || existing.kind !== stale.kind
          || existing.fingerprint !== stale.fingerprint || existing.createdAt !== stale.createdAt
          || this.#now() - existing.updatedAt <= this.#staleAfterMs) {
        throw new Error("stale operation receipt changed before recovery");
      }
      this.#pruneTerminalForCapacity(0, TERMINAL_RECEIPT_RESERVE_BYTES, stale.operationId);
      this.#write(this.#terminalRecordWithinCapacity(existing, result));
      });
    });
  }

  async recoverAsync(stale: Extract<OperationStart, { status: "stale" }>, result: ToolEnvelope): Promise<void> {
    await this.#withFileLockAsync(path.join(this.directory, ".store.lock"), async () => {
      this.#cleanup(stale.operationId);
      await this.#withFileLockAsync(path.join(this.directory, `${stale.operationId}.lock`), () => {
        const existing = this.#read(stale.operationId);
        if (!existing || existing.state !== "in_progress" || existing.kind !== stale.kind
            || existing.fingerprint !== stale.fingerprint || existing.createdAt !== stale.createdAt
            || this.#now() - existing.updatedAt <= this.#staleAfterMs) {
          throw new Error("stale operation receipt changed before recovery");
        }
        this.#pruneTerminalForCapacity(0, TERMINAL_RECEIPT_RESERVE_BYTES, stale.operationId);
        this.#write(this.#terminalRecordWithinCapacity(existing, result));
      });
    });
  }

  #ensureDirectory(): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  #recordPath(operationId: string): string {
    return path.join(this.directory, `${operationId}.json`);
  }

  #read(operationId: string): StoredOperation | null {
    try {
      const bytes = readBoundedFile(this.#recordPath(operationId), MAX_RECORD_BYTES);
      if (!bytes) return null;
      const text = bytes.toString("utf8");
      const parsed = JSON.parse(text) as Partial<StoredOperation>;
      if (parsed.schema !== 1 || parsed.operationId !== operationId || typeof parsed.kind !== "string"
          || typeof parsed.fingerprint !== "string" || typeof parsed.lease !== "string"
          || typeof parsed.createdAt !== "number" || typeof parsed.updatedAt !== "number"
          || !["in_progress", "completed", "failed"].includes(String(parsed.state))) {
        return null;
      }
      return parsed as StoredOperation;
    } catch {
      return null;
    }
  }

  #write(record: StoredOperation): void {
    const text = JSON.stringify(record);
    if (Buffer.byteLength(text, "utf8") > MAX_RECORD_BYTES) {
      throw new Error(`operation receipt exceeds ${MAX_RECORD_BYTES} bytes`);
    }
    const temporary = path.join(this.directory, `.${record.operationId}.${randomUUID()}.tmp`);
    fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, this.#recordPath(record.operationId));
  }

  #withLock<T>(operationId: string, action: () => T): T {
    return this.#withFileLock(path.join(this.directory, `${operationId}.lock`), action);
  }

  #withFileLock<T>(lockPath: string, action: () => T): T {
    let descriptor: number | null = null;
    const lockToken = randomUUID();
    const deadline = Date.now() + this.#lockWaitMs;
    while (descriptor === null) {
      try {
        descriptor = fs.openSync(lockPath, "wx", 0o600);
        fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token: lockToken }), "utf8");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (this.#breakAbandonedLock(lockPath)) continue;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(10, remaining));
      }
    }
    if (descriptor === null) throw new Error("operation receipt lock is busy");
    try {
      return action();
    } finally {
      fs.closeSync(descriptor);
      if (lockTokenMatches(lockPath, lockToken)) {
        fs.rmSync(lockPath, { force: true });
      }
    }
  }

  async #withFileLockAsync<T>(lockPath: string, action: () => T | Promise<T>): Promise<T> {
    let descriptor: number | null = null;
    const lockToken = randomUUID();
    const deadline = Date.now() + this.#lockWaitMs;
    while (descriptor === null) {
      try {
        descriptor = fs.openSync(lockPath, "wx", 0o600);
        fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token: lockToken }), "utf8");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (this.#breakAbandonedLock(lockPath)) continue;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(10, remaining)));
      }
    }
    if (descriptor === null) throw new Error("operation receipt lock is busy");
    try {
      return await action();
    } finally {
      fs.closeSync(descriptor);
      if (lockTokenMatches(lockPath, lockToken)) {
        fs.rmSync(lockPath, { force: true });
      }
    }
  }

  #breakAbandonedLock(lockPath: string): boolean {
    const breakerPath = `${lockPath}.break`;
    const breakerToken = randomUUID();
    let breaker: number;
    try {
      breaker = fs.openSync(breakerPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return this.#removeAbandonedBreaker(breakerPath) ? this.#breakAbandonedLock(lockPath) : false;
      }
      throw error;
    }
    try {
      fs.writeFileSync(breaker, JSON.stringify({ pid: process.pid, token: breakerToken }), "utf8");
      let stat: fs.Stats;
      try {
        stat = fs.statSync(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        throw error;
      }
      if (this.#now() - stat.mtimeMs <= this.#lockStaleMs || lockOwnerIsAlive(lockPath)) return false;
      fs.rmSync(lockPath, { force: true });
      return true;
    } finally {
      fs.closeSync(breaker);
      if (lockTokenMatches(breakerPath, breakerToken)) {
        fs.rmSync(breakerPath, { force: true });
      }
    }
  }

  #removeAbandonedBreaker(breakerPath: string): boolean {
    try {
      const stat = fs.statSync(breakerPath);
      if (this.#now() - stat.mtimeMs <= this.#lockStaleMs || lockOwnerIsAlive(breakerPath)) return false;
      fs.rmSync(breakerPath, { force: true });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  }

  #cleanup(preserveOperationId: string): void {
    const now = this.#now();
    for (const name of fs.readdirSync(this.directory)) {
      if (name === ".store.lock") continue;
      if (!isOperationLock(name) && !isOperationTemp(name)) continue;
      const filePath = path.join(this.directory, name);
      try {
        this.#breakAbandonedLock(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    const records = fs.readdirSync(this.directory)
      .filter((name) => OPERATION_ID.test(name.replace(/\.json$/, "")) && name.endsWith(".json"))
      .flatMap((name) => {
        const filePath = path.join(this.directory, name);
        try {
          const stat = fs.statSync(filePath);
          const operationId = name.slice(0, -".json".length);
          const record = this.#read(operationId);
          return [{
            operationId,
            filePath,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            terminal: record?.state !== "in_progress" && record !== null
          }];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
      });
    for (const file of records) {
      if (file.operationId !== preserveOperationId && file.terminal && now - file.mtimeMs > this.#ttlMs) {
        fs.rmSync(file.filePath, { force: true });
      }
    }

    const removable = records
      .filter((file) => file.operationId !== preserveOperationId && file.terminal && fs.existsSync(file.filePath))
      .sort((left, right) => left.mtimeMs - right.mtimeMs);
    while (!this.#withinCapacity() && removable.length > 0) {
      const file = removable.shift();
      if (file) fs.rmSync(file.filePath, { force: true });
    }
  }

  #hasCapacityFor(record: StoredOperation, operationId: string): boolean {
    const usage = this.#storeUsage(new Set([".store.lock", `${operationId}.lock`]));
    const recordBytes = Math.max(TERMINAL_RECEIPT_RESERVE_BYTES, storedBytes(record));
    return usage.count < this.#maxRecords && usage.bytes + recordBytes <= this.#maxBytes;
  }

  #withinCapacity(): boolean {
    const usage = this.#storeUsage(new Set([".store.lock"]));
    return usage.count <= this.#maxRecords && usage.bytes <= this.#maxBytes;
  }

  #storeUsage(excluded: Set<string>): { count: number; bytes: number } {
    let count = 0;
    let bytes = 0;
    for (const name of fs.readdirSync(this.directory)) {
      if (excluded.has(name)) continue;
      const filePath = path.join(this.directory, name);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        count += 1;
        const operationId = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
        const record = operationId && OPERATION_ID.test(operationId) ? this.#read(operationId) : null;
        bytes += record?.state === "in_progress"
          ? Math.max(stat.size, TERMINAL_RECEIPT_RESERVE_BYTES)
          : stat.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return { count, bytes };
  }

  #pruneTerminalForCapacity(additionalCount: number, additionalBytes: number, preserveOperationId: string): void {
    const excluded = new Set([".store.lock", `${preserveOperationId}.lock`]);
    const removable = fs.readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        const operationId = name.slice(0, -".json".length);
        const filePath = path.join(this.directory, name);
        try {
          const record = OPERATION_ID.test(operationId) ? this.#read(operationId) : null;
          return [{
            operationId,
            filePath,
            mtimeMs: fs.statSync(filePath).mtimeMs,
            terminal: record?.state === "completed" || record?.state === "failed"
          }];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
      })
      .filter((item) => item.operationId !== preserveOperationId && item.terminal)
      .sort((left, right) => left.mtimeMs - right.mtimeMs);
    let usage = this.#storeUsage(excluded);
    while ((usage.count + additionalCount > this.#maxRecords || usage.bytes + additionalBytes > this.#maxBytes)
        && removable.length > 0) {
      const candidate = removable.shift();
      if (candidate) fs.rmSync(candidate.filePath, { force: true });
      usage = this.#storeUsage(excluded);
    }
  }

  #terminalRecordWithinCapacity(existing: StoredOperation, result: ToolEnvelope): StoredOperation {
    const excluded = new Set([".store.lock", `${existing.operationId}.lock`, `${existing.operationId}.json`]);
    const otherUsage = this.#storeUsage(excluded);
    const base: StoredOperation = {
      ...existing,
      state: result.ok ? "completed" : "failed",
      updatedAt: this.#now()
    };
    delete base.result;
    const resultBudget = Math.min(
      MAX_RECORD_BYTES - storedBytes(base) - 32,
      this.#maxBytes - otherUsage.bytes - storedBytes(base) - 32
    );
    if (resultBudget <= 0) throw new Error("operation receipt store has no terminal-result capacity");
    const record: StoredOperation = { ...base, result: compactStoredResult(result, resultBudget) };
    if (storedBytes(record) + otherUsage.bytes > this.#maxBytes) {
      throw new Error("operation receipt exceeds total store byte capacity");
    }
    return record;
  }
}

function lockOwnerIsAlive(lockPath: string): boolean {
  try {
    const bytes = readBoundedFile(lockPath, 4096);
    if (!bytes) return false;
    const parsed = JSON.parse(bytes.toString("utf8")) as { pid?: unknown };
    if (!Number.isSafeInteger(parsed.pid) || Number(parsed.pid) <= 0) return false;
    try {
      process.kill(Number(parsed.pid), 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  } catch {
    return false;
  }
}

function lockTokenMatches(lockPath: string, token: string): boolean {
  try {
    const bytes = readBoundedFile(lockPath, 4096);
    if (!bytes) return false;
    const parsed = JSON.parse(bytes.toString("utf8")) as { token?: unknown };
    return parsed.token === token;
  } catch {
    return false;
  }
}

function readBoundedFile(filePath: string, maxBytes: number): Buffer | null {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== bytes.length) return null;
    const extra = Buffer.allocUnsafe(1);
    if (fs.readSync(descriptor, extra, 0, 1, offset) !== 0) return null;
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function stableOperationFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

export async function withDurableOperation(input: {
  operationId: string;
  kind: string;
  fingerprint: string;
  command: string;
  cwd: string;
  execute: () => Promise<ToolEnvelope>;
  recoverStale?: (input: { operationId: string; createdAt: number }) => Promise<ToolEnvelope | null>;
  store?: DurableOperationStore;
}): Promise<ToolEnvelope> {
  const store = input.store ?? processOperationStore();
  const locationError = store.locationError();
  if (locationError) {
    return operationFailure(input.command, input.cwd, "OPERATION_STORE_FAILED", locationError, input.operationId);
  }
  let started: OperationStart;
  try {
    started = await store.beginAsync({ operationId: input.operationId, kind: input.kind, fingerprint: input.fingerprint });
  } catch (error) {
    return operationFailure(
      input.command,
      input.cwd,
      "OPERATION_STORE_FAILED",
      `operation receipt store unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
      input.operationId
    );
  }
  if (started.status === "replay") {
    return { ...started.result, operation_id: started.operationId, idempotent_replay: true };
  }
  if (started.status === "conflict") {
    return operationFailure(input.command, input.cwd, "OPERATION_ID_CONFLICT", started.note, started.operationId);
  }
  if (started.status === "in_progress") {
    return operationFailure(input.command, input.cwd, "OPERATION_IN_PROGRESS", started.note, started.operationId);
  }
  if (started.status === "stale") {
    const recovered = input.recoverStale
      ? await input.recoverStale({ operationId: started.operationId, createdAt: started.createdAt })
      : null;
    if (!recovered) {
      return operationFailure(
        input.command,
        input.cwd,
        "OPERATION_STALE",
        "operation outcome is ambiguous after an interrupted execution; inspect state and use a new operationId",
        started.operationId
      );
    }
    const result = {
      ...recovered,
      operation_id: started.operationId,
      operation_recovered: true
    };
    await store.recoverAsync(started, result);
    return result;
  }
  if (started.status !== "execute") {
    return operationFailure(input.command, input.cwd, "OPERATION_STATE", "operation state is invalid", started.operationId);
  }

  let result: ToolEnvelope;
  try {
    result = { ...await input.execute(), operation_id: started.operationId };
  } catch (error) {
    result = operationFailure(
      input.command,
      input.cwd,
      "OPERATION_EXECUTION_FAILED",
      error instanceof Error ? error.message : "operation execution failed",
      started.operationId
    );
  }
  try {
    await store.settleAsync(started, result);
    return result;
  } catch (error) {
    return {
      ...result,
      operation_receipt_persisted: false,
      note: [result.note, error instanceof Error ? error.message : "operation receipt persistence failed"].filter(Boolean).join("; ")
    };
  }
}

let cachedStore: { directory: string; store: DurableOperationStore } | null = null;

function processOperationStore(): DurableOperationStore {
  const directory = defaultOperationDirectory();
  if (!cachedStore || cachedStore.directory !== directory) {
    cachedStore = { directory, store: new DurableOperationStore({ directory }) };
  }
  return cachedStore.store;
}

function defaultOperationDirectory(): string {
  if (process.env.SVN_MCP_OPERATION_DIR?.trim()) {
    return path.resolve(process.env.SVN_MCP_OPERATION_DIR);
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? os.homedir(), "svn-agent-mcp", "operations");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "svn-agent-mcp", "operations");
  }
  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "svn-agent-mcp", "operations");
}

function containingWorkingCopy(candidate: string): string | null {
  let current = candidate;
  try {
    if (fs.existsSync(current) && !fs.statSync(current).isDirectory()) current = path.dirname(current);
  } catch {
    current = path.dirname(current);
  }
  while (true) {
    if (fs.existsSync(path.join(current, ".svn"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isOperationLock(name: string): boolean {
  return name.endsWith(".lock") && OPERATION_ID.test(name.slice(0, -".lock".length));
}

function isOperationTemp(name: string): boolean {
  return /^\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.tmp$/i.test(name);
}

function isToolEnvelope(value: unknown): value is ToolEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ToolEnvelope>;
  return typeof candidate.ok === "boolean"
    && typeof candidate.command === "string"
    && typeof candidate.cwd === "string"
    && (candidate.revision === null || typeof candidate.revision === "number")
    && Array.isArray(candidate.changed_paths)
    && candidate.changed_paths.every((item) => Boolean(item)
      && typeof item === "object"
      && typeof (item as { status?: unknown }).status === "string"
      && typeof (item as { path?: unknown }).path === "string")
    && Array.isArray(candidate.conflicts)
    && candidate.conflicts.every((item) => Boolean(item)
      && typeof item === "object"
      && typeof (item as { path?: unknown }).path === "string"
      && ["text", "tree", "prop"].includes(String((item as { type?: unknown }).type)))
    && typeof candidate.stdout_summary === "string"
    && typeof candidate.stderr_summary === "string"
    && typeof candidate.truncated === "boolean"
    && typeof candidate.note === "string";
}

function operationFailure(command: string, cwd: string, code: string, note: string, operationId: string): ToolEnvelope {
  return { ...failEnvelope(command, cwd, note), code, operation_id: operationId };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalValue(nested)]));
  }
  return value;
}

function compactStoredResult(result: ToolEnvelope, maxBytes = MAX_RECORD_BYTES): ToolEnvelope {
  const candidate = { ...result, stdout_summary: "", stderr_summary: "" };
  if (storedBytes(candidate) <= maxBytes) return candidate;
  for (const limit of [500, 100, 25, 0]) {
    const compact: ToolEnvelope = { ...candidate, truncated: true };
    for (const key of ["changed_paths", "conflicts", "files", "content_hashes", "post_status", "per_file"]) {
      const value = compact[key];
      if (Array.isArray(value) && value.length > limit) {
        compact[key] = value.slice(0, limit);
        compact[`${key}_count`] = value.length;
        compact[`${key}_truncated`] = true;
      }
    }
    delete compact.precommit;
    delete compact.diff_excerpt;
    if (storedBytes(compact) <= maxBytes) return compact;
  }

  const minimal: ToolEnvelope = {
    ok: result.ok,
    command: result.command.slice(0, 256),
    cwd: result.cwd,
    revision: result.revision,
    changed_paths: [],
    conflicts: [],
    stdout_summary: "",
    stderr_summary: "",
    truncated: true,
    note: result.note.slice(0, 256),
    ...(result.code ? { code: result.code } : {}),
    ...(result.committed_revision !== undefined ? { committed_revision: result.committed_revision } : {}),
    ...(result.resulting_revision !== undefined ? { resulting_revision: result.resulting_revision } : {})
  };
  if (storedBytes(minimal) > maxBytes) throw new Error("operation receipt result cannot fit its reserved capacity");
  return minimal;
}

function storedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
