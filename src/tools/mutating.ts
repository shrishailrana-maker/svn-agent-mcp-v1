import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEnvelope, envelopeFromRun, failEnvelope, noteFromRun } from "../envelope.js";
import {
  assertExistingTargets,
  isCommittableStatus,
  isInsideOrEqual,
  messageFormatWarning,
  neverCommitHit,
  neverCommitNote,
  pathIdentityKey,
  readonlyMode,
  repoRelativePath,
  requireExplicitPaths,
  realPathOfNearestExisting,
  resolveCwd,
  resolveTargetsInsideWc,
  riskySignals,
  validatePropertyName
} from "../guards.js";
import { parseCommittedRevision } from "../parse/commitText.js";
import { parseUpdateText } from "../parse/updateText.js";
import { escapeSvnTarget, runSvn, runSvnVersion } from "../runner.js";
import type { ToolEnvelope } from "../types.js";
import { getWcContext, scopedStatusMap, svnDiff, svnStatus } from "./readonly.js";

const DESCENDANT_SCAN_LIMIT = 20000;
const DESCENDANT_SCAN_DEPTH_LIMIT = 256;

export async function svnAdd(input: { cwd?: string; paths: string[]; allowRecursive?: boolean }): Promise<ToolEnvelope> {
  const guard = await mutatingPathGuard("svn add", input.cwd, input.paths, { requireExisting: true });
  if (!guard.ok) {
    return guard.envelope;
  }

  const targetStats = new Map<string, fs.Stats>();
  for (const target of guard.paths) {
    const hit = neverCommitHit(target, guard.wcRoot);
    if (hit) {
      return failEnvelope("svn add", guard.cwd, neverCommitNote(hit, target, guard.wcRoot));
    }
    const stat = statTargetForMutation("svn add", guard.cwd, target);
    if (!stat.ok) {
      return stat.envelope;
    }
    targetStats.set(target, stat.stat);
    if (stat.stat.isDirectory()) {
      if (!input.allowRecursive) {
        return failEnvelope("svn add", guard.cwd, `directory add requires allowRecursive:true: ${target}`);
      }
      const descendantHit = await firstNeverCommitDescendant(target, guard.wcRoot);
      if (descendantHit?.error) {
        return failEnvelope("svn add", guard.cwd, descendantHit.error);
      }
      if (descendantHit?.hit) {
        return failEnvelope(
          "svn add",
          guard.cwd,
          descendantHit.hit.glob.startsWith("policy-error:")
            ? descendantHit.hit.glob
            : `never-commit path matches ${descendantHit.hit.glob}: ${descendantHit.hit.path}`
        );
      }
    }
  }

  const hasDirectory = [...targetStats.values()].some((stat) => stat.isDirectory());
  const args = ["add", "--parents", "--depth", hasDirectory ? "infinity" : "empty", "--", ...guard.paths.map(escapeSvnTarget)];
  const run = await runSvn(args, guard.cwd);
  return envelopeFromRun({ run, ok: run.exitCode === 0, note: run.exitCode === 0 ? "" : noteFromRun(run) });
}

