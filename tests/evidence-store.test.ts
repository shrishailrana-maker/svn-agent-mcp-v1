import { EvidenceStore } from "../src/evidenceStore.js";

describe("bounded operation evidence store", () => {
  it("binds evidence to kind and scope and expires it", () => {
    let now = 1_000;
    const store = new EvidenceStore({ ttlMs: 100, now: () => now });
    const stored = store.put("svn_diff", "scope-a", "secret-redacted detail", { totalLines: 3 });

    expect(store.get(stored.operationId, "svn_diff", "scope-a")).toMatchObject({
      ok: true,
      text: "secret-redacted detail",
      metadata: { totalLines: 3 }
    });
    expect(store.get(stored.operationId, "safe_commit", "scope-a")).toMatchObject({
      ok: false,
      code: "EVIDENCE_KIND_MISMATCH"
    });
    expect(store.get(stored.operationId, "svn_diff", "scope-b")).toMatchObject({
      ok: false,
      code: "EVIDENCE_SCOPE_MISMATCH"
    });

    now += 101;
    expect(store.get(stored.operationId, "svn_diff", "scope-a")).toEqual({
      ok: false,
      code: "EVIDENCE_EXPIRED",
      note: "operation evidence expired"
    });
  });

  it("retains terminal source-truncation metadata for continuation receipts", () => {
    const store = new EvidenceStore();
    const stored = store.put("svn_diff", "scope", "+available", {
      sourceTruncated: true,
      summary: { total_lines: 2 }
    });

    expect(store.get(stored.operationId, "svn_diff", "scope")).toMatchObject({
      ok: true,
      metadata: { sourceTruncated: true }
    });
  });

  it("caps entries and bytes, cleans oldest evidence, and does not survive restart", () => {
    let now = 1_000;
    const store = new EvidenceStore({ maxEntries: 2, maxEntryBytes: 8, maxTotalBytes: 12, now: () => now });
    const first = store.put("svn_diff", "scope", "12345678", {});
    now += 1;
    const second = store.put("svn_diff", "scope", "abcdefghijk", {});
    expect(second.storedBytes).toBeLessThanOrEqual(8);
    expect(second.truncated).toBe(true);
    now += 1;
    const third = store.put("svn_diff", "scope", "WXYZ", {});

    expect(store.get(first.operationId, "svn_diff", "scope")).toMatchObject({
      ok: false,
      code: "EVIDENCE_NOT_FOUND"
    });
    expect(store.get(second.operationId, "svn_diff", "scope").ok).toBe(true);
    expect(store.get(third.operationId, "svn_diff", "scope").ok).toBe(true);
    expect(new EvidenceStore().get(second.operationId, "svn_diff", "scope")).toMatchObject({
      ok: false,
      code: "EVIDENCE_NOT_FOUND"
    });
  });

  it("keeps concurrent operation IDs distinct and rejects malformed IDs", () => {
    const store = new EvidenceStore();
    const ids = Array.from({ length: 20 }, (_, index) =>
      store.put("svn_diff", `scope-${index}`, `detail-${index}`, {}).operationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(store.get("../../tampered", "svn_diff", "scope")).toEqual({
      ok: false,
      code: "EVIDENCE_CURSOR_INVALID",
      note: "invalid operation evidence cursor"
    });
  });
});
