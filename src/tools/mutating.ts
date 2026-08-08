import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { resolveCommitScope } from "../commitScope.js";
import {
  configuredHashConcurrency,
  mapWithConcurrency,
  regularFileBytesWithinBudget,
  sha256File
} from "../fileHash.js";
import { prepareEolNormalization, type EolNormalizationResult } from "../eol.js";
import { createEnvelope, envelopeFromRun, failEnvelope, noteFromRun } from "../envelope.js";
import {
  assertExistingTargets,
  eolPolicyExcludes,
  isCommittableStatus,
  isInsideOrEqual,
  neverCommitHit,
  neverCommitNote,
  pathIdentityKey,
  readonlyMode,
  repoRelativePath,
  repositoryEolPolicy,
  requireExplicitPaths,
  realPathOfNearestExisting,
  resolveCwd,
  resolveTargetsInsideWc,
  riskySignals,
  validateCommitMessage,
  validatePropertyName
} from "../guards.js";
import { parseCommittedRevision } from "../parse/commitText.js";
import { parseInfoXml } from "../parse/infoXml.js";
import { parseListXml } from "../parse/listXml.js";
import { parseStatusXml } from "../parse/statusXml.js";
import { parseUpdateText } from "../parse/updateText.js";
import { stableOperationFingerprint, withDurableOperation } from "../operationStore.js";
import { processWorkflowEvidence, workflowScope } from "../workflowEvidence.js";
import {
  captureCurrentWorkflowPathStates,
  parseWorkflowPathStates,
  workflowDiffIdentity,
  workflowEolPolicyIdentity,
  workflowPolicyIdentity,
  workflowStatesEqual,
  type WorkflowPathState
} from "../workflowState.js";
import { currentRequestCancellationSignal, escapeSvnTarget, runSvn, runSvnVersion } from "../runner.js";
import type { ChangedPath, Conflict, RunResult, ToolEnvelope, WcInfo } from "../types.js";
import {
  getWcContext,
  parseSvnVersion,
  remoteHeadForTargets,
  revisionSelectorError,
  scopedStatusMap,
  inspectLockState,
  svnDiff,
  svnStatus
} from "./readonly.js";

const DESCENDANT_SCAN_LIMIT = 20000;
const DESCENDANT_SCAN_DEPTH_LIMIT = 256;
const LOCK_WORKSTATION_LABEL = /^[A-Za-z0-9._-]{1,64}$/;
const LOCK_COMMENT_MAX_CHARS = 4000;
const UUID_OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OUT_OF_DATE_PATH_LIMIT = 100;
const POST_STATUS_PATH_LIMIT = 100;
const UPDATE_SCOPE_PARENT_LIMIT = 10;
const UPDATE_SCOPE_ENTRY_LIMIT = 5000;
const UPDATE_OMITTED_ADDITION_LIMIT = 100;

type SvnLockCoreInput = {
  cwd?: string;
  paths: string[];
  comment: string;
  workstationLabel: string;
  force: boolean;
};

type SvnUnlockCoreInput = {
  cwd?: string;
  paths: string[];
  force: boolean;
};

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
  const eolPolicy = repositoryEolPolicy(guard.wcRoot);
  if (eolPolicy.invalid) {
    return failEnvelope("svn add", guard.cwd, eolPolicy.invalid);
  }
  const eolTarget = eolPolicy.target;
  let preparedEol: Awaited<ReturnType<typeof prepareAddedFileEol>> | null = null;
  try {
    preparedEol = eolTarget
      ? await prepareAddedFileEol(guard.cwd, guard.wcRoot, guard.paths, targetStats, eolTarget, eolPolicy.excludes)
      : null;
  } catch (error) {
    return failEnvelope(
      "svn add",
      guard.cwd,
      error instanceof Error ? error.message : "EOL add preflight failed"
    );
  }
  if (preparedEol && eolTarget && !preparedEol.ok) {
    preparedEol.dispose();
    return {
      ...failEnvelope("svn add", guard.cwd, preparedEol.note ?? "EOL normalization failed"),
      eol_normalization: summarizeEolNormalization(preparedEol.results, eolTarget),
      eol_files: compactEolNormalizationFiles(preparedEol.results, guard.wcRoot)
    };
  }
  const args = ["add", "--parents", "--depth", hasDirectory ? "infinity" : "empty", "--", ...guard.paths.map(escapeSvnTarget)];
  try {
    const run = await runSvn(args, guard.cwd);
    const addFailed = run.exitCode !== 0;
    const rollback = addFailed ? preparedEol?.rollback() : undefined;
    return {
      ...envelopeFromRun({ run, ok: run.exitCode === 0, note: run.exitCode === 0 ? "" : noteFromRun(run) }),
      ...(preparedEol && eolTarget
        ? {
            eol_normalization: {
              ...summarizeEolNormalization(preparedEol.results, eolTarget),
              ...(addFailed
                ? {
                    converted: 0,
                    verified: 0,
                    rolled_back: (rollback?.skipped ?? 0) === 0,
                    rollback_restored: rollback?.restored ?? 0,
                    rollback_skipped: rollback?.skipped ?? 0
                  }
                : {})
            },
            eol_files: addFailed ? [] : compactEolNormalizationFiles(preparedEol.results, guard.wcRoot)
          }
        : {})
    };
  } finally {
    preparedEol?.dispose();
  }
}

export async function svnLock(input: {
  cwd?: string;
  paths: string[];
  comment: string;
  workstationLabel?: string;
  force?: boolean;
  forceAck?: boolean;
  operationId?: string;
}): Promise<ToolEnvelope> {
  const cwd = resolveCwd(input.cwd);
  if (readonlyMode()) {
    return failEnvelope("svn lock", cwd, "READONLY instance");
  }

  const comment = input.comment.trim();
  if (!comment) {
    return failEnvelope("svn lock", cwd, "non-empty lock comment required");
  }
  if (comment.length > LOCK_COMMENT_MAX_CHARS) {
    return failEnvelope("svn lock", cwd, `lock comment exceeds ${LOCK_COMMENT_MAX_CHARS} characters`);
  }
  const workstationLabel = input.workstationLabel ?? process.env.SVN_MCP_WORKSTATION_LABEL ?? "";
  if (!LOCK_WORKSTATION_LABEL.test(workstationLabel)) {
    return failEnvelope(
      "svn lock",
      cwd,
      "workstationLabel or SVN_MCP_WORKSTATION_LABEL must contain 1..64 characters from [A-Za-z0-9._-]"
    );
  }
  if (input.force && (!input.forceAck || !input.operationId || !UUID_OPERATION_ID.test(input.operationId))) {
    return failEnvelope("svn lock", cwd, "force:true requires forceAck:true and a valid operationId", {
      code: "FORCE_ACK_REQUIRED"
    });
  }

  const coreInput: SvnLockCoreInput = {
    paths: input.paths,
    comment,
    workstationLabel,
    force: input.force ?? false
  };
  if (input.cwd !== undefined) coreInput.cwd = input.cwd;
  if (input.operationId) {
    const fingerprint = stableOperationFingerprint({
      kind: "svn_lock",
      cwd: pathIdentityKey(cwd),
      paths: normalizedOperationPaths(cwd, input.paths),
      comment,
      workstationLabel,
      force: input.force ?? false,
      forceAck: input.forceAck ?? false
    });
    return withDurableOperation({
      operationId: input.operationId,
      kind: "svn_lock",
      fingerprint,
      command: "svn lock",
      cwd,
      execute: () => svnLockCore(coreInput)
    });
  }

  return svnLockCore(coreInput);
}