export async function svnCommit(input: {
  cwd?: string;
  paths: string[];
  message: string;
  riskAck?: boolean;
  allowRoot?: boolean;
}): Promise<ToolEnvelope> {
  const guard = await mutatingPathGuard("svn commit", input.cwd, input.paths, { requireExisting: false });
  if (!guard.ok) {
    return guard.envelope;
  }
  if (!input.message.trim()) {
    return failEnvelope("svn commit", guard.cwd, "non-empty commit message required");
  }
  if (!input.allowRoot && guard.paths.some((target) => pathIdentityKey(target) === pathIdentityKey(guard.wcRoot))) {
    return failEnvelope("svn commit", guard.cwd, "working-copy root commit requires allowRoot:true");
  }

  for (const target of guard.paths) {
    const hit = neverCommitHit(target, guard.wcRoot);
    if (hit) {
      return failEnvelope("svn commit", guard.cwd, neverCommitNote(hit, target, guard.wcRoot));
    }
  }

  const status = await scopedStatusMap(guard.cwd, guard.wcRoot, statusPathsForCommit(guard.paths, guard.wcRoot));
  if (!status.envelope.ok) {
    return status.envelope;
  }

  const conflictedTargets = new Set(
    status.envelope.conflicts.map((conflict) => pathIdentityKey(path.resolve(guard.cwd, conflict.path)))
  );
  for (const target of guard.paths) {
    const code = status.map.get(pathIdentityKey(target));
    if (!code || code === "?" || code === "!" || code === "I") {
      return failEnvelope("svn commit", guard.cwd, `target not changed or not scheduled: ${repoRelativePath(target, guard.wcRoot)}`);
    }
    if (!isCommittableStatus(code)) {
      return failEnvelope("svn commit", guard.cwd, `target has non-committable status (${code}): ${repoRelativePath(target, guard.wcRoot)}`);
    }
    if (conflictedTargets.has(pathIdentityKey(target))) {
      return failEnvelope("svn commit", guard.cwd, `target has unresolved conflicts: ${repoRelativePath(target, guard.wcRoot)}`);
    }
  }

  const riskSignals = riskySignals(guard.paths, guard.wcRoot, status.map);
  if (riskSignals.length > 0 && !input.riskAck) {
    return {
      ...failEnvelope("svn commit", guard.cwd, `riskAck required: ${riskSignals.join(", ")}`),
      risk_signals: riskSignals
    };
  }
  const commitPaths = commitPathsWithAddedParents(guard.paths, guard.wcRoot, status.map);

  const warnings: string[] = [];
  const messageWarning = messageFormatWarning(input.message);
  if (messageWarning) {
    warnings.push(messageWarning);
  }
  const version = await runSvnVersion(guard.wcRoot, guard.cwd);
  if (version.exitCode === 0 && version.stdout.includes(":")) {
    warnings.push("mixed revision working copy");
  }

  const messageTemp = writeMessageTemp("svn-agent-commit-", input.message);

  try {
    const run = await runSvn(["commit", "-F", messageTemp.file, "--depth", "empty", "--", ...commitPaths.map(escapeSvnTarget)], guard.cwd);
    const revision = parseCommittedRevision(`${run.stdout}\n${run.stderr}`);
    const postStatus = run.exitCode === 0 ? await svnStatus({ cwd: guard.cwd, paths: input.paths }) : null;
    const postStatusClean = postStatus ? postStatus.changed_paths.length === 0 : false;
    const noteParts = [
      run.exitCode === 0 ? "" : noteFromRun(run),
      ...warnings,
      run.exitCode === 0 && !postStatusClean ? "post-status has residue" : ""
    ].filter(Boolean);

    return {
      ...envelopeFromRun({
        run,
        ok: run.exitCode === 0,
        revision,
        changed_paths: postStatus?.changed_paths ?? [],
        conflicts: postStatus?.conflicts ?? [],
        note: noteParts.join("; ")
      }),
      revision,
      post_status_clean: postStatusClean,
      risk_signals: riskSignals
    };
  } finally {
    fs.rmSync(messageTemp.dir, { recursive: true, force: true });
  }
}

export async function svnMove(input: { cwd?: string; src: string; dest: string }): Promise<ToolEnvelope> {
  return svnMoveOrCopy("svn move", "move", input);
}

export async function svnRename(input: { cwd?: string; src: string; dest: string }): Promise<ToolEnvelope> {
  return svnMoveOrCopy("svn rename", "move", input);
}

export async function svnCopy(input: { cwd?: string; src: string; dest: string }): Promise<ToolEnvelope> {
  return svnMoveOrCopy("svn copy", "copy", input);
}

