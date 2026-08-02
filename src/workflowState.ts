import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { currentRequestCancellationSignal, escapeSvnTarget, runSvn } from "./runner.js";
import { parseInfoXml } from "./parse/infoXml.js";
import { svnXmlEntityLimits } from "./parse/xmlOptions.js";
import { MAX_POLICY_BYTES, pathIdentityKey, repositoryEolPolicy, repoRelativePath } from "./guards.js";
import { sha256File } from "./fileHash.js";
import { normalizeStatusLookup, scopedStatusMap } from "./tools/readonly.js";
import type { DiffFileSummary } from "./types.js";

const propertyParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "text",
  parseTagValue: false,
  trimValues: false,
  processEntities: svnXmlEntityLimits
});

export type WorkflowPathState = {
  path: string;
  status: string;
  baseRevision: number | null;
  kind: "file" | "directory" | "missing" | "other";
  contentHash: string | null;
  propertyHash: string;
};

export async function captureCurrentWorkflowPathStates(
  cwd: string,
  wcRoot: string,
  absolutePaths: string[]
): Promise<{ ok: true; states: WorkflowPathState[] } | { ok: false; note: string }> {
  const status = await scopedStatusMap(cwd, wcRoot, absolutePaths);
  if (!status.envelope.ok) {
    return { ok: false, note: status.envelope.note || "unable to capture workflow status" };
  }
  const propertyTargets = absolutePaths.filter((target) => {
    const state = normalizeStatusLookup(status.map, target);
    return state !== "D" && state !== "!";
  });
  const [info, properties] = await Promise.all([
    runSvn(["info", "--xml", "--", ...absolutePaths.map(escapeSvnTarget)], cwd),
    capturePropertyHashes(cwd, propertyTargets)
  ]);
  if (!properties.ok) return properties;
  const revisionByPath = new Map<string, number | null>();
  if (info.exitCode === 0) {
    for (const entry of parseInfoXml(info.stdout)) {
      if (!entry.path) continue;
      const candidate = path.isAbsolute(entry.path) ? entry.path : path.resolve(cwd, entry.path);
      revisionByPath.set(pathIdentityKey(candidate), entry.revision ?? null);
    }
  }
  const states = await Promise.all(absolutePaths.map(async (target) => {
    const targetStatus = normalizeStatusLookup(status.map, target) ?? "";
    return {
      path: repoRelativePath(target, wcRoot),
      status: targetStatus,
      baseRevision: revisionByPath.get(pathIdentityKey(target)) ?? null,
      ...await fileIdentity(target),
      propertyHash: targetStatus === "D" || targetStatus === "!"
        ? sha256(JSON.stringify({ unavailableForStatus: targetStatus }))
        : properties.hashes.get(pathIdentityKey(target)) ?? emptyPropertyHash()
    };
  }));
  return { ok: true, states };
}

