import { createHash, createHmac, randomBytes } from "node:crypto";

export type SnapshotTokenVerification =
  | { ok: true; unchanged: boolean; expiresAt: number }
  | { ok: false; code: string; note: string };

interface SnapshotTokenRecord {
  expiresAt: number;
  workingCopy: string;
  options: string;
  state: string;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_TOKEN_CHARS = 64;
const MAX_TOKENS = 512;

export class SnapshotTokenCodec {
  readonly #secret: Buffer;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #records = new Map<string, SnapshotTokenRecord>();

  constructor(secret: Uint8Array = randomBytes(32), ttlMs = DEFAULT_TTL_MS, now: () => number = Date.now) {
    this.#secret = Buffer.from(secret);
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  issue(wcRoot: string, options: unknown, state: unknown): string {
    this.#cleanup();
    while (this.#records.size >= MAX_TOKENS) {
      const oldest = this.#records.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#records.delete(oldest);
    }
    const token = createHmac("sha256", this.#secret).update(randomBytes(32)).digest("base64url").slice(0, 32);
    this.#records.set(token, {
      expiresAt: this.#now() + this.#ttlMs,
      workingCopy: digest(normalizeWorkingCopy(wcRoot)),
      options: digest(stableStringify(options)),
      state: digest(stableStringify(state))
    });
    return token;
  }

  verify(token: string, wcRoot: string, options: unknown, state: unknown): SnapshotTokenVerification {
    if (!token || token.length > MAX_TOKEN_CHARS) {
      return invalidToken();
    }
    const payload = this.#records.get(token);
    if (!payload) {
      return invalidToken();
    }
    if (payload.expiresAt < this.#now()) {
      this.#records.delete(token);
      return { ok: false, code: "SNAPSHOT_CURSOR_EXPIRED", note: "snapshot cursor expired" };
    }
    if (payload.workingCopy !== digest(normalizeWorkingCopy(wcRoot))) {
      return {
        ok: false,
        code: "SNAPSHOT_CURSOR_WORKING_COPY_MISMATCH",
        note: "snapshot cursor belongs to a different working copy"
      };
    }
    if (payload.options !== digest(stableStringify(options))) {
      return {
        ok: false,
        code: "SNAPSHOT_CURSOR_OPTION_MISMATCH",
        note: "snapshot cursor options do not match this request"
      };
    }
    return {
      ok: true,
      unchanged: payload.state === digest(stableStringify(state)),
      expiresAt: payload.expiresAt
    };
  }

  #cleanup(): void {
    const now = this.#now();
    for (const [token, record] of this.#records) {
      if (record.expiresAt < now) {
        this.#records.delete(token);
      }
    }
  }
}

export const processSnapshotTokens = new SnapshotTokenCodec();

function invalidToken(): SnapshotTokenVerification {
  return { ok: false, code: "SNAPSHOT_CURSOR_INVALID", note: "invalid snapshot cursor" };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function normalizeWorkingCopy(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/$/, "");
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