export async function svnUpdate(input: { cwd?: string; paths?: string[]; updateAll?: boolean }): Promise<ToolEnvelope> {
  const cwd = resolveCwd(input.cwd);
  if (readonlyMode()) {
    return failEnvelope("svn update", cwd, "READONLY instance");
  }
  if ((!input.paths || input.paths.length === 0) && !input.updateAll) {
    return failEnvelope("svn update", cwd, "explicit paths required or updateAll:true");
  }

  const context = await getWcContext(input.cwd, input.paths ?? []);
  if (!context.ok) {
    return context.envelope;
  }

  let targets: string[] = [];
  if (input.paths && input.paths.length > 0) {
    const resolved = resolveTargetsInsideWc(context.cwd, context.wcRoot, input.paths);
    if (!resolved.ok) {
      return failEnvelope("svn update", context.cwd, resolved.note);
    }
    targets = resolved.paths;
  }

  const run = await runSvn(["update", "--accept", "postpone", ...(targets.length > 0 ? ["--", ...targets.map(escapeSvnTarget)] : [])], context.cwd);
  const parsed = parseUpdateText(`${run.stdout}\n${run.stderr}`);
  return envelopeFromRun({
    run,
    ok: run.exitCode === 0,
    changed_paths: parsed.changed_paths,
    conflicts: parsed.conflicts,
    note: parsed.conflicts.length > 0 ? "conflicts present" : run.exitCode === 0 ? "" : noteFromRun(run)
  });
}

export async function svnRevert(input: {
  cwd?: string;
  paths: string[];
  allowRecursive?: boolean;
  dryRun?: boolean;
}): Promise<ToolEnvelope> {
  const dryRun = input.dryRun ?? true;
  if (!dryRun && readonlyMode()) {
    return failEnvelope("svn revert", resolveCwd(input.cwd), "READONLY instance");
  }

  const guard = await mutatingPathGuard("svn revert", input.cwd, input.paths, { requireExisting: false, allowReadonlyForDryRun: dryRun });
  if (!guard.ok) {
    return guard.envelope;
  }

  if (guard.paths.some((target) => pathIdentityKey(target) === pathIdentityKey(guard.wcRoot))) {
    return failEnvelope("svn revert", guard.cwd, "refusing to revert working-copy root");
  }

  const directoryTargets: string[] = [];
  for (const target of guard.paths) {
    if (!fs.existsSync(target)) {
      continue;
    }
    const stat = statTargetForMutation("svn revert", guard.cwd, target);
    if (!stat.ok) {
      return stat.envelope;
    }
    if (stat.stat.isDirectory()) {
      directoryTargets.push(target);
    }
  }
  if (directoryTargets.length > 0 && !input.allowRecursive) {
    return failEnvelope("svn revert", guard.cwd, "directory revert requires allowRecursive:true");
  }

  if (dryRun) {
    const status = await svnStatus({ cwd: guard.cwd, paths: input.paths });
    const diff = await svnDiff({ cwd: guard.cwd, paths: input.paths, ignoreEol: true });
    return {
      ...createEnvelope({
        ok: true,
        command: "svn revert --dry-run",
        cwd: guard.cwd,
        changed_paths: status.changed_paths,
        conflicts: status.conflicts,
        note: "dry run; no files changed",
        truncated: diff.truncated
      }),
      per_file: diff.per_file,
      diff_excerpt: diff.diff_excerpt
    };
  }

  const fileTargets = guard.paths.filter((target) => !directoryTargets.includes(target));
  const runs = [];
  if (fileTargets.length > 0) {
    runs.push(await runSvn(["revert", "--", ...fileTargets.map(escapeSvnTarget)], guard.cwd));
  }
  if (directoryTargets.length > 0) {
    runs.push(await runSvn(["revert", "--depth", "infinity", "--", ...directoryTargets.map(escapeSvnTarget)], guard.cwd));
  }

  const failed = runs.find((run) => run.exitCode !== 0);
  const combined = combineRuns(runs, guard.cwd);
  return envelopeFromRun({
    run: failed ?? combined,
    ok: failed === undefined,
    note: failed ? noteFromRun(failed) : ""
  });
}

