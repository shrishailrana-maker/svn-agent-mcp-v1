import { randomUUID } from "node:crypto";

export interface EvidenceStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  now?: () => number;
}

export type EvidenceLookup =
  | {
      ok: true;
      text: string;
      metadata: Record<string, unknown>;
      expiresAt: number;
      truncated: boolean;
    }
  | { ok: false; code: string; note: string };

interface EvidenceRecord {
  kind: string;
  scope: string;
  text: string;
  metadata: Record<string, unknown>;
  expiresAt: number;
  bytes: number;
  truncated: boolean;
}

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class EvidenceStore {
  readonly #records = new Map<string, EvidenceRecord>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #maxEntryBytes: number;
  readonly #maxTotalBytes: number;
  readonly #now: () => number;
  #totalBytes = 0;

  constructor(options: EvidenceStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.#maxEntries = options.maxEntries ?? 32;
    this.#maxEntryBytes = options.maxEntryBytes ?? 2 * 1024 * 1024;
    this.#maxTotalBytes = options.maxTotalBytes ?? 16 * 1024 * 1024;
    this.#now = options.now ?? Date.now;
  }

  put(kind: string, scope: string, text: string, metadata: Record<string, unknown>): {
    operationId: string;
    expiresAt: number;
    storedBytes: number;
    storedLineCount: number;
    truncated: boolean;
  } {
    this.#cleanupExpired();
    const byteLimit = Math.min(this.#maxEntryBytes, this.#maxTotalBytes);
    const bounded = boundUtf8(text, byteLimit);
    while (this.#records.size >= this.#maxEntries || this.#totalBytes + bounded.bytes > this.#maxTotalBytes) {
      if (!this.#evictOldest()) {
        break;
      }
    }

    const operationId = randomUUID();
    const expiresAt = this.#now() + this.#ttlMs;
    this.#records.set(operationId, {
      kind,
      scope,
      text: bounded.text,
      metadata: structuredClone(metadata),
      expiresAt,
      bytes: bounded.bytes,
      truncated: bounded.truncated
    });
    this.#totalBytes += bounded.bytes;
    return {
      operationId,
      expiresAt,
      storedBytes: bounded.bytes,
      storedLineCount: textLineCount(bounded.text),
      truncated: bounded.truncated
    };
  }

  get(operationId: string, kind: string, scope: string): EvidenceLookup {
    if (!OPERATION_ID.test(operationId)) {
      return { ok: false, code: "EVIDENCE_CURSOR_INVALID", note: "invalid operation evidence cursor" };
    }
    const record = this.#records.get(operationId);
    if (!record) {
      return { ok: false, code: "EVIDENCE_NOT_FOUND", note: "operation evidence not found in this MCP session" };
    }
    if (record.expiresAt < this.#now()) {
      this.#delete(operationId, record);
      return { ok: false, code: "EVIDENCE_EXPIRED", note: "operation evidence expired" };
    }
    if (record.kind !== kind) {
      return { ok: false, code: "EVIDENCE_KIND_MISMATCH", note: "operation evidence belongs to another operation" };
    }
    if (record.scope !== scope) {
      return { ok: false, code: "EVIDENCE_SCOPE_MISMATCH", note: "operation evidence scope does not match this request" };
    }
    return {
      ok: true,
      text: record.text,
      metadata: structuredClone(record.metadata),
      expiresAt: record.expiresAt,
      truncated: record.truncated
    };
  }

  #cleanupExpired(): void {
    const now = this.#now();
    for (const [operationId, record] of this.#records) {
      if (record.expiresAt < now) {
        this.#delete(operationId, record);
      }
    }
  }

  #evictOldest(): boolean {
    const oldest = this.#records.entries().next().value as [string, EvidenceRecord] | undefined;
    if (!oldest) {
      return false;
    }
    this.#delete(oldest[0], oldest[1]);
    return true;
  }

  #delete(operationId: string, record: EvidenceRecord): void {
    if (this.#records.delete(operationId)) {
      this.#totalBytes -= record.bytes;
    }
  }
}

export const processEvidenceStore = new EvidenceStore();

function boundUtf8(value: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maxBytes) {
    return { text: value, bytes, truncated: false };
  }
  let low = 0;
  let high = value.length;
  let end = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) {
      end = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const text = value.slice(0, end);
  return { text, bytes: Buffer.byteLength(text, "utf8"), truncated: true };
}

function textLineCount(value: string): number {
  return value ? value.split("\n").length : 0;
}