async function capturePropertyHashes(
  cwd: string,
  absolutePaths: string[]
): Promise<{ ok: true; hashes: Map<string, string> } | { ok: false; note: string }> {
  if (absolutePaths.length === 0) return { ok: true, hashes: new Map() };
  const run = await runSvn(["proplist", "--xml", "--verbose", "--", ...absolutePaths.map(escapeSvnTarget)], cwd);
  if (run.exitCode !== 0) {
    return { ok: false, note: run.stderr.trim() || run.stdout.trim() || "unable to capture SVN properties" };
  }
  const hashes = new Map(absolutePaths.map((target) => [pathIdentityKey(target), emptyPropertyHash()]));
  try {
    const parsed = propertyParser.parse(run.stdout) as { properties?: { target?: unknown } };
    for (const targetValue of asArray(parsed.properties?.target)) {
      const target = targetValue as { path?: string; property?: unknown };
      if (!target.path) continue;
      const absolute = path.isAbsolute(target.path) ? path.resolve(target.path) : path.resolve(cwd, target.path);
      const properties = asArray(target.property)
        .map((value) => {
          const property = value as { name?: unknown; encoding?: unknown; text?: unknown };
          const encoding = typeof property.encoding === "string" ? property.encoding : "";
          const rawValue = property.text === undefined ? "" : String(property.text);
          return {
            name: typeof property.name === "string" ? property.name : "",
            encoding,
            value: encoding.toLowerCase() === "base64"
              ? Buffer.from(rawValue.replace(/\s+/g, ""), "base64").toString("hex")
              : rawValue
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name)
          || left.encoding.localeCompare(right.encoding)
          || left.value.localeCompare(right.value));
      hashes.set(pathIdentityKey(absolute), sha256(JSON.stringify(properties)));
    }
    return { ok: true, hashes };
  } catch {
    return { ok: false, note: "invalid SVN property XML while capturing workflow state" };
  }
}

export async function fileIdentity(target: string): Promise<{ kind: WorkflowPathState["kind"]; contentHash: string | null }> {
  try {
    const stat = await fs.promises.stat(target);
    if (stat.isFile()) {
      return { kind: "file", contentHash: await sha256File(target, currentRequestCancellationSignal()) };
    }
    if (stat.isDirectory()) return { kind: "directory", contentHash: null };
    return { kind: "other", contentHash: null };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { kind: "missing", contentHash: null };
  }
}

export function workflowPolicyIdentity(wcRoot: string): string {
  const policy = repositoryEolPolicy(wcRoot);
  const policyPath = path.join(wcRoot, ".svn-mcp-policy.json");
  let policyFile = "";
  try {
    const stat = fs.statSync(policyPath);
    policyFile = stat.isFile() && stat.size <= MAX_POLICY_BYTES
      ? fs.readFileSync(policyPath, "utf8")
      : `unreadable-policy:${stat.size}`;
  } catch {
    policyFile = "";
  }
  return `sha256:${createHash("sha256")
    .update(JSON.stringify({ target: policy.target, excludes: policy.excludes, policyFile }))
    .digest("hex")}`;
}

export function workflowEolPolicyIdentity(wcRoot: string): string {
  const policy = repositoryEolPolicy(wcRoot);
  return `sha256:${sha256(JSON.stringify({ target: policy.target, excludes: policy.excludes }))}`;
}

export function workflowDiffIdentity(diff: {
  per_file: DiffFileSummary[];
  total_files: number;
  total_added: number;
  total_removed: number;
}): string {
  const files = diff.per_file
    .map((file) => ({ ...file, path: String(file.path ?? "").replace(/\\/g, "/") }))
    .sort((left, right) => String(left.path).localeCompare(String(right.path)));
  return `sha256:${sha256(JSON.stringify({
    files,
    totalFiles: diff.total_files,
    added: diff.total_added,
    removed: diff.total_removed
  }))}`;
}

export function workflowStatesEqual(left: WorkflowPathState[], right: WorkflowPathState[]): boolean {
  const canonical = (states: WorkflowPathState[]) => [...states]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((state) => ({ ...state, path: state.path.replace(/\\/g, "/") }));
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function parseWorkflowPathStates(value: unknown): WorkflowPathState[] | null {
  if (!Array.isArray(value) || value.length > 500) return null;
  const states: WorkflowPathState[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const record = candidate as Record<string, unknown>;
    if (typeof record.path !== "string" || record.path.length < 1 || record.path.length > 4096
      || path.isAbsolute(record.path) || record.path.includes("\0")) return null;
    if (typeof record.status !== "string" || record.status.length > 8) return null;
    if (record.baseRevision !== null
      && (!Number.isSafeInteger(record.baseRevision) || Number(record.baseRevision) < 0)) return null;
    if (record.kind !== "file" && record.kind !== "directory"
      && record.kind !== "missing" && record.kind !== "other") return null;
    if (record.contentHash !== null
      && (typeof record.contentHash !== "string" || !/^[0-9a-f]{64}$/i.test(record.contentHash))) return null;
    if (typeof record.propertyHash !== "string" || !/^[0-9a-f]{64}$/i.test(record.propertyHash)) return null;
    const key = pathIdentityKey(path.resolve(record.path));
    if (seen.has(key)) return null;
    seen.add(key);
    states.push({
      path: record.path,
      status: record.status,
      baseRevision: record.baseRevision === null ? null : Number(record.baseRevision),
      kind: record.kind,
      contentHash: record.contentHash,
      propertyHash: record.propertyHash
    });
  }
  return states;
}

function emptyPropertyHash(): string {
  return sha256("[]");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