export async function svnDelete(input: {
  cwd?: string;
  paths: string[];
  allowRecursive?: boolean;
  dryRun?: boolean;
  riskAck?: boolean;
}): Promise<ToolEnvelope> {
  const dryRun = input.dryRun ?? true;
  const guard = await mutatingPathGuard("svn delete", input.cwd, input.paths, {
    requireExisting: true,
    allowReadonlyForDryRun: dryRun
  });
  if (!guard.ok) {
    return guard.envelope;
  }

  if (guard.paths.some((target) => pathIdentityKey(target) === pathIdentityKey(guard.wcRoot))) {
    return failEnvelope("svn delete", guard.cwd, "refusing to delete working-copy root");
  }

  const directoryTargets: string[] = [];
  for (const target of guard.paths) {
    const stat = statTargetForMutation("svn delete", guard.cwd, target);
    if (!stat.ok) {
      return stat.envelope;
    }
    if (stat.stat.isDirectory()) {
      directoryTargets.push(target);
    }
  }
  if (directoryTargets.length > 0 && !input.allowRecursive) {
    return failEnvelope("svn delete", guard.cwd, "directory delete requires allowRecursive:true");
  }

  if (dryRun) {
    return {
      ...createEnvelope({
        ok: true,
        command: "svn delete --dry-run",
        cwd: guard.cwd,
        note: "dry run; no paths deleted"
      }),
      dry_run: true,
      targets: guard.paths.map((target) => repoRelativePath(target, guard.wcRoot)),
      recursive: directoryTargets.length > 0
    };
  }
  if (!input.riskAck) {
    return failEnvelope("svn delete", guard.cwd, "riskAck required: deletion schedules paths for removal");
  }

  const run = await runSvn(["delete", "--", ...guard.paths.map(escapeSvnTarget)], guard.cwd);
  const status = run.exitCode === 0 ? await scopedStatusMap(guard.cwd, guard.wcRoot, guard.paths) : null;
  const postStatusVerified = status !== null
    && status.envelope.ok
    && guard.paths.every((target) => status.map.get(pathIdentityKey(target)) === "D");
  return {
    ...envelopeFromRun({
      run,
      ok: run.exitCode === 0,
      changed_paths: status?.envelope.changed_paths ?? [],
      conflicts: status?.envelope.conflicts ?? [],
      note: run.exitCode === 0 ? "" : noteFromRun(run)
    }),
    operation: "delete",
    post_status_verified: postStatusVerified
  };
}

export async function svnResolve(input: {
  cwd?: string;
  path: string;
  accept: "working" | "mine-full" | "theirs-full" | "base";
}): Promise<ToolEnvelope> {
  const guard = await mutatingPathGuard("svn resolve", input.cwd, [input.path], { requireExisting: true });
  if (!guard.ok) {
    return guard.envelope;
  }

  const [target] = guard.paths;
  if (!target) {
    return failEnvelope("svn resolve", guard.cwd, "explicit path required");
  }
  const run = await runSvn(["resolve", "--accept", input.accept, "--", escapeSvnTarget(target)], guard.cwd);
  return envelopeFromRun({ run, ok: run.exitCode === 0, note: run.exitCode === 0 ? "" : noteFromRun(run) });
}

export const svnResolved = svnResolve;

export async function svnCleanup(input: { cwd?: string; path?: string }): Promise<ToolEnvelope> {
  const cwd = resolveCwd(input.cwd);
  if (readonlyMode()) {
    return failEnvelope("svn cleanup", cwd, "READONLY instance");
  }

  const context = await getWcContext(input.cwd, input.path ? [input.path] : []);
  if (!context.ok) {
    return context.envelope;
  }

  const targets = input.path ? [input.path] : [];
  const resolved = targets.length > 0 ? resolveTargetsInsideWc(context.cwd, context.wcRoot, targets) : { ok: true as const, paths: [] };
  if (!resolved.ok) {
    return failEnvelope("svn cleanup", context.cwd, resolved.note);
  }

  const run = await runSvn(["cleanup", ...(resolved.paths.length > 0 ? ["--", ...resolved.paths.map(escapeSvnTarget)] : [])], context.cwd);
  return envelopeFromRun({ run, ok: run.exitCode === 0, note: run.exitCode === 0 ? "" : noteFromRun(run) });
}