async function svnLockCore(input: SvnLockCoreInput): Promise<ToolEnvelope> {
  const guard = await mutatingPathGuard("svn lock", input.cwd, input.paths, { requireExisting: true });
  if (!guard.ok) return guard.envelope;
  for (const target of guard.paths) {
    const hit = neverCommitHit(target, guard.wcRoot);
    if (hit) return failEnvelope("svn lock", guard.cwd, neverCommitNote(hit, target, guard.wcRoot));
  }

  const storedComment = `[svn-agent-mcp workstation=${input.workstationLabel}] ${input.comment}`;
  const commentTemp = writeMessageTemp("svn-agent-lock-", storedComment);
  try {
    const run = await runSvn([
      "lock",
      ...(input.force ? ["--force"] : []),
      "-F",
      commentTemp.file,
      "--",
      ...guard.paths.map(escapeSvnTarget)
    ], guard.cwd);
    return {
      ...envelopeFromRun({ run, ok: run.exitCode === 0, note: run.exitCode === 0 ? "" : noteFromRun(run) }),
      paths: guard.paths.map((target) => repoRelativePath(target, guard.wcRoot)),
      comment: storedComment,
      workstation_label: input.workstationLabel,
      force: input.force
    };
  } finally {
    fs.rmSync(commentTemp.dir, { recursive: true, force: true });
  }
}

export async function svnUnlock(input: {
  cwd?: string;
  paths: string[];
  force?: boolean;
  forceAck?: boolean;
  operationId?: string;
}): Promise<ToolEnvelope> {
  const cwd = resolveCwd(input.cwd);
  if (readonlyMode()) {
    return failEnvelope("svn unlock", cwd, "READONLY instance");
  }
  if (input.force && (!input.forceAck || !input.operationId || !UUID_OPERATION_ID.test(input.operationId))) {
    return failEnvelope("svn unlock", cwd, "force:true requires forceAck:true and a valid operationId", {
      code: "FORCE_ACK_REQUIRED"
    });
  }

  const coreInput: SvnUnlockCoreInput = {
    paths: input.paths,
    force: input.force ?? false
  };
  if (input.cwd !== undefined) coreInput.cwd = input.cwd;
  if (input.operationId) {
    const fingerprint = stableOperationFingerprint({
      kind: "svn_unlock",
      cwd: pathIdentityKey(cwd),
      paths: normalizedOperationPaths(cwd, input.paths),
      force: input.force ?? false,
      forceAck: input.forceAck ?? false
    });
    return withDurableOperation({
      operationId: input.operationId,
      kind: "svn_unlock",
      fingerprint,
      command: "svn unlock",
      cwd,
      execute: () => svnUnlockCore(coreInput)
    });
  }

  return svnUnlockCore(coreInput);
}

async function svnUnlockCore(input: SvnUnlockCoreInput): Promise<ToolEnvelope> {
  const guard = await mutatingPathGuard("svn unlock", input.cwd, input.paths, { requireExisting: true });
  if (!guard.ok) return guard.envelope;
  for (const target of guard.paths) {
    const hit = neverCommitHit(target, guard.wcRoot);
    if (hit) return failEnvelope("svn unlock", guard.cwd, neverCommitNote(hit, target, guard.wcRoot));
  }

  if (!input.force) {
    const inspected = await inspectLockState({ cwd: guard.cwd, paths: guard.paths });
    if (!inspected.ok) {
      return {
        ...inspected.envelope,
        command: "svn unlock",
        code: "LOCK_STATUS_UNAVAILABLE",
        note: inspected.envelope.note || "unable to verify the current repository lock token"
      };
    }
    for (const row of inspected.rows) {
      const repositoryToken = row.repository_lock?.token;
      if (repositoryToken && repositoryToken !== row.local_lock?.token) {
        return {
          ...failEnvelope(
            "svn unlock",
            guard.cwd,
            "working copy does not hold the matching repository lock token; use force:true with forceAck:true and operationId to steal it"
          ),
          code: "LOCK_TOKEN_REQUIRED",
          path: row.path,
          repository_locked: true,
          local_token_possession: Boolean(row.local_lock?.token)
        };
      }
    }
  }

  const run = await runSvn([
    "unlock",
    ...(input.force ? ["--force"] : []),
    "--",
    ...guard.paths.map(escapeSvnTarget)
  ], guard.cwd);
  return {
    ...envelopeFromRun({ run, ok: run.exitCode === 0, note: run.exitCode === 0 ? "" : noteFromRun(run) }),
    paths: guard.paths.map((target) => repoRelativePath(target, guard.wcRoot)),
    force: input.force ?? false
  };
}

export async function svnNeedsLock(input: {
  cwd?: string;
  paths: string[];
  action: "set" | "remove";
  riskAck?: boolean;
  operationId?: string;
}): Promise<ToolEnvelope> {
  const cwd = resolveCwd(input.cwd);
  if (readonlyMode()) {
    return failEnvelope("svn needs-lock", cwd, "READONLY instance");
  }
  if (input.action !== "set" && input.action !== "remove") {
    return failEnvelope("svn needs-lock", cwd, "action must be set or remove");
  }
  if (input.action === "remove" && input.riskAck !== true) {
    return {
      ...failEnvelope("svn needs-lock", cwd, "riskAck required to remove svn:needs-lock"),
      code: "RISK_ACK_REQUIRED"
    };
  }

  if (input.operationId) {
    const { operationId, ...coreInput } = input;
    const fingerprint = stableOperationFingerprint({
      kind: "svn_needs_lock",
      cwd: pathIdentityKey(cwd),
      paths: normalizedOperationPaths(cwd, input.paths),
      action: input.action,
      riskAck: input.riskAck ?? false
    });
    return withDurableOperation({
      operationId,
      kind: "svn_needs_lock",
      fingerprint,
      command: "svn needs-lock",
      cwd,
      execute: () => svnNeedsLock(coreInput)
    });
  }

  const guard = await mutatingPathGuard("svn needs-lock", input.cwd, input.paths, { requireExisting: true });
  if (!guard.ok) return guard.envelope;
  for (const target of guard.paths) {
    const stat = statTargetForMutation("svn needs-lock", guard.cwd, target);
    if (!stat.ok) return stat.envelope;
    if (!stat.stat.isFile() || stat.lstat.isSymbolicLink()) {
      return failEnvelope("svn needs-lock", guard.cwd, `svn:needs-lock requires regular versioned files: ${repoRelativePath(target, guard.wcRoot)}`);
    }
    const hit = neverCommitHit(target, guard.wcRoot);
    if (hit) return failEnvelope("svn needs-lock", guard.cwd, neverCommitNote(hit, target, guard.wcRoot));
  }

  const infoRun = await runSvn(["info", "--xml", "--", ...guard.paths.map(escapeSvnTarget)], guard.cwd);
  if (infoRun.exitCode !== 0 || parseInfoXml(infoRun.stdout).length < guard.paths.length) {
    return envelopeFromRun({ run: infoRun, ok: false, note: infoRun.exitCode === 0 ? "target not versioned" : noteFromRun(infoRun) });
  }
  const args = input.action === "set"
    ? ["propset", "--", "svn:needs-lock", "*", ...guard.paths.map(escapeSvnTarget)]
    : ["propdel", "--", "svn:needs-lock", ...guard.paths.map(escapeSvnTarget)];
  const run = await runSvn(args, guard.cwd);
  const status = run.exitCode === 0 ? await svnStatus({ cwd: guard.cwd, paths: guard.paths }) : null;
  return {
    ...envelopeFromRun({
      run,
      ok: run.exitCode === 0,
      changed_paths: status?.changed_paths ?? [],
      conflicts: status?.conflicts ?? [],
      note: run.exitCode === 0 ? "" : noteFromRun(run)
    }),
    property: "svn:needs-lock",
    action: input.action,
    paths: guard.paths.map((target) => repoRelativePath(target, guard.wcRoot))
  };
}

