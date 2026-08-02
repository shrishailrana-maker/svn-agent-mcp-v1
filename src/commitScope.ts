import fs from "node:fs";
import path from "node:path";
import {
  findExistingDirectoryTarget,
  isCommittableStatus,
  isInsideOrEqual,
  pathIdentityKey,
  repoRelativePath,
  resolveTargetsInsideWc
} from "./guards.js";
import type { ToolEnvelope } from "./types.js";
import { scopedStatusMap } from "./tools/readonly.js";

const MAX_EXPANDED_COMMIT_PATHS = 500;

export type CommitScopeResult =
  | {
      ok: true;
      paths: string[];
      expanded: boolean;
      expandedPaths: string[];
    }
  | {
      ok: false;
      note: string;
      envelope?: ToolEnvelope;
      expanded: boolean;
      expandedPaths: string[];
    };

export async function resolveCommitScope(input: {
  cwd: string;
  wcRoot: string;
  paths: string[];
  expandDescendants?: boolean;
  allowDirectoryTargets?: boolean;
}): Promise<CommitScopeResult> {
  const directoryTarget = findExistingDirectoryTarget(input.paths);
  if (!directoryTarget.ok) {
    return { ok: false, note: directoryTarget.note, expanded: false, expandedPaths: [] };
  }
  if (!directoryTarget.target) {
    return { ok: true, paths: input.paths, expanded: false, expandedPaths: [] };
  }
  if (!input.expandDescendants) {
    if (!input.allowDirectoryTargets) {
      return {
        ok: false,
        note: `directory commit target requires allowDirectoryTargets:true because --depth empty excludes descendants: ${repoRelativePath(directoryTarget.target, input.wcRoot)}`,
        expanded: false,
        expandedPaths: []
      };
    }
    return { ok: true, paths: input.paths, expanded: false, expandedPaths: [] };
  }

  const directoryKeys = new Set(input.paths.filter(isExistingDirectory).map((candidate) => pathIdentityKey(candidate)));
  const explicitFileKeys = new Set(input.paths
    .filter((candidate) => !directoryKeys.has(pathIdentityKey(candidate)))
    .map((candidate) => pathIdentityKey(candidate)));
  const status = await scopedStatusMap(input.cwd, input.wcRoot, input.paths);
  if (!status.envelope.ok) {
    return {
      ok: false,
      note: status.envelope.note || "unable to expand directory commit targets",
      envelope: status.envelope,
      expanded: true,
      expandedPaths: []
    };
  }

  const candidates: string[] = [];
  for (const changed of status.envelope.changed_paths) {
    if (!isCommittableStatus(changed.status)) continue;
    const candidate = path.resolve(input.cwd, changed.path);
    const key = pathIdentityKey(candidate);
    if (explicitFileKeys.has(key) || [...directoryKeys].some((directory) => isInsideOrEqual(candidate, directory))) {
      if (!candidates.some((existing) => pathIdentityKey(existing) === key)) {
        candidates.push(candidate);
      }
    }
  }
  candidates.sort((left, right) => repoRelativePath(left, input.wcRoot).localeCompare(repoRelativePath(right, input.wcRoot)));

  if (candidates.length > MAX_EXPANDED_COMMIT_PATHS) {
    return {
      ok: false,
      note: `expanded commit scope contains ${candidates.length} paths; narrow the directory scope to at most ${MAX_EXPANDED_COMMIT_PATHS}`,
      expanded: true,
      expandedPaths: candidates.slice(0, MAX_EXPANDED_COMMIT_PATHS).map((candidate) => repoRelativePath(candidate, input.wcRoot))
    };
  }
  const contained = resolveTargetsInsideWc(input.cwd, input.wcRoot, candidates);
  if (!contained.ok) {
    return { ok: false, note: contained.note, expanded: true, expandedPaths: [] };
  }
  return {
    ok: true,
    paths: contained.paths,
    expanded: true,
    expandedPaths: contained.paths.map((candidate) => repoRelativePath(candidate, input.wcRoot))
  };
}

function isExistingDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