export async function svnPropsetEolStyle(input: {
  cwd?: string;
  paths: string[];
  style?: "native" | "LF" | "CRLF";
}): Promise<ToolEnvelope> {
  const guard = await mutatingPathGuard("svn propset", input.cwd, input.paths, { requireExisting: true });
  if (!guard.ok) {
    return guard.envelope;
  }

  const style = input.style ?? "native";
  const targetsToSet: string[] = [];
  for (const target of guard.paths) {
    const hit = neverCommitHit(target, guard.wcRoot);
    if (hit) {
      return failEnvelope("svn propset", guard.cwd, neverCommitNote(hit, target, guard.wcRoot));
    }
    const prop = await runSvn(["propget", "--", "svn:eol-style", escapeSvnTarget(target)], guard.cwd);
    if (prop.exitCode !== 0 || prop.stdout.trim() !== style) {
      targetsToSet.push(target);
    }
  }

  if (targetsToSet.length === 0) {
    return createEnvelope({
      ok: true,
      command: "svn propset",
      cwd: guard.cwd,
      note: `svn:eol-style already ${style} on all paths`
    });
  }

  const run = await runSvn(["propset", "--", "svn:eol-style", style, ...targetsToSet.map(escapeSvnTarget)], guard.cwd);
  return envelopeFromRun({ run, ok: run.exitCode === 0, note: run.exitCode === 0 ? "" : noteFromRun(run) });
}

export async function svnPropset(input: {
  cwd?: string;
  paths: string[];
  name: string;
  value: string;
  riskAck?: boolean;
}): Promise<ToolEnvelope> {
  const guard = await mutatingPathGuard("svn propset", input.cwd, input.paths, { requireExisting: true });
  if (!guard.ok) {
    return guard.envelope;
  }

  const propertyError = validatePropertyName(input.name);
  if (propertyError) {
    return failEnvelope("svn propset", guard.cwd, propertyError);
  }
  if (input.value.includes("\0")) {
    return failEnvelope("svn propset", guard.cwd, "invalid property value");
  }
  if (input.value.length > 16000) {
    return failEnvelope("svn propset", guard.cwd, "property value too large");
  }

  for (const target of guard.paths) {
    const hit = neverCommitHit(target, guard.wcRoot);
    if (hit) {
      return failEnvelope("svn propset", guard.cwd, neverCommitNote(hit, target, guard.wcRoot));
    }
  }

  const riskSignals = propertyRiskSignals(input.name);
  if (riskSignals.length > 0 && !input.riskAck) {
    return {
      ...failEnvelope("svn propset", guard.cwd, `riskAck required: ${riskSignals.join(", ")}`),
      risk_signals: riskSignals
    };
  }

  const run = await runSvn(["propset", "--", input.name, input.value, ...guard.paths.map(escapeSvnTarget)], guard.cwd);
  const status = run.exitCode === 0 ? await svnStatus({ cwd: guard.cwd, paths: input.paths }) : null;
  return {
    ...envelopeFromRun({
      run,
      ok: run.exitCode === 0,
      changed_paths: status?.changed_paths ?? [],
      conflicts: status?.conflicts ?? [],
      note: run.exitCode === 0 ? "" : noteFromRun(run)
    }),
    risk_signals: riskSignals
  };
}

export async function svnExport(input: {
  cwd?: string;
  src: string;
  dest: string;
  revision?: string;
  externalDestAck?: boolean;
}): Promise<ToolEnvelope> {
  const cwd = resolveCwd(input.cwd);
  if (readonlyMode()) {
    return failEnvelope("svn export", cwd, "READONLY instance");
  }

  const args = ["export"];
  if (input.revision) {
    if (!isValidRevision(input.revision)) {
      return failEnvelope("svn export", cwd, `invalid revision: ${input.revision}`);
    }
    args.push("-r", input.revision);
  }

  const destination = realPathOfNearestExisting(path.resolve(cwd, input.dest));
  const destinationContext = await getWcContext(undefined, [destination]);
  if (destinationContext.ok) {
    const resolved = resolveTargetsInsideWc(destinationContext.cwd, destinationContext.wcRoot, [destination]);
    if (!resolved.ok) {
      return failEnvelope("svn export", cwd, resolved.note);
    }
    const [resolvedDestination] = resolved.paths;
    if (!resolvedDestination) {
      return failEnvelope("svn export", cwd, "explicit destination required");
    }
    const hit = neverCommitHit(resolvedDestination, destinationContext.wcRoot);
    if (hit) {
      return failEnvelope("svn export", cwd, neverCommitNote(hit, resolvedDestination, destinationContext.wcRoot));
    }
  } else if (!input.externalDestAck) {
    return failEnvelope("svn export", cwd, "export destination outside a working copy requires externalDestAck:true");
  }

  args.push("--", escapeSvnTarget(input.src), escapeSvnTarget(destination));
  const run = await runSvn(args, cwd);
  return envelopeFromRun({ run, ok: run.exitCode === 0, note: run.exitCode === 0 ? "" : noteFromRun(run) });
}

