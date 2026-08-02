import { createHash } from "node:crypto";
import { EvidenceStore, processEvidenceStore } from "./evidenceStore.js";
import { pathIdentityKey } from "./guards.js";

export type WorkflowEvidenceKind = "baseline" | "precommit" | "safe_commit";

export type WorkflowEvidenceResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; code: string; note: string };

export type WorkflowEvidenceLookup =
  | { ok: true; record: Record<string, unknown>; expiresAt: number }
  | { ok: false; code: string; note: string };

export class WorkflowEvidenceRegistry {
  readonly #store: EvidenceStore;

  constructor(store = processEvidenceStore) {
    this.#store = store;
  }

  put(kind: WorkflowEvidenceKind, scope: string, record: Record<string, unknown>): WorkflowEvidenceResult {
    const stored = this.#store.put(`workflow:${kind}`, scope, JSON.stringify(record), {});
    if (stored.truncated) {
      return {
        ok: false,
        code: "WORKFLOW_EVIDENCE_TOO_LARGE",
        note: "workflow evidence exceeds the bounded operation entry"
      };
    }
    return { ok: true, token: stored.operationId, expiresAt: stored.expiresAt };
  }

  get(token: string, kind: WorkflowEvidenceKind, scope: string): WorkflowEvidenceLookup {
    const evidence = this.#store.get(token, `workflow:${kind}`, scope);
    if (!evidence.ok) return evidence;
    try {
      const parsed = JSON.parse(evidence.text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, code: "WORKFLOW_EVIDENCE_INVALID", note: "workflow evidence is invalid" };
      }
      return { ok: true, record: parsed as Record<string, unknown>, expiresAt: evidence.expiresAt };
    } catch {
      return { ok: false, code: "WORKFLOW_EVIDENCE_INVALID", note: "workflow evidence is invalid" };
    }
  }
}

export const processWorkflowEvidence = new WorkflowEvidenceRegistry();

export function workflowScope(wcRoot: string, absolutePaths: string[]): string {
  const value = JSON.stringify({
    wcRoot: pathIdentityKey(wcRoot),
    paths: absolutePaths.map((candidate) => pathIdentityKey(candidate)).sort()
  });
  return createHash("sha256").update(value).digest("base64url");
}