async function prepareAddedFileEol(
  cwd: string,
  wcRoot: string,
  targets: string[],
  targetStats: Map<string, fs.Stats>,
  target: "crlf" | "lf",
  excludes: string[]
) {
  const status = await scopedStatusMap(cwd, wcRoot, targets);
  if (!status.envelope.ok) {
    return {
      ok: false,
      results: [],
      note: status.envelope.note || "unable to identify new files for EOL normalization",
      rollback: () => undefined,
      dispose: () => undefined
    };
  }
  const unversionedRoots = [...status.map.entries()]
    .filter(([, code]) => code === "?")
    .map(([candidate]) => candidate);
  const files = collectAddedFiles(targets, targetStats, unversionedRoots);
  return prepareEolNormalization({
    files,
    target,
    cwd,
    excluded: (filePath) => eolPolicyExcludes(filePath, wcRoot, excludes)
  });
}

function collectAddedFiles(targets: string[], targetStats: Map<string, fs.Stats>, unversionedRoots: string[]): string[] {
  const files: string[] = [];
  const queue: string[] = [];
  for (const target of targets) {
    const stat = targetStats.get(target);
    if (stat?.isFile() && isUnderUnversionedRoot(target, unversionedRoots)) {
      files.push(target);
    } else if (stat?.isDirectory()) {
      queue.push(target);
    }
  }

  let scanned = 0;
  while (queue.length > 0) {
    const directory = queue.shift();
    if (!directory) {
      continue;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      scanned += 1;
      if (scanned > DESCENDANT_SCAN_LIMIT) {
        throw new Error(`EOL add scan exceeds ${DESCENDANT_SCAN_LIMIT} entries`);
      }
      if (entry.name.toLowerCase() === ".svn") {
        continue;
      }
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(candidate);
      } else if (entry.isFile() && isUnderUnversionedRoot(candidate, unversionedRoots)) {
        files.push(candidate);
      }
    }
  }
  return files;
}

function isUnderUnversionedRoot(candidate: string, roots: string[]): boolean {
  const key = pathIdentityKey(candidate);
  return roots.some((root) => key === root || key.startsWith(root + path.sep));
}

function summarizeEolNormalization(
  results: Array<{ converted?: boolean; verified?: boolean; skipped?: string; failure?: string }>,
  target: "crlf" | "lf"
): Record<string, unknown> {
  return {
    target,
    converted: results.filter((result) => result.converted === true).length,
    verified: results.filter((result) => result.verified === true).length,
    skipped: results.filter((result) => result.skipped !== undefined).length,
    failed: results.filter((result) => result.failure !== undefined).length
  };
}

function compactEolNormalizationFiles(
  results: EolNormalizationResult[],
  wcRoot: string
): Array<Record<string, unknown>> {
  return results.map((result) => ({
    ...result,
    path: typeof result.path === "string" ? repoRelativePath(result.path, wcRoot) : result.path
  }));
}