export async function svnImport(input: { cwd?: string; src: string; url: string; message: string }): Promise<ToolEnvelope> {
  const cwd = resolveCwd(input.cwd);
  if (readonlyMode()) {
    return failEnvelope("svn import", cwd, "READONLY instance");
  }

  const existsError = assertExistingTargets([path.resolve(cwd, input.src)]);
  if (existsError) {
    return failEnvelope("svn import", cwd, existsError);
  }

  const importSource = path.resolve(cwd, input.src);
  // Guard from the filesystem root so ancestor segments stay visible; with a
  // dirname guard root, importing .ssh\config reduces to "config" and bypasses
  // the sensitive-directory globs entirely.
  const importGuardRoot = path.parse(importSource).root;
  const sourceHit = neverCommitHit(importSource, importGuardRoot);
  if (sourceHit) {
    return failEnvelope("svn import", cwd, neverCommitNote(sourceHit, importSource, importGuardRoot));
  }
  const sourceStat = statTargetForMutation("svn import", cwd, importSource);
  if (!sourceStat.ok) {
    return sourceStat.envelope;
  }
  if (sourceStat.lstat.isSymbolicLink()) {
    return failEnvelope("svn import", cwd, `symbolic link refused as import source: ${importSource}`);
  }
  if (sourceStat.stat.isDirectory()) {
    const descendantHit = await firstNeverCommitDescendant(importSource, importSource);
    if (descendantHit?.error) {
      return failEnvelope("svn import", cwd, descendantHit.error);
    }
    if (descendantHit?.hit) {
      return failEnvelope(
        "svn import",
        cwd,
        descendantHit.hit.glob.startsWith("policy-error:")
          ? descendantHit.hit.glob
          : `never-commit path matches ${descendantHit.hit.glob}: ${descendantHit.hit.path}`
      );
    }
  }

  const messageTemp = writeMessageTemp("svn-agent-import-", input.message);
  try {
    const run = await runSvn(["import", "-F", messageTemp.file, "--", importSource, input.url], cwd);
    return envelopeFromRun({
      run,
      ok: run.exitCode === 0,
      revision: parseCommittedRevision(`${run.stdout}\n${run.stderr}`),
      note: run.exitCode === 0 ? "" : noteFromRun(run)
    });
  } finally {
    fs.rmSync(messageTemp.dir, { recursive: true, force: true });
  }
}

type GuardOptions = {
  requireExisting: boolean;
  allowReadonlyForDryRun?: boolean;
};

async function mutatingPathGuard(
  command: string,
  cwdInput: string | undefined,
  paths: string[] | undefined,
  options: GuardOptions
): Promise<{ ok: true; cwd: string; wcRoot: string; paths: string[] } | { ok: false; envelope: ToolEnvelope }> {
  const cwd = resolveCwd(cwdInput);
  if (readonlyMode() && !options.allowReadonlyForDryRun) {
    return { ok: false, envelope: failEnvelope(command, cwd, "READONLY instance") };
  }

  const explicitError = requireExplicitPaths(paths);
  if (explicitError) {
    return { ok: false, envelope: failEnvelope(command, cwd, explicitError) };
  }

  const context = await getWcContext(cwdInput, paths ?? []);
  if (!context.ok) {
    return { ok: false, envelope: context.envelope };
  }

  const resolved = resolveTargetsInsideWc(context.cwd, context.wcRoot, paths ?? []);
  if (!resolved.ok) {
    return { ok: false, envelope: failEnvelope(command, context.cwd, resolved.note) };
  }

  if (options.requireExisting) {
    const existsError = assertExistingTargets(resolved.paths);
    if (existsError) {
      return { ok: false, envelope: failEnvelope(command, context.cwd, existsError) };
    }
  }

  return {
    ok: true,
    cwd: context.cwd,
    wcRoot: context.wcRoot,
    paths: resolved.paths
  };
}

