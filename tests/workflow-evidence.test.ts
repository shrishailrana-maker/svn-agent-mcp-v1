import { describe, expect, it } from "@jest/globals";
import { EvidenceStore } from "../src/evidenceStore.js";
import { WorkflowEvidenceRegistry, workflowScope } from "../src/workflowEvidence.js";

describe("workflow evidence registry", () => {
  it("stores a short opaque token bound to kind, working copy, and exact paths", () => {
    let now = 1_000;
    const registry = new WorkflowEvidenceRegistry(new EvidenceStore({ ttlMs: 100, now: () => now }));
    const scope = workflowScope("E:\\wc", ["E:\\wc\\b.txt", "E:\\wc\\a.txt"]);
    const issued = registry.put("baseline", scope, { remoteHeadRevision: 42, paths: ["a.txt", "b.txt"] });
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error("expected evidence token");
    expect(issued.token).toMatch(/^[0-9a-f-]{36}$/i);
    expect(issued.token).not.toContain("E:\\wc");

    expect(registry.get(issued.token, "baseline", scope)).toMatchObject({
      ok: true,
      record: { remoteHeadRevision: 42, paths: ["a.txt", "b.txt"] }
    });
    expect(registry.get(issued.token, "precommit", scope)).toMatchObject({ ok: false, code: "EVIDENCE_KIND_MISMATCH" });
    expect(registry.get(issued.token, "baseline", workflowScope("E:\\wc", ["E:\\wc\\a.txt"]))).toMatchObject({
      ok: false,
      code: "EVIDENCE_SCOPE_MISMATCH"
    });
    now += 101;
    expect(registry.get(issued.token, "baseline", scope)).toMatchObject({ ok: false, code: "EVIDENCE_EXPIRED" });
  });

  it("refuses records that exceed the bounded evidence entry", () => {
    const registry = new WorkflowEvidenceRegistry(new EvidenceStore({ maxEntryBytes: 64, maxTotalBytes: 64 }));
    expect(registry.put("baseline", "scope", { value: "x".repeat(1_000) })).toMatchObject({
      ok: false,
      code: "WORKFLOW_EVIDENCE_TOO_LARGE"
    });
  });
});