export async function svnCommit(input: {
  cwd?: string;
  paths: string[];
  message: string;
  riskAck?: boolean;
  allowRoot?: boolean;
  allowDirectoryTargets?: boolean;
  expandDescendants?: boolean;
  operationId?: string;
  precommitToken?: string;
}): Promise<ToolEnvelope> {
  if (input.operationId) {
    const { operationId, ...coreInput } = input;
    const cwd = resolveCwd(input.cwd);
    const fingerprint = stableOperationFingerprint({
      kind: "svn_commit",
      cwd: pathIdentityKey(cwd),
      paths: normalizedOperationPaths(cwd, input.paths),
      messageHash: createHash("sha256").update(normalizedCommitMessage(input.message)).digest("hex"),
      riskAck: input.riskAck ?? false,
      allowRoot: input.allowRoot ?? false,
      allowDirectoryTargets: input.allowDirectoryTargets ?? false,
      expandDescendants: input.expandDescendants ?? false,
      precommitToken: input.precommitToken ?? null
    });
    return withDurableOperation({
      operationId,
      kind: "svn_commit",
      fingerprint,
      command: "svn commit",
      cwd,
      execute: () => svnCommit(coreInput),
      recoverStale: ({ createdAt }) => recoverCommittedOperation(coreInput, createdAt)
    });
  }
  const guard = await mutatingPathGuard("svn commit", input.cwd, input.paths, { requireExisting: false });
  if (!guard.ok) {
    return guard.envelope;
  }
  if (!input.message.trim()) {
    return failEnvelope("svn commit", guard.cwd, "non-empty commit message required");
  }
  const messageValidation = validateCommitMessage(input.message);
  if (!messageValidation.valid) {
    return {
      ...failEnvelope("svn commit", guard.cwd, messageValidation.warningDetail),
      warning_code: messageValidation.warningCode,
      failed_rule: messageValidation.failedRule,
      warning_detail: messageValidation.warningDetail,
      suggested_message: messageValidation.suggestedMessage,
      blocking: messageValidation.blocking
    };
  }
  if (!input.allowRoot && guard.paths.some((target) => pathIdentityKey(target) === pathIdentityKey(guard.wcRoot))) {
    return failEnvelope("svn commit", guard.cwd, "working-copy root commit requires allowRoot:true");
  }
  const scope = await resolveCommitScope({
    cwd: guard.cwd,
    wcRoot: guard.wcRoot,
    paths: guard.paths,
    ...(input.expandDescendants === undefined ? {} : { expandDescendants: input.expandDescendants }),
    ...(input.allowDirectoryTargets === undefined ? {} : { allowDirectoryTargets: input.allowDirectoryTargets })
  });
  if (!scope.ok) {
    return {
      ...(scope.envelope ?? failEnvelope("svn commit", guard.cwd, scope.note)),
      ...(scope.expanded ? { scope_expanded: true, expanded_paths: scope.expandedPaths } : {})
    };
  }
  if (scope.paths.length === 0) {
    return {
      ...failEnvelope("svn commit", guard.cwd, "nothing to commit in expanded directory scope"),
      scope_expanded: scope.expanded,
      expanded_paths: scope.expandedPaths
    };
  }

  const scopedPaths = scope.paths;
  for (const target of scopedPaths) {
    const hit = neverCommitHit(target, guard.wcRoot);
    if (hit) {
      return failEnvelope("svn commit", guard.cwd, neverCommitNote(hit, target, guard.wcRoot));
    }
  }

  if (input.precommitToken) {
    const binding = await validatePrecommitBinding(
      input.precommitToken,
      guard.cwd,
      guard.wcRoot,
      guard.repoRoot,
      scopedPaths
    );
    if (!binding.ok) return binding.envelope;
  }

  const status = await scopedStatusMap(guard.cwd, guard.wcRoot, statusPathsForCommit(scopedPaths, guard.wcRoot));
  if (!status.envelope.ok) {
    return status.envelope;
  }

  const conflictedTargets = new Set(
    status.envelope.conflicts.map((conflict) => pathIdentityKey(path.resolve(guard.cwd, conflict.path)))
  );
  for (const target of scopedPaths) {
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

  const riskSignals = riskySignals(scopedPaths, guard.wcRoot, status.map);
  if (riskSignals.length > 0 && !input.riskAck) {
    return {
      ...failEnvelope("svn commit", guard.cwd, `riskAck required: ${riskSignals.join(", ")}`),
      risk_signals: riskSignals
    };
  }
  const commitPaths = commitPathsWithAddedParents(scopedPaths, guard.wcRoot, status.map);
  for (const target of commitPaths) {
    const hit = neverCommitHit(target, guard.wcRoot);
    if (hit) {
      return failEnvelope("svn commit", guard.cwd, neverCommitNote(hit, target, guard.wcRoot));
    }
  }

  const warnings: string[] = [];
  const version = await runSvnVersion(guard.wcRoot, guard.cwd);
  const baseVersion = version.exitCode === 0 ? parseSvnVersion(version.stdout) : null;
  if (baseVersion?.mixed) {
    warnings.push("mixed revision working copy");
  }
  const observedRemoteHeadBefore = await remoteHeadForTargets(guard.cwd, scopedPaths);
  const committedPaths = commitPaths.map((target) => repoRelativePath(target, guard.wcRoot));
  const explicitPaths = guard.paths.map((target) => repoRelativePath(target, guard.wcRoot));
  const preCommitChanges = commitPaths.map((target) => ({
    path: repoRelativePath(target, guard.wcRoot),
    status: status.map.get(pathIdentityKey(target)) ?? "M"
  }));
  const contentHashes = await hashCommitTargets(scopedPaths, guard.wcRoot);
  if (!contentHashes.ok) {
    return failEnvelope("svn commit", guard.cwd, contentHashes.note);
  }

  if (input.precommitToken) {
    const binding = await validatePrecommitBinding(
      input.precommitToken,
      guard.cwd,
      guard.wcRoot,
      guard.repoRoot,
      scopedPaths
    );
    if (!binding.ok) return binding.envelope;
  }

  const messageTemp = writeMessageTemp("svn-agent-commit-", input.message);

  try {
    const run = await runSvn(["commit", "-F", messageTemp.file, "--depth", "empty", "--", ...commitPaths.map(escapeSvnTarget)], guard.cwd);
    const revision = parseCommittedRevision(`${run.stdout}\n${run.stderr}`);
    const commitSucceeded = run.exitCode === 0 && revision !== null;
    const outOfDate = commitSucceeded
      ? null
      : await diagnoseOutOfDateCommit(run, guard.cwd, guard.wcRoot, commitPaths);
    const deletedPaths = new Set(preCommitChanges
      .filter((entry) => entry.status === "D")
      .map((entry) => pathIdentityKey(path.resolve(guard.wcRoot, entry.path))));
    const postStatusTargets = commitPaths.filter((target) => !deletedPaths.has(pathIdentityKey(target)));
    const postStatus = commitSucceeded && postStatusTargets.length > 0
      ? await svnStatus({ cwd: guard.cwd, paths: postStatusTargets, depth: "empty" })
      : null;
    const postStatusClean = commitSucceeded && (postStatusTargets.length === 0
      || Boolean(postStatus?.ok && postStatus.changed_paths.length === 0 && postStatus.conflicts.length === 0));
    const workingCopyStatus = commitSucceeded ? await svnStatus({ cwd: guard.wcRoot }) : null;
    const workingCopyClean = workingCopyStatus?.ok
      ? workingCopyStatus.changed_paths.length === 0 && workingCopyStatus.conflicts.length === 0
      : null;
    const postVersionRun = commitSucceeded ? await runSvnVersion(guard.wcRoot, guard.cwd) : null;
    const postVersion = postVersionRun?.exitCode === 0 ? parseSvnVersion(postVersionRun.stdout) : null;
    const reportedVersion = postVersion ?? baseVersion;
    const failureNote = outOfDate
      ? Number(outOfDate.out_of_date_path_count) > 0
        ? "commit blocked by out-of-date paths; run svn_update for the listed paths, resolve conflicts, then retry"
        : "commit blocked by an out-of-date condition; exact paths unavailable; update the explicit commit scope, resolve conflicts, then retry"
      : run.exitCode !== 0
        ? noteFromRun(run)
        : revision === null
          ? "svn reported success without a committed revision"
          : "";
    const noteParts = [
      failureNote,
      ...(outOfDate ? [] : warnings),
      commitSucceeded && !postStatusClean ? "committed-path post-status has residue" : "",
      commitSucceeded && workingCopyClean === false ? "working copy has uncommitted changes" : "",
      commitSucceeded && workingCopyClean === null ? "whole-working-copy post-status unavailable" : ""
    ].filter(Boolean);
    const boundedPostStatusPaths = committedPaths.slice(0, POST_STATUS_PATH_LIMIT);

    return {
      ...envelopeFromRun({
        run,
        ok: commitSucceeded,
        revision,
        changed_paths: commitSucceeded ? preCommitChanges : [],
        conflicts: postStatus?.conflicts ?? [],
        note: noteParts.join("; ")
      }),
      wc_root: guard.wcRoot,
      revision,
      committed_revision: revision,
      committed_paths: commitSucceeded ? committedPaths : [],
      explicit_paths: explicitPaths,
      committed_count: commitSucceeded ? committedPaths.length : 0,
      path_count: explicitPaths.length,
      base_revision: baseVersion?.range && !baseVersion.mixed ? baseVersion.range.max : null,
      base_revision_range: baseVersion?.range ?? null,
      observed_remote_head_before: observedRemoteHeadBefore,
      remote_head_revision: revision ?? observedRemoteHeadBefore,
      eol_verdict: "not_checked",
      content_hashes: contentHashes.hashes,
      content_hashes_truncated: false,
      post_status: postStatus?.changed_paths ?? [],
      post_status_clean: postStatusClean,
      ...(commitSucceeded
        ? {
            post_status_scope: "committed-paths",
            post_status_paths: boundedPostStatusPaths,
            post_status_path_count: committedPaths.length,
            ...(committedPaths.length > boundedPostStatusPaths.length ? { post_status_paths_truncated: true } : {}),
            working_copy_clean: workingCopyClean
          }
        : {}),
      working_copy_mixed: reportedVersion?.mixed ?? null,
      mixed_revision: reportedVersion?.mixed ?? null,
      revision_range: reportedVersion?.range ?? null,
      risk_signals: riskSignals,
      ...(outOfDate ?? {}),
      ...(input.precommitToken ? { precommit_token: input.precommitToken } : {}),
      ...(scope.expanded ? { scope_expanded: true, expanded_paths: scope.expandedPaths } : {})
    };
  } finally {
    fs.rmSync(messageTemp.dir, { recursive: true, force: true });
  }
}

async function diagnoseOutOfDateCommit(
  commitRun: RunResult,
  cwd: string,
  wcRoot: string,
  commitPaths: string[]
): Promise<Record<string, unknown> | null> {
  const commitOutput = `${commitRun.stderr}\n${commitRun.stdout}`;
  if (!commitFailureReportsOutOfDate(commitOutput)) {
    return null;
  }

  const statusRun = await runSvn([
    "status",
    "--show-updates",
    "--xml",
    "--depth",
    "empty",
    "--",
    ...commitPaths.map(escapeSvnTarget)
  ], cwd);
  let repositoryChangedPaths: string[] = [];
  let statusProbeIncomplete = statusRun.exitCode !== 0 || statusRun.truncated === true;
  if (statusRun.exitCode === 0 && !statusRun.truncated) {
    try {
      repositoryChangedPaths = parseStatusXml(statusRun.stdout).out_of_date_paths;
    } catch {
      statusProbeIncomplete = true;
    }
  }

  return classifyOutOfDateCommitEvidence({
    commitOutput,
    repositoryChangedPaths,
    statusProbeIncomplete,
    cwd,
    wcRoot
  });
}

export function classifyOutOfDateCommitEvidence(input: {
  commitOutput: string;
  repositoryChangedPaths: string[];
  statusProbeIncomplete: boolean;
  cwd: string;
  wcRoot: string;
}): Record<string, unknown> | null {
  if (!commitFailureReportsOutOfDate(input.commitOutput)) {
    return null;
  }

  const candidates = input.repositoryChangedPaths.map((candidate) =>
    path.isAbsolute(candidate) ? candidate : path.resolve(input.cwd, candidate)
  );
  const relativePaths = uniqueRelativePaths(candidates, input.wcRoot);
  const boundedPaths = relativePaths.slice(0, OUT_OF_DATE_PATH_LIMIT);
  const diagnosisUnavailableReason = input.statusProbeIncomplete
    ? relativePaths.length > 0
      ? "bounded status probe was incomplete; exact out-of-date path list may be partial"
      : "commit reported an out-of-date condition, but the bounded status probe was incomplete and found no exact paths"
    : relativePaths.length === 0
      ? "commit reported an out-of-date condition, but the bounded status probe found no exact paths"
      : null;
  return {
    code: "OUT_OF_DATE",
    guard_code: "OUT_OF_DATE",
    out_of_date_paths: boundedPaths,
    out_of_date_path_count: relativePaths.length,
    out_of_date_paths_truncated: input.statusProbeIncomplete || relativePaths.length > boundedPaths.length,
    ...(diagnosisUnavailableReason ? { out_of_date_diagnosis_unavailable_reason: diagnosisUnavailableReason } : {})
  };
}

function commitFailureReportsOutOfDate(output: string): boolean {
  return /\b(?:E155011|E160028)\b/i.test(output);
}

function uniqueRelativePaths(paths: string[], wcRoot: string): string[] {
  const unique = new Map<string, string>();
  for (const candidate of paths) {
    if (!isInsideOrEqual(candidate, wcRoot)) {
      continue;
    }
    const relative = repoRelativePath(candidate, wcRoot);
    unique.set(pathIdentityKey(candidate), relative);
  }
  return [...unique.values()].sort((left, right) => left.localeCompare(right));
}

async function hashCommitTargets(
  targets: string[],
  wcRoot: string
): Promise<{ ok: true; hashes: Array<Record<string, unknown>> } | { ok: false; note: string }> {
  const budget = await regularFileBytesWithinBudget(targets, currentRequestCancellationSignal());
  if (!budget.ok) {
    return {
      ok: false,
      note: `commit content hashing exceeds ${budget.maxBytes} byte aggregate limit; narrow the explicit path scope or raise SVN_MCP_MAX_HASH_BYTES`
    };
  }
  const hashes = await mapWithConcurrency(targets, configuredHashConcurrency(), async (target) => {
    const relative = repoRelativePath(target, wcRoot);
    try {
      const stat = await fs.promises.stat(target);
      if (!stat.isFile()) {
        return { path: relative, algorithm: "sha256", hash: null, unavailable_reason: "not a regular file" };
      }
      return {
        path: relative,
        algorithm: "sha256",
        hash: await sha256File(target, currentRequestCancellationSignal())
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      return { path: relative, algorithm: "sha256", hash: null, unavailable_reason: "path unavailable" };
    }
  });
  return { ok: true, hashes };
}

async function validatePrecommitBinding(
  token: string,
  cwd: string,
  wcRoot: string,
  repositoryRoot: string | null,
  scopedPaths: string[]
): Promise<{ ok: true } | { ok: false; envelope: ToolEnvelope }> {
  const evidence = processWorkflowEvidence.get(token, "precommit", workflowScope(wcRoot, scopedPaths));
  if (!evidence.ok) {
    return {
      ok: false,
      envelope: workflowFailure("svn commit", cwd, `PRECOMMIT_${evidence.code}`, evidence.note)
    };
  }
  const record = evidence.record;
  const expectedStates = parseWorkflowPathStates(record.paths);
  if (!expectedStates) {
    return {
      ok: false,
      envelope: workflowFailure("svn commit", cwd, "PRECOMMIT_INVALID", "precommit path evidence is invalid")
    };
  }
  if (record.repositoryRoot !== repositoryRoot) {
    return {
      ok: false,
      envelope: workflowFailure("svn commit", cwd, "PRECOMMIT_REPOSITORY_MISMATCH", "precommit evidence belongs to another repository")
    };
  }
  if (record.policyIdentity !== workflowPolicyIdentity(wcRoot)) {
    return {
      ok: false,
      envelope: workflowFailure("svn commit", cwd, "PRECOMMIT_POLICY_CHANGED", "repository policy changed after precommit")
    };
  }
  if (typeof record.eolPolicyIdentity !== "string"
    || record.eolPolicyIdentity !== workflowEolPolicyIdentity(wcRoot)) {
    return {
      ok: false,
      envelope: workflowFailure("svn commit", cwd, "PRECOMMIT_EOL_POLICY_CHANGED", "EOL policy changed after precommit")
    };
  }
  if (typeof record.diffIdentity !== "string" || !/^sha256:[0-9a-f]{64}$/i.test(record.diffIdentity)) {
    return {
      ok: false,
      envelope: workflowFailure("svn commit", cwd, "PRECOMMIT_INVALID", "precommit diff evidence is invalid")
    };
  }
  const current = await captureCurrentWorkflowPathStates(cwd, wcRoot, scopedPaths);
  if (!current.ok) {
    return {
      ok: false,
      envelope: workflowFailure("svn commit", cwd, "PRECOMMIT_STATE_UNAVAILABLE", current.note)
    };
  }
  if (!workflowStatesEqual(expectedStates, current.states)) {
    return {
      ok: false,
      envelope: workflowFailure("svn commit", cwd, "PRECOMMIT_STATE_CHANGED", "commit paths changed after precommit; rerun svn_precommit")
    };
  }
  const diff = await svnDiff({ cwd, paths: scopedPaths, ignoreEol: true, lineLimit: 1 });
  if (!diff.ok) {
    return {
      ok: false,
      envelope: workflowFailure("svn commit", cwd, "PRECOMMIT_DIFF_UNAVAILABLE", "could not revalidate the bound diff; rerun svn_precommit")
    };
  }
  if (workflowDiffIdentity(diff) !== record.diffIdentity) {
    return {
      ok: false,
      envelope: workflowFailure("svn commit", cwd, "PRECOMMIT_DIFF_CHANGED", "verified diff changed after precommit; rerun svn_precommit")
    };
  }
  const stateAfterDiff = await captureCurrentWorkflowPathStates(cwd, wcRoot, scopedPaths);
  if (!stateAfterDiff.ok || !workflowStatesEqual(current.states, stateAfterDiff.states)) {
    return {
      ok: false,
      envelope: workflowFailure("svn commit", cwd, "PRECOMMIT_STATE_CHANGED", "commit paths changed during precommit validation; rerun svn_precommit")
    };
  }
  const expectedRemoteHead = record.remoteHeadRevision;
  if (expectedRemoteHead !== null && typeof expectedRemoteHead !== "number") {
    return {
      ok: false,
      envelope: workflowFailure("svn commit", cwd, "PRECOMMIT_INVALID", "precommit remote revision evidence is invalid")
    };
  }
  const observedRemoteHead = await remoteHeadForTargets(cwd, scopedPaths)
    ?? await remoteHeadForTargets(cwd, [repositoryRoot ?? wcRoot]);
  if (observedRemoteHead === null || observedRemoteHead !== expectedRemoteHead) {
    return {
      ok: false,
      envelope: {
        ...workflowFailure("svn commit", cwd, "PRECOMMIT_REMOTE_HEAD_CHANGED", "repository HEAD changed after precommit; update and rerun svn_precommit"),
        expected_remote_head: expectedRemoteHead,
        observed_remote_head: observedRemoteHead
      }
    };
  }
  return { ok: true };
}

function baselineCollisionReceipt(
  token: string,
  cwd: string,
  wcRoot: string,
  targets: string[],
  baselineStates: WorkflowPathState[],
  beforeStates: WorkflowPathState[],
  changedPaths: ChangedPath[],
  conflicts: Conflict[]
): Record<string, unknown> {
  const baselineByPath = new Map(baselineStates.map((state) => [pathIdentityKey(path.resolve(wcRoot, state.path)), state]));
  const beforeByPath = new Map(beforeStates.map((state) => [pathIdentityKey(path.resolve(wcRoot, state.path)), state]));
  const changed = changedPaths.map((entry) => path.resolve(cwd, entry.path));
  const conflicted = conflicts.filter((entry) => entry.path.trim().length > 0).map((entry) => path.resolve(cwd, entry.path));
  const pathStates = targets.map((target) => {
    const baseline = baselineByPath.get(pathIdentityKey(target));
    const before = beforeByPath.get(pathIdentityKey(target));
    const stateChanged = Boolean(baseline && before && !workflowStatesEqual([baseline], [before]));
    const locallyModified = Boolean(before && (
      isCommittableStatus(before.status)
      || (stateChanged && baseline && (before.status !== "" || before.baseRevision === baseline.baseRevision))
    ));
    const remotelyChanged = changed.some((candidate) => pathsOverlap(candidate, target));
    const conflictPostponed = conflicted.some((candidate) => pathsOverlap(candidate, target));
    const collision = conflictPostponed || (locallyModified && remotelyChanged);
    return {
      path: repoRelativePath(target, wcRoot),
      base_revision: baseline?.baseRevision ?? null,
      locally_modified_before_update: locallyModified,
      remotely_changed_during_update: remotelyChanged,
      same_path_collision: collision,
      conflict_postponed: conflictPostponed
    };
  });
  const collisionPaths = pathStates
    .filter((state) => state.same_path_collision)
    .map((state) => state.path);
  return {
    baseline_token: token,
    collision: collisionPaths.length > 0,
    collision_paths: collisionPaths,
    path_states: pathStates,
    ...(collisionPaths.length > 0 ? { recommended_action: "reconcile-and-reverify" } : {})
  };
}

function pathsOverlap(left: string, right: string): boolean {
  return isInsideOrEqual(left, right) || isInsideOrEqual(right, left);
}

function workflowFailure(command: string, cwd: string, code: string, note: string): ToolEnvelope {
  return { ...failEnvelope(command, cwd, note), code };
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

export async function svnPathChange(input: {
  cwd?: string;
  action: "move" | "rename" | "copy";
  src: string;
  dest: string;
}): Promise<ToolEnvelope> {
  if (input.action === "copy") {
    return svnCopy(input);
  }
  return input.action === "rename" ? svnRename(input) : svnMove(input);
}

export async function svnUpdate(input: {
  cwd?: string;
  paths?: string[];
  updateAll?: boolean;
  revision?: string;
  expectedRemoteHead?: number;
  taskPaths?: string[];
  targetOverlapOnly?: boolean;
  depth?: "empty";
  operationId?: string;
  baselineToken?: string;
  skipAdded?: boolean;
}): Promise<ToolEnvelope> {
  if (input.operationId) {
    const { operationId, ...coreInput } = input;
    const cwd = resolveCwd(input.cwd);
    const fingerprint = stableOperationFingerprint({
      kind: "svn_update",
      cwd: pathIdentityKey(cwd),
      paths: normalizedOperationPaths(cwd, input.paths ?? []),
      updateAll: input.updateAll ?? false,
      revision: input.revision ?? null,
      expectedRemoteHead: input.expectedRemoteHead ?? null,
      taskPaths: normalizedOperationPaths(cwd, input.taskPaths ?? []),
      targetOverlapOnly: input.targetOverlapOnly ?? false,
      depth: input.depth ?? null,
      baselineToken: input.baselineToken ?? null,
      skipAdded: input.skipAdded ?? false
    });
    return withDurableOperation({
      operationId,
      kind: "svn_update",
      fingerprint,
      command: "svn update",
      cwd,
      execute: () => svnUpdate(coreInput)
    });
  }
  const cwd = resolveCwd(input.cwd);
  if (readonlyMode()) {
    return failEnvelope("svn update", cwd, "READONLY instance");
  }
  if ((!input.paths || input.paths.length === 0) && !input.updateAll) {
    return failEnvelope("svn update", cwd, "explicit paths required or updateAll:true");
  }
  const revisionError = revisionSelectorError(input.revision, false);
  if (revisionError) {
    return failEnvelope("svn update", cwd, revisionError);
  }
  if (input.expectedRemoteHead !== undefined
    && (!Number.isSafeInteger(input.expectedRemoteHead) || input.expectedRemoteHead < 0)) {
    return failEnvelope("svn update", cwd, "expectedRemoteHead must be a non-negative safe integer");
  }
  if (input.expectedRemoteHead !== undefined && !/^\d+$/.test(input.revision ?? "")) {
    return failEnvelope("svn update", cwd, "expectedRemoteHead requires an explicit numeric revision");
  }
  if (input.baselineToken && (!input.paths || input.paths.length === 0 || input.updateAll)) {
    return workflowFailure(
      "svn update",
      cwd,
      "BASELINE_SCOPE_REQUIRED",
      "baselineToken requires the same explicit paths used to capture the baseline"
    );
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
  if (input.taskPaths && input.taskPaths.length > 0) {
    const taskPaths = resolveTargetsInsideWc(context.cwd, context.wcRoot, input.taskPaths);
    if (!taskPaths.ok) {
      return failEnvelope("svn update", context.cwd, taskPaths.note);
    }
  }

  let baselineStates: WorkflowPathState[] | null = null;
  let beforeStates: WorkflowPathState[] | null = null;
  if (input.baselineToken) {
    const evidence = processWorkflowEvidence.get(
      input.baselineToken,
      "baseline",
      workflowScope(context.wcRoot, targets)
    );
    if (!evidence.ok) {
      return workflowFailure("svn update", context.cwd, `BASELINE_${evidence.code}`, evidence.note);
    }
    const record = evidence.record;
    baselineStates = parseWorkflowPathStates(record.paths);
    if (!baselineStates) {
      return workflowFailure("svn update", context.cwd, "BASELINE_INVALID", "baseline path evidence is invalid");
    }
    if (typeof record.wcRoot !== "string" || pathIdentityKey(record.wcRoot) !== pathIdentityKey(context.wcRoot)
      || record.repositoryRoot !== context.info.repo_root) {
      return workflowFailure("svn update", context.cwd, "BASELINE_REPOSITORY_MISMATCH", "baseline belongs to another working copy or repository");
    }
    if (record.policyIdentity !== workflowPolicyIdentity(context.wcRoot)) {
      return workflowFailure("svn update", context.cwd, "BASELINE_POLICY_CHANGED", "repository policy changed after the baseline was captured");
    }
    const captured = await captureCurrentWorkflowPathStates(context.cwd, context.wcRoot, targets);
    if (!captured.ok) {
      return workflowFailure("svn update", context.cwd, "BASELINE_CAPTURE_FAILED", captured.note);
    }
    beforeStates = captured.states;
  }

  let updateTargets = targets;
  let skippedAddedPaths: string[] = [];
  if (input.skipAdded && targets.length > 0) {
    const status = await scopedStatusMap(context.cwd, context.wcRoot, targets);
    if (!status.envelope.ok) return status.envelope;
    updateTargets = targets.filter((target) => status.map.get(pathIdentityKey(target)) !== "A");
    skippedAddedPaths = targets
      .filter((target) => status.map.get(pathIdentityKey(target)) === "A")
      .map((target) => repoRelativePath(target, context.wcRoot));
  }

  const updateScope = await captureUpdateScope(
    context.cwd,
    targets,
    input.updateAll === true
  );

  let observedRemoteHead: number | null | undefined;
  if (input.expectedRemoteHead !== undefined) {
    observedRemoteHead = await remoteHeadForTargets(
      context.cwd,
      updateTargets.length > 0 ? updateTargets : [context.info.repo_root ?? context.wcRoot]
    ) ?? await remoteHeadForTargets(context.cwd, [context.info.repo_root ?? context.wcRoot]);
    if (observedRemoteHead === null) {
      return {
        ...failEnvelope("svn update", context.cwd, "could not verify remote HEAD before update"),
        expected_remote_head: input.expectedRemoteHead,
        observed_remote_head: null
      };
    }
    if (observedRemoteHead !== input.expectedRemoteHead) {
      return {
        ...failEnvelope(
          "svn update",
          context.cwd,
          `remote HEAD changed: expected ${input.expectedRemoteHead}, observed ${observedRemoteHead}`
        ),
        expected_remote_head: input.expectedRemoteHead,
        observed_remote_head: observedRemoteHead
      };
    }
  }

  const run: RunResult = updateTargets.length === 0 && skippedAddedPaths.length > 0
    ? {
        command: "svn update (scheduled-add targets skipped)",
        cwd: context.cwd,
        executable: "svn",
        args: [],
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false
      }
    : await runSvn([
        "update",
        ...(input.revision ? ["-r", input.revision] : []),
        ...(input.depth ? ["--depth", input.depth] : []),
        "--accept",
        "postpone",
        ...(updateTargets.length > 0 ? ["--", ...updateTargets.map(escapeSvnTarget)] : [])
      ], context.cwd);
  const parsed = parseUpdateText(`${run.stdout}\n${run.stderr}`);
  const version = run.exitCode === 0 ? await runSvnVersion(context.wcRoot, context.cwd) : null;
  const versionState = version?.exitCode === 0 ? parseSvnVersion(version.stdout) : null;
  const resultingRevision = versionState?.range && versionState.range.min === versionState.range.max
    ? versionState.range.min
    : null;
  const scopeReceipt = run.exitCode === 0
    ? await finalizeUpdateScope(updateScope, context.cwd, context.wcRoot, input.revision ?? "HEAD")
    : updateScopeReceipt(updateScope);
  const baselineReceipt = input.baselineToken && baselineStates && beforeStates
    ? baselineCollisionReceipt(
        input.baselineToken,
        context.cwd,
        context.wcRoot,
        targets,
        baselineStates,
        beforeStates,
        parsed.changed_paths,
        parsed.conflicts
      )
    : {};
  return {
    ...envelopeFromRun({
      run,
      ok: run.exitCode === 0,
      revision: resultingRevision,
      changed_paths: parsed.changed_paths,
      conflicts: parsed.conflicts,
      note: parsed.conflicts.length > 0 ? "conflicts present" : run.exitCode === 0 ? "" : noteFromRun(run)
    }),
    requested_revision: input.revision ?? null,
    resulting_revision: resultingRevision,
    revision_range: versionState?.range ?? null,
    mixed_revision: versionState?.mixed ?? false,
    wc_root: context.wcRoot,
    ...scopeReceipt,
    ...baselineReceipt,
    ...(skippedAddedPaths.length > 0 ? { skipped_added_paths: skippedAddedPaths } : {}),
    ...(input.expectedRemoteHead !== undefined
      ? { expected_remote_head: input.expectedRemoteHead, observed_remote_head: observedRemoteHead ?? null }
      : {})
  };
}

type UpdateScope = {
  kind: "working-copy" | "directory" | "exact-file" | "unknown";
  parentSnapshots: Array<{
    localDirectory: string;
    repositoryUrl: string;
    baseRevision: number;
  }>;
  parentCount: number;
  parentsTruncated: boolean;
  unavailable: boolean;
};

export function classifyUpdateScopeFromInfo(
  cwd: string,
  targets: string[],
  entries: Array<Pick<WcInfo, "path" | "kind">>
): UpdateScope["kind"] {
  if (targets.length === 0) {
    return "unknown";
  }
  const entriesByPath = new Map<string, Pick<WcInfo, "path" | "kind">>();
  for (const entry of entries) {
    if (!entry.path) continue;
    const candidate = path.isAbsolute(entry.path) ? entry.path : path.resolve(cwd, entry.path);
    entriesByPath.set(pathIdentityKey(candidate), entry);
  }
  const kinds = targets.map((target) => entriesByPath.get(pathIdentityKey(target))?.kind ?? null);
  return kinds.every((kind) => kind === "file")
    ? "exact-file"
    : kinds.every((kind) => kind === "dir")
      ? "directory"
      : "unknown";
}

async function captureUpdateScope(
  cwd: string,
  targets: string[],
  updateAll: boolean
): Promise<UpdateScope> {
  if (updateAll || targets.length === 0) {
    return {
      kind: "working-copy",
      parentSnapshots: [],
      parentCount: 0,
      parentsTruncated: false,
      unavailable: false
    };
  }

  const metadataRun = await runSvn([
    "info",
    "--xml",
    "--depth",
    "empty",
    "--",
    ...targets.map(escapeSvnTarget)
  ], cwd);
  let classifiedKind: UpdateScope["kind"] = "unknown";
  if (metadataRun.exitCode === 0 && !metadataRun.truncated) {
    try {
      const entries = parseInfoXml(metadataRun.stdout);
      classifiedKind = classifyUpdateScopeFromInfo(cwd, targets, entries);
    } catch {
      classifiedKind = "unknown";
    }
  }
  if (classifiedKind !== "exact-file") {
    return {
      kind: classifiedKind,
      parentSnapshots: [],
      parentCount: 0,
      parentsTruncated: false,
      unavailable: classifiedKind === "unknown"
    };
  }

  const allParents = new Map<string, string>();
  for (const target of targets) {
    const directory = path.dirname(target);
    allParents.set(pathIdentityKey(directory), directory);
  }
  const selectedParents = [...allParents.values()].slice(0, UPDATE_SCOPE_PARENT_LIMIT);
  const parentSnapshots: UpdateScope["parentSnapshots"] = [];
  let unavailable = false;
  for (const localDirectory of selectedParents) {
    const infoRun = await runSvn(["info", "--xml", "--", escapeSvnTarget(localDirectory)], cwd);
    if (infoRun.exitCode !== 0 || infoRun.truncated) {
      unavailable = true;
      continue;
    }
    try {
      const info = parseInfoXml(infoRun.stdout)[0];
      if (!info?.url || info.revision === null) {
        unavailable = true;
        continue;
      }
      parentSnapshots.push({
        localDirectory,
        repositoryUrl: info.url,
        baseRevision: info.revision
      });
    } catch {
      unavailable = true;
    }
  }

  return {
    kind: "exact-file",
    parentSnapshots,
    parentCount: allParents.size,
    parentsTruncated: allParents.size > selectedParents.length,
    unavailable
  };
}

function updateScopeReceipt(scope: UpdateScope): Record<string, unknown> {
  if (scope.kind === "working-copy" || scope.kind === "directory") {
    return { scope_kind: scope.kind, scope_complete: true };
  }
  if (scope.kind === "unknown") {
    return {
      scope_kind: "unknown",
      scope_complete: false,
      omitted_repository_additions: [],
      omitted_repository_additions_truncated: true,
      recommended_action: "inspect-target-metadata",
      scope_check_unavailable_reason: "target kind unavailable from bounded SVN info probe"
    };
  }
  return {
    scope_kind: scope.kind,
    scope_complete: false,
    omitted_repository_additions: [],
    omitted_repository_additions_truncated: scope.parentsTruncated,
    recommended_action: "update-containing-directory",
    ...((scope.unavailable || scope.parentsTruncated)
      ? { scope_check_unavailable_reason: "bounded containing-directory comparison was incomplete" }
      : {})
  };
}

async function finalizeUpdateScope(
  scope: UpdateScope,
  cwd: string,
  wcRoot: string,
  targetRevision: string
): Promise<Record<string, unknown>> {
  if (scope.kind !== "exact-file") {
    return updateScopeReceipt(scope);
  }

  const omitted = new Map<string, string>();
  let comparisonIncomplete = scope.unavailable || scope.parentsTruncated;
  for (const snapshot of scope.parentSnapshots) {
    const base = await repositoryDirectoryEntries(cwd, snapshot.repositoryUrl, String(snapshot.baseRevision));
    const target = await repositoryDirectoryEntries(cwd, snapshot.repositoryUrl, targetRevision);
    if (!base.ok || !target.ok || base.truncated || target.truncated) {
      comparisonIncomplete = true;
      continue;
    }
    const baseNames = new Set(base.names);
    for (const name of target.names) {
      if (baseNames.has(name) || !isImmediateRepositoryName(name)) {
        continue;
      }
      const localCandidate = path.resolve(snapshot.localDirectory, name);
      if (!isInsideOrEqual(localCandidate, snapshot.localDirectory)
        || !isInsideOrEqual(localCandidate, wcRoot)
        || fs.existsSync(localCandidate)) {
        continue;
      }
      omitted.set(pathIdentityKey(localCandidate), repoRelativePath(localCandidate, wcRoot));
    }
  }

  const allOmitted = [...omitted.values()].sort((left, right) => left.localeCompare(right));
  const boundedOmitted = allOmitted.slice(0, UPDATE_OMITTED_ADDITION_LIMIT);
  const truncated = comparisonIncomplete || allOmitted.length > boundedOmitted.length;
  return {
    scope_kind: "exact-file",
    scope_complete: false,
    omitted_repository_additions: boundedOmitted,
    omitted_repository_addition_count: allOmitted.length,
    omitted_repository_additions_truncated: truncated,
    recommended_action: "update-containing-directory",
    ...(comparisonIncomplete
      ? { scope_check_unavailable_reason: "bounded containing-directory comparison was incomplete" }
      : {})
  };
}

async function repositoryDirectoryEntries(
  cwd: string,
  repositoryUrl: string,
  revision: string
): Promise<{ ok: boolean; names: string[]; truncated: boolean }> {
  const run = await runSvn([
    "list",
    "--xml",
    "--depth",
    "immediates",
    "-r",
    revision,
    "--",
    escapeSvnTarget(repositoryUrl)
  ], cwd);
  if (run.exitCode !== 0 || run.truncated) {
    return { ok: false, names: [], truncated: run.truncated === true };
  }
  try {
    const parsed = parseListXml(run.stdout, UPDATE_SCOPE_ENTRY_LIMIT);
    return {
      ok: true,
      names: parsed.entries.map((entry) => entry.name),
      truncated: parsed.truncated
    };
  } catch {
    return { ok: false, names: [], truncated: false };
  }
}

function isImmediateRepositoryName(value: string): boolean {
  return value !== "." && value !== ".." && !/[\\/]/.test(value);
}

export async function svnRevert(input: {
  cwd?: string;
  paths: string[];
  allowRecursive?: boolean;
  dryRun?: boolean;
  riskAck?: boolean;
}): Promise<ToolEnvelope> {
  const dryRun = input.dryRun ?? true;
  if (!dryRun && readonlyMode()) {
    return failEnvelope("svn revert", resolveCwd(input.cwd), "READONLY instance");
  }
  if (!dryRun && !input.riskAck) {
    return {
      ...failEnvelope("svn revert", resolveCwd(input.cwd), "destructive revert requires riskAck:true after reviewing the dry-run receipt"),
      code: "RISK_ACK_REQUIRED"
    };
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
  operationId?: string;
}): Promise<ToolEnvelope> {
  if (input.operationId) {
    const { operationId, ...coreInput } = input;
    const cwd = resolveCwd(input.cwd);
    return withDurableOperation({
      operationId,
      kind: "svn_resolve",
      fingerprint: stableOperationFingerprint({
        kind: "svn_resolve",
        cwd: pathIdentityKey(cwd),
        path: normalizedOperationPaths(cwd, [input.path])[0],
        accept: input.accept
      }),
      command: "svn resolve",
      cwd,
      execute: () => svnResolve(coreInput)
    });
  }
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
    const stat = statTargetForMutation("svn propset", guard.cwd, target);
    if (!stat.ok) return stat.envelope;
    if (!stat.stat.isFile()) {
      return failEnvelope("svn propset", guard.cwd, `svn:eol-style requires a regular file: ${repoRelativePath(target, guard.wcRoot)}`);
    }
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

  const propertyTemp = writeSecureTemp("svn-agent-property-", "value.txt", input.value);
  try {
    const run = await runSvn(["propset", "-F", propertyTemp.file, "--", input.name, ...guard.paths.map(escapeSvnTarget)], guard.cwd);
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
  } finally {
    fs.rmSync(propertyTemp.dir, { recursive: true, force: true });
  }
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
  const credentialError = credentialedUrlError(input.src);
  if (credentialError) return failEnvelope("svn export", cwd, credentialError);

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
  const credentialError = credentialedUrlError(input.url);
  if (credentialError) return failEnvelope("svn import", cwd, credentialError);
  const messageValidation = validateCommitMessage(input.message);
  if (!messageValidation.valid) {
    return {
      ...failEnvelope("svn import", cwd, messageValidation.warningDetail),
      code: messageValidation.warningCode,
      warning_code: messageValidation.warningCode,
      failed_rule: messageValidation.failedRule,
      suggested_message: messageValidation.suggestedMessage
    };
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
    // Import source and destination are literal operands. Appending a peg
    // escape changes valid local paths and repository names containing '@'.
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
): Promise<{ ok: true; cwd: string; wcRoot: string; repoRoot: string | null; paths: string[] } | { ok: false; envelope: ToolEnvelope }> {
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
    repoRoot: context.info.repo_root,
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

  // Local move destinations are literal filesystem operands; only copy accepts
  // repository peg syntax here. Integration coverage locks this asymmetry down.
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
  return writeSecureTemp(prefix, "message.txt", normalizeMessageFile(message));
}

function normalizedOperationPaths(cwd: string, paths: string[]): string[] {
  return paths.map((candidate) => pathIdentityKey(path.resolve(cwd, candidate))).sort();
}

function normalizedCommitMessage(message: string): string {
  return normalizeMessageFile(message).trimEnd();
}

export async function recoverCommittedOperation(input: {
  cwd?: string;
  paths: string[];
  message: string;
  riskAck?: boolean;
  allowRoot?: boolean;
  allowDirectoryTargets?: boolean;
  expandDescendants?: boolean;
}, createdAt: number): Promise<ToolEnvelope | null> {
  void input;
  void createdAt;
  return null;
}

function writeSecureTemp(prefix: string, filename: string, value: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, filename);
  fs.writeFileSync(file, value, { encoding: "utf8", mode: 0o600 });
  return { dir, file };
}

function normalizeMessageFile(value: string): string {
  return stripLeadingBom(value).replace(/\r\n?/g, "\n");
}

function stripLeadingBom(value: string): string {
  return value.replace(/^\uFEFF/, "");
}

function combineRuns(runs: Awaited<ReturnType<typeof runSvn>>[], cwd: string): Awaited<ReturnType<typeof runSvn>> {
  const failed = runs.find((run) => run.exitCode !== 0 || run.timedOut || run.cancelled);
  return {
    command: runs.map((run) => run.command).join(" && "),
    cwd,
    executable: runs[0]?.executable ?? "svn",
    args: runs.flatMap((run) => run.args),
    exitCode: failed?.exitCode ?? 0,
    signal: failed?.signal ?? null,
    stdout: runs.map((run) => run.stdout).filter(Boolean).join("\n"),
    stderr: runs.map((run) => run.stderr).filter(Boolean).join("\n"),
    timedOut: runs.some((run) => run.timedOut),
    cancelled: runs.some((run) => run.cancelled),
    truncated: runs.some((run) => run.truncated)
  };
}

function credentialedUrlError(value: string): string | null {
  if (!isSvnUrl(value)) return null;
  try {
    const parsed = new URL(value);
    return parsed.username || parsed.password ? "repository URLs must not contain credentials; use cached SVN authentication" : null;
  } catch {
    return "invalid repository URL";
  }
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