function statusPathsForCommit(paths: string[], wcRoot: string): string[] {
  const expanded: string[] = [];
  for (const target of paths) {
    for (const ancestor of ancestorDirectories(target, wcRoot)) {
      pushUniquePath(expanded, ancestor);
    }
    pushUniquePath(expanded, target);
  }
  return expanded;
}

function commitPathsWithAddedParents(paths: string[], wcRoot: string, statusByPath: Map<string, string>): string[] {
  const expanded: string[] = [];
  for (const target of paths) {
    for (const ancestor of ancestorDirectories(target, wcRoot)) {
      if (statusByPath.get(pathIdentityKey(ancestor)) === "A") {
        pushUniquePath(expanded, ancestor);
      }
    }
    pushUniquePath(expanded, target);
  }
  return expanded;
}

function ancestorDirectories(absPath: string, wcRoot: string): string[] {
  const root = path.resolve(wcRoot);
  const normalizedRoot = pathIdentityKey(root);
  const ancestors: string[] = [];
  let current = path.dirname(path.resolve(absPath));

  while (pathIdentityKey(current) !== normalizedRoot && isInsideOrEqual(current, root)) {
    ancestors.push(current);
    current = path.dirname(current);
  }

  return ancestors.reverse();
}

function pushUniquePath(paths: string[], value: string): void {
  const normalized = pathIdentityKey(value);
  if (!paths.some((existing) => pathIdentityKey(existing) === normalized)) {
    paths.push(value);
  }
}

async function firstNeverCommitDescendant(directory: string, wcRoot: string): Promise<{
  hit?: { glob: string; path: string };
  error?: string;
} | null> {
  const queue: Array<{ directory: string; depth: number }> = [{ directory, depth: 0 }];
  let scanned = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth > DESCENDANT_SCAN_DEPTH_LIMIT) {
      return { error: `recursive scan depth limit exceeded (${DESCENDANT_SCAN_DEPTH_LIMIT})` };
    }

    const entries = await fs.promises.readdir(current.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.toLowerCase() === ".svn") {
        continue;
      }
      scanned += 1;
      if (scanned > DESCENDANT_SCAN_LIMIT) {
        return { error: `recursive scan entry limit exceeded (${DESCENDANT_SCAN_LIMIT})` };
      }

      const child = path.join(current.directory, entry.name);
      if (entry.isSymbolicLink()) {
        return { error: `symbolic link refused during recursive scan: ${repoRelativePath(child, wcRoot)}` };
      }
      const hit = neverCommitHit(child, wcRoot);
      if (hit) {
        return { hit: { glob: hit, path: repoRelativePath(child, wcRoot) } };
      }
      if (entry.isDirectory()) {
        queue.push({ directory: child, depth: current.depth + 1 });
      }
    }
  }

  return null;
}

async function svnMoveOrCopy(
  commandName: "svn move" | "svn rename" | "svn copy",
  svnVerb: "move" | "copy",
  input: { cwd?: string; src: string; dest: string }
): Promise<ToolEnvelope> {
  const cwd = resolveCwd(input.cwd);
  if (readonlyMode()) {
    return failEnvelope(commandName, cwd, "READONLY instance");
  }
  if (!input.src.trim() || !input.dest.trim()) {
    return failEnvelope(commandName, cwd, "explicit src and dest required");
  }
  if (isSvnUrl(input.src) || isSvnUrl(input.dest)) {
    return failEnvelope(commandName, cwd, "working-copy paths required; repository URL copy/move is not supported");
  }

  const context = await getWcContext(input.cwd, [input.src, input.dest]);
  if (!context.ok) {
    return context.envelope;
  }

  const resolved = resolveTargetsInsideWc(context.cwd, context.wcRoot, [input.src, input.dest]);
  if (!resolved.ok) {
    return failEnvelope(commandName, context.cwd, resolved.note);
  }
  const [src, dest] = resolved.paths;
  if (!src || !dest) {
    return failEnvelope(commandName, context.cwd, "explicit src and dest required");
  }

  const existsError = assertExistingTargets([src]);
  if (existsError) {
    return failEnvelope(commandName, context.cwd, existsError);
  }
  if (pathIdentityKey(src) === pathIdentityKey(context.wcRoot)) {
    return failEnvelope(commandName, context.cwd, "refusing to copy or move working-copy root");
  }

  for (const target of [src, dest]) {
    const hit = neverCommitHit(target, context.wcRoot);
    if (hit) {
      return failEnvelope(commandName, context.cwd, neverCommitNote(hit, target, context.wcRoot));
    }
  }

  const destinationOperand = svnVerb === "copy" ? escapeSvnTarget(dest) : dest;
  const run = await runSvn([svnVerb, "--parents", "--", escapeSvnTarget(src), destinationOperand], context.cwd);
  const status = run.exitCode === 0 ? await svnStatus({ cwd: context.cwd, paths: [src, dest] }) : null;
  return {
    ...envelopeFromRun({
      run,
      ok: run.exitCode === 0,
      changed_paths: status?.changed_paths ?? [],
      conflicts: status?.conflicts ?? [],
      note: run.exitCode === 0 ? "" : noteFromRun(run)
    }),
    operation: svnVerb,
    src,
    dest
  };
}

function isSvnUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

export function statTargetForMutation(
  commandName: string,
  cwd: string,
  target: string
): { ok: true; stat: fs.Stats; lstat: fs.Stats } | { ok: false; envelope: ToolEnvelope } {
  try {
    const lstat = fs.lstatSync(target);
    return { ok: true, stat: fs.statSync(target), lstat };
  } catch {
    return {
      ok: false,
      envelope: failEnvelope(commandName, cwd, `path stat failed before svn command: ${target}`)
    };
  }
}

function writeMessageTemp(prefix: string, message: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, "message.txt");
  fs.writeFileSync(file, normalizeMessageFile(message), { encoding: "utf8", mode: 0o600 });
  return { dir, file };
}

function normalizeMessageFile(value: string): string {
  return stripLeadingBom(value).replace(/\r\n?/g, "\n");
}

function stripLeadingBom(value: string): string {
  return value.replace(/^\uFEFF/, "");
}

function combineRuns(runs: Awaited<ReturnType<typeof runSvn>>[], cwd: string): Awaited<ReturnType<typeof runSvn>> {
  return {
    command: runs.map((run) => run.command).join(" && "),
    cwd,
    executable: runs[0]?.executable ?? "svn",
    args: runs.flatMap((run) => run.args),
    exitCode: 0,
    signal: null,
    stdout: runs.map((run) => run.stdout).filter(Boolean).join("\n"),
    stderr: runs.map((run) => run.stderr).filter(Boolean).join("\n"),
    timedOut: runs.some((run) => run.timedOut),
    cancelled: runs.some((run) => run.cancelled),
    truncated: runs.some((run) => run.truncated)
  };
}

function isValidRevision(value: string): boolean {
  return /^(?:\d+|HEAD|BASE|COMMITTED|PREV|\{[^}\r\n\x00]+\})$/i.test(value.trim());
}

function propertyRiskSignals(name: string): string[] {
  const normalized = name.toLowerCase();
  if (normalized === "svn:ignore" || normalized === "svn:global-ignores") {
    return ["ignore property touched"];
  }
  if (normalized === "svn:externals") {
    return ["externals property touched"];
  }
  if (normalized === "svn:auto-props") {
    return ["auto-props property touched"];
  }
  return [];
}
