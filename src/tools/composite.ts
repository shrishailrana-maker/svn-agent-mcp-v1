import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveCommitScope } from "../commitScope.js";
import { processEvidenceStore } from "../evidenceStore.js";
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
import { createEnvelope, envelopeFromRun, failEnvelope, noteFromRun } from "../envelope.js";
import {
  converterForEolTarget,
  convertEol,
  expectedEolKind,
  isBinaryKind,
  normalizeEolTarget,
  normalizedContentHash,
  normalizedContentHashFile,
  sniffEol
} from "../eol.js";
import { sha256File } from "../fileHash.js";
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
  resolveCwd,
  resolveTargetsInsideWc,
  validateCommitMessage
} from "../guards.js";
import { escapeSvnTarget, runExecutable, runSvn, runSvnStreamingChunks, runSvnVersion } from "../runner.js";
import type { ToolEnvelope } from "../types.js";
import { recoverCommittedOperation, svnCommit, svnUpdate } from "./mutating.js";
import {
  defaultDiffLineLimit,
  dryRiskSignals,
  eolCheck,
  getWcContext,
  normalizeStatusLookup,
  parseSvnVersion,
  remoteHeadForTargets,
  scopedStatusMap,
  svnLockStatus,
  svnDiff,
  svnInfo,
  svnStatus
} from "./readonly.js";

const AUTO_EOL_BASE_MAX_BYTES = 10 * 1024 * 1024;
const WINDOWS_STAGED_APPLY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$target = $args[0]; $candidate = $args[1]; $backup = $args[2]; $expected = $args[3]; $candidateExpected = $args[4]",
  "$stream = $null",
  "$candidateStream = $null",
  "try {",
  "  $candidateStream = [System.IO.File]::Open($candidate, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)",
  "  $sha = [System.Security.Cryptography.SHA256]::Create()",
  "  $candidateActual = ([System.BitConverter]::ToString($sha.ComputeHash($candidateStream))).Replace('-', '').ToLowerInvariant(); $sha.Dispose()",
  "  if ($candidateActual -ne $candidateExpected) { exit 6 }",
  "  $candidateStream.Position = 0",
  "  $stream = [System.IO.File]::Open($target, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)",
  "  $sha = [System.Security.Cryptography.SHA256]::Create()",
  "  $stream.Position = 0; $actual = ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant(); $sha.Dispose()",
  "  if ($actual -ne $expected) { exit 2 }",
  "  try {",
  "    $stream.Position = 0; $stream.SetLength(0); $candidateStream.CopyTo($stream); $stream.Flush($true)",
  "    exit 0",
  "  } catch {",
  "    try {",
  "      $source = [System.IO.File]::Open($backup, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)",
  "      try { $stream.Position = 0; $stream.SetLength(0); $source.CopyTo($stream); $stream.Flush($true) } finally { $source.Dispose() }",
  "      exit 3",
  "    } catch { exit 4 }",
  "  }",
  "} catch { exit 5 } finally { if ($stream) { $stream.Dispose() }; if ($candidateStream) { $candidateStream.Dispose() } }"
].join("; ");

export async function svnSnapshot(input: {
  cwd?: string;
  paths?: string[];
  includeIgnored?: boolean;
  hideNoise?: boolean;
  fields?: string[];
  captureBaseline?: boolean;
  includeLockState?: boolean;
}): Promise<ToolEnvelope> {
  if (input.captureBaseline && (!input.paths || input.paths.length === 0)) {
    return failEnvelope("svn snapshot", resolveCwd(input.cwd), "captureBaseline requires explicit paths");
  }
  const requested = new Set(input.fields ?? []);
  const projected = requested.size > 0;
  const statusFields = ["changedPaths", "counts", "items", "conflicts", "changedCount", "conflictCount"];
  const infoFields = [
    "revision", "revisionRange", "mixedRevision", "localModifications", "switched", "partial",
    "remoteHeadRevision", "staleBase", "workingCopyRoot", "repositoryUrl", "repositoryRoot"
  ];
  const lockFields = ["lockState", "lockCount", "lockStates", "lockStateTruncated", "lockStateUnavailableReason"];
  const needStatus = input.captureBaseline === true || !projected || statusFields.some((field) => requested.has(field));
  const needInfo = input.captureBaseline === true || !projected || infoFields.some((field) => requested.has(field));
  const needLock = input.includeLockState === true || lockFields.some((field) => requested.has(field));
  const [status, info] = await Promise.all([
    needStatus ? svnStatus(input) : Promise.resolve(null),
    needInfo ? svnInfo({
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.paths === undefined ? {} : { paths: input.paths })
    }) : Promise.resolve(null)
  ]);
  const ok = (status?.ok ?? true) && (info?.ok ?? true);
  const cwd = status?.cwd ?? info?.cwd ?? resolveCwd(input.cwd);
  let lockSummary: Record<string, unknown> | null = null;
  if (needLock && ok) {
    const lockPaths = input.paths && input.paths.length > 0 ? input.paths : [cwd];
    const lock = await svnLockStatus({
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      paths: lockPaths
    });
    if (lock.ok) {
      const rows = Array.isArray(lock.locks) ? lock.locks as Array<Record<string, unknown>> : [];
      const stateCounts = new Map<string, number>();
      for (const row of rows) {
        const state = typeof row.state === "string" ? row.state : "unlocked";
        stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1);
      }
      const states = [...stateCounts.keys()].sort();
      lockSummary = {
        state: states.length === 0 ? "unlocked" : states.length === 1 ? states[0] : "mixed",
        count: typeof lock.lock_count === "number" ? lock.lock_count : rows.length,
        states: Object.fromEntries(states.map((state) => [state, stateCounts.get(state)])),
        ...(lock.truncated === true ? { truncated: true } : {})
      };
    } else {
      lockSummary = { state: "unknown", count: 0, unavailable_reason: lock.note };
    }
  }
  const result: ToolEnvelope = {
    ...createEnvelope({
      ok,
      command: "svn snapshot",
      cwd,
      revision: info?.revision,
      changed_paths: status?.changed_paths ?? [],
      conflicts: status?.conflicts ?? [],
      note: ok ? "" : [status?.note, info?.note].filter(Boolean).join("; "),
      truncated: Boolean(status?.truncated || info?.truncated)
    }),
    wc_root: info?.wc_root ?? status?.wc_root,
    repository_url: info?.url ?? null,
    repository_root: info?.repo_root ?? null,
    mixed_revision: info?.mixed_revision,
    revision_range: info?.revision_range,
    local_modifications: info?.local_modifications,
    switched: info?.switched,
    partial: info?.partial,
    remote_head_revision: info?.remote_head_revision,
    stale_base: info?.stale_base,
    changed_path_count: status?.changed_paths.length ?? 0,
    conflict_count: status?.conflicts.length ?? 0,
    ...(lockSummary ? { lock_summary: lockSummary } : {}),
    components: { status: needStatus, info: needInfo }
  };
  if (!input.captureBaseline || !ok || !status || !info || !input.paths) return result;

  const context = await getWcContext(input.cwd, input.paths);
  if (!context.ok) return context.envelope;
  const resolved = resolveTargetsInsideWc(context.cwd, context.wcRoot, input.paths);
  if (!resolved.ok) return failEnvelope("svn snapshot", context.cwd, resolved.note);
  if (resolved.paths.some((candidate) => {
    try {
      return fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  })) {
    return {
      ...failEnvelope("svn snapshot", context.cwd, "captureBaseline accepts explicit files only"),
      code: "BASELINE_FILE_SCOPE_REQUIRED"
    };
  }
  const captured = await captureCurrentWorkflowPathStates(context.cwd, context.wcRoot, resolved.paths);
  if (!captured.ok) {
    return { ...result, ok: false, code: "BASELINE_CAPTURE_FAILED", note: captured.note };
  }
  const states = captured.states;
  const evidence = processWorkflowEvidence.put("baseline", workflowScope(context.wcRoot, resolved.paths), {
    schema: 1,
    wcRoot: context.wcRoot,
    repositoryRoot: info.repo_root ?? context.info.repo_root,
    paths: states,
    remoteHeadRevision: info.remote_head_revision ?? null,
    revisionRange: info.revision_range ?? null,
    mixedRevision: info.mixed_revision === true,
    switched: info.switched === true,
    partial: info.partial === true,
    policyIdentity: workflowPolicyIdentity(context.wcRoot),
    createdAt: Date.now()
  });
  if (!evidence.ok) {
    return { ...result, ok: false, code: evidence.code, note: evidence.note };
  }
  return {
    ...result,
    baseline_token: evidence.token,
    baseline_expires_at: evidence.expiresAt,
    baseline_path_count: states.length
  };
}

export type SvnPrecommitDependencies = {
  afterAutomaticEolRepair?(paths: string[]): void | Promise<void>;
};

export async function svnPrecommit(input: {
  cwd?: string;
  paths: string[];
  lineLimit?: number;
  allowRoot?: boolean;
  allowDirectoryTargets?: boolean;
  expandDescendants?: boolean;
  requireUniformRevision?: boolean;
  baselineToken?: string;
  autoFixEol?: "safe" | "off";
}, dependencies: SvnPrecommitDependencies = {}): Promise<ToolEnvelope> {
  const explicitError = requireExplicitPaths(input.paths);
  const cwd = resolveCwd(input.cwd);
  if (explicitError) {
    return blockedPrecommit(failEnvelope("svn_precommit", cwd, explicitError));
  }

  const context = await getWcContext(input.cwd, input.paths);
  if (!context.ok) {
    return blockedPrecommit(context.envelope);
  }

  const resolved = resolveTargetsInsideWc(context.cwd, context.wcRoot, input.paths);
  if (!resolved.ok) {
    return blockedPrecommit(failEnvelope("svn_precommit", context.cwd, resolved.note));
  }
  if (!input.allowRoot && resolved.paths.some((target) => pathIdentityKey(target) === pathIdentityKey(context.wcRoot))) {
    return blockedPrecommit(failEnvelope("svn_precommit", context.cwd, "working-copy root commit requires allowRoot:true"));
  }
  const explicitFilePaths = new Map(resolved.paths.flatMap((target) => {
    try {
      return fs.statSync(target).isFile() ? [[repoRelativePath(target, context.wcRoot), target] as const] : [];
    } catch {
      return [];
    }
  }));
  const scope = await resolveCommitScope({
    cwd: context.cwd,
    wcRoot: context.wcRoot,
    paths: resolved.paths,
    ...(input.expandDescendants === undefined ? {} : { expandDescendants: input.expandDescendants }),
    ...(input.allowDirectoryTargets === undefined ? {} : { allowDirectoryTargets: input.allowDirectoryTargets })
  });
  if (!scope.ok) {
    return {
      ...blockedPrecommit(scope.envelope ?? failEnvelope("svn_precommit", context.cwd, scope.note)),
      ...(scope.nextAction ? { next_action: { tool: "svn_precommit", paths: input.paths, ...scope.nextAction } } : {}),
      ...(scope.expanded ? { scope_expanded: true, expanded_paths: scope.expandedPaths } : {})
    };
  }
  if (scope.expanded && scope.paths.length === 0) {
    return {
      ...createEnvelope({ ok: true, command: "svn_precommit", cwd: context.cwd, note: "NOTHING_TO_COMMIT" }),
      verdict: "NOTHING_TO_COMMIT",
      per_file: [],
      risk_signals: [],
      diff_excerpt: "",
      scope_expanded: true,
      expanded_paths: []
    };
  }

  const scopedPaths = scope.paths;
  let baselineStates: WorkflowPathState[] | null = null;
  let baselineRemoteHead: number | null = null;
  if (input.baselineToken) {
    const baseline = processWorkflowEvidence.get(
      input.baselineToken,
      "baseline",
      workflowScope(context.wcRoot, scopedPaths)
    );
    if (!baseline.ok) {
      return blockedPrecommit({
        ...failEnvelope("svn_precommit", context.cwd, baseline.note),
        code: `BASELINE_${baseline.code}`
      });
    }
    baselineStates = parseWorkflowPathStates(baseline.record.paths);
    if (!baselineStates || baseline.record.repositoryRoot !== context.info.repo_root
      || baseline.record.policyIdentity !== workflowPolicyIdentity(context.wcRoot)) {
      return blockedPrecommit({
        ...failEnvelope("svn_precommit", context.cwd, "baseline no longer matches this repository or policy"),
        code: "BASELINE_INVALID"
      });
    }
    baselineRemoteHead = typeof baseline.record.remoteHeadRevision === "number"
      ? baseline.record.remoteHeadRevision
      : null;
  }
  const stateBeforeChecks = await captureCurrentWorkflowPathStates(context.cwd, context.wcRoot, scopedPaths);
  if (!stateBeforeChecks.ok) {
    return blockedPrecommit({
      ...failEnvelope("svn_precommit", context.cwd, stateBeforeChecks.note),
      code: "PRECOMMIT_STATE_UNAVAILABLE"
    });
  }
  const status = await scopedStatusMap(context.cwd, context.wcRoot, scopedPaths);
  if (!status.envelope.ok) {
    return blockedPrecommit(status.envelope);
  }
  const repositoryPolicy = repositoryEolPolicy(context.wcRoot);
  if (repositoryPolicy.invalid) {
    return blockedPrecommit({
      ...failEnvelope("svn_precommit", context.cwd, repositoryPolicy.invalid),
      code: "EOL_POLICY_INVALID"
    });
  }

  const diff = await svnDiff({
    cwd: context.cwd,
    paths: scopedPaths,
    ignoreEol: true,
    lineLimit: input.lineLimit ?? defaultDiffLineLimit()
  });
  const eol = await eolCheck({ cwd: context.cwd, paths: scopedPaths });
  const eolPolicyIdentity = workflowEolPolicyIdentity(context.wcRoot);
  const eolFiles = new Map(
    ((eol.files as Array<{ path: string }> | undefined) ?? []).map((file) => [pathIdentityKey(file.path), file])
  );
  const diffFiles = new Map(diff.per_file.map((file) => [pathIdentityKey(path.resolve(context.cwd, file.path)), file]));
  const conflictedTargets = new Set(
    status.envelope.conflicts.map((conflict) => pathIdentityKey(path.resolve(context.cwd, conflict.path)))
  );
  const riskSignals = dryRiskSignals(scopedPaths, context.wcRoot, status.map);
  const perFile = [];
  const guardNotes: string[] = [];
  const diffNotes: string[] = [];
  let hasRealChange = false;
  let needsEolFix = false;

  if (!diff.ok) {
    diffNotes.push(`svn diff failed: ${diff.note || "unknown reason"}`);
    if (diff.recovery_tool === "eol_fix_verified") {
      needsEolFix = true;
    }
  }

  for (const target of scopedPaths) {
    const targetKey = pathIdentityKey(target);
    const statusCode = normalizeStatusLookup(status.map, target);
    const diffFile = diffFiles.get(targetKey);
    const eolFile = eolFiles.get(targetKey) as
      | { kind?: string; eol_style?: string | null; has_bom?: boolean; mismatch?: boolean }
      | undefined;
    const policyTarget = eolPolicyExcludes(target, context.wcRoot, repositoryPolicy.excludes)
      ? null
      : repositoryPolicy.target;
    const eolTarget = expectedEolKind(eolFile?.eol_style) ?? policyTarget;
    const detectedEol = eolFile?.kind;
    const addedEolMismatch = statusCode === "A"
      && eolTarget !== null
      && (eolFile?.has_bom === true
        || (detectedEol !== undefined
          && detectedEol !== "none"
          && detectedEol !== "binary"
          && detectedEol !== "skipped-too-large"
          && detectedEol !== "not-a-file"
          && detectedEol !== eolTarget));
    const eolMismatch = eolFile?.mismatch === true || addedEolMismatch;
    const cleanEolMismatch = !statusCode && eolMismatch;
    const never = neverCommitHit(target, context.wcRoot);
    const guard = never
      ? neverCommitNote(never, target, context.wcRoot)
      : (!statusCode && !cleanEolMismatch) || statusCode === "?" || statusCode === "!" || statusCode === "I"
        ? `path is not committable: ${repoRelativePath(target, context.wcRoot)}`
        : !isCommittableStatus(statusCode) && !cleanEolMismatch
          ? `path has non-committable status (${statusCode}): ${repoRelativePath(target, context.wcRoot)}`
          : conflictedTargets.has(targetKey)
            ? `path has unresolved conflicts: ${repoRelativePath(target, context.wcRoot)}`
            : null;

    if (guard) {
      guardNotes.push(guard);
    }

    const pureEolChurn = diff.ok && diff.totals_complete === true && eol.ok && statusCode === "M" && !diffFile;
    if (eolMismatch || pureEolChurn) {
      needsEolFix = true;
    }
    if (isCommittableStatus(statusCode) && !conflictedTargets.has(targetKey) && !pureEolChurn) {
      hasRealChange = true;
    }

    perFile.push({
      path: repoRelativePath(target, context.wcRoot),
      status: statusCode ?? "",
      added: diffFile?.added ?? 0,
      removed: diffFile?.removed ?? 0,
      binary: diffFile?.binary ?? false,
      property_changed: diffFile?.property_changed ?? false,
      eol: eolFile?.kind ?? null,
      eol_style: eolFile?.eol_style ?? null,
      eol_mismatch: eolMismatch,
      eol_target: eolTarget,
      added_text_file: statusCode === "A" && eolFile?.kind !== "binary",
      bom: eolFile?.has_bom ?? false,
      pure_eol_churn: pureEolChurn,
      guard
    });
  }

  const version = await runSvnVersion(context.wcRoot, context.cwd);
  const versionState = version.exitCode === 0 ? parseSvnVersion(version.stdout) : null;
  const mixedRevision = versionState?.mixed ?? false;
  const verdict = guardNotes.length > 0
    ? "GUARD_BLOCKED"
    : !diff.ok && diff.recovery_tool !== "eol_fix_verified"
      ? "DIFF_FAILED"
      : needsEolFix
        ? "EOL_FIX_NEEDED"
        : !hasRealChange
          ? "NOTHING_TO_COMMIT"
          : input.requireUniformRevision && mixedRevision
            ? "REVISION_NORMALIZATION_NEEDED"
          : "READY";

  const remediation = verdict === "REVISION_NORMALIZATION_NEEDED"
    ? "run svn_update at the working-copy root with updateAll:true and revision:<pinned-revision>, then rerun svn_precommit"
    : "";
  const notes = [
    verdict,
    ...guardNotes,
    ...diffNotes,
    mixedRevision && input.requireUniformRevision ? "mixed revision working copy" : "",
    remediation
  ].filter(Boolean);

  const result: ToolEnvelope = {
    ...createEnvelope({
      ok: verdict !== "GUARD_BLOCKED" && verdict !== "DIFF_FAILED" && verdict !== "REVISION_NORMALIZATION_NEEDED",
      command: "svn_precommit",
      cwd: context.cwd,
      changed_paths: status.envelope.changed_paths,
      conflicts: status.envelope.conflicts,
      truncated: diff.truncated,
      note: notes.join("; ")
    }),
    verdict,
    per_file: perFile,
    risk_signals: riskSignals,
    mixed_revision: mixedRevision,
    revision_range: versionState?.range ?? null,
    eol_check_complete: eol.ok,
    diff_totals_complete: diff.totals_complete === true,
    eol_policy_identity: eolPolicyIdentity,
    ...(diff.recovery_tool ? { diff_recovery_tool: diff.recovery_tool } : {}),
    ...(diff.operation_id ? { diff_operation_id: diff.operation_id } : {}),
    ...(diff.evidence_expires_at ? { diff_evidence_expires_at: diff.evidence_expires_at } : {}),
    ...(diff.next_cursor ? { diff_next_cursor: diff.next_cursor } : {}),
    ...(diff.evidence_terminal_truncation === true ? { diff_evidence_capped: true } : {}),
    ...(diff.truncated === true && diff.operation_id && diff.next_cursor
      && diff.evidence_terminal_truncation !== true
      ? {
          next_action: {
            tool: "svn_diff",
            cwd: scope.expanded ? context.wcRoot : context.cwd,
            paths: scope.expanded
              ? scopedPaths.map((target) => repoRelativePath(target, context.wcRoot))
              : input.paths,
            operationId: diff.operation_id,
            cursor: diff.next_cursor,
            ignoreEol: true
          }
        }
      : {}),
    ...(remediation ? { remediation } : {}),
    diff_excerpt: diff.diff_excerpt,
    eol_only: diff.eol_only === true,
    truncated: diff.truncated,
    ...(scope.expanded ? { scope_expanded: true, expanded_paths: scope.expandedPaths } : {})
  };
  if (verdict === "EOL_FIX_NEEDED" && input.autoFixEol !== "off") {
    if (readonlyMode()) {
      return {
        ...withoutPrecommitDiffContinuation(result),
        auto_eol_fix_unavailable: "READONLY instance",
        remediation: "rerun on a writable SVN MCP or set autoFixEol:off for diagnostics"
      };
    }
    const repaired = await automaticallyRepairEol(context.cwd, result, explicitFilePaths);
    if (!repaired.ok) {
      const repairCode = repaired.envelope.code ?? "EOL_AUTO_FIX_FAILED";
      const repairRefused = repairCode === "EOL_AUTO_FIX_REFUSED" || repairCode === "EOL_TARGET_UNDECLARED";
      const eolPaths = precommitEolPaths(result);
      const converterFailure = repairCode === "EOL_CONVERTER_FAILED";
      const manualRepair = repairCode !== "EOL_TARGET_UNDECLARED" && !converterFailure && eolPaths.length > 0;
      return {
        ...withoutPrecommitDiffContinuation(result),
        ok: false,
        verdict: repairRefused ? "EOL_FIX_REFUSED" : "EOL_FIX_FAILED",
        code: repairCode,
        note: repaired.envelope.note,
        remediation: manualRepair
          ? "inspect the refusal, run eol_fix_verified on the exact files, then rerun svn_precommit"
          : converterFailure
            ? "run svn_self_check; repair SVN_AGENT_DOS2UNIX_DIR, bundled converters, or PATH before retrying"
          : repairCode === "EOL_TARGET_UNDECLARED"
            ? "declare svn:eol-style or repository normalizeEol policy, then rerun svn_precommit"
            : "inspect the EOL repair failure and rerun svn_precommit",
        ...(manualRepair
          ? { next_action: { tool: "eol_fix_verified", cwd: context.cwd, paths: eolPaths } }
          : converterFailure
            ? { next_action: { tool: "svn_self_check", cwd: context.cwd } }
            : {}),
        auto_eol_fix_attempted: true,
        ...(repaired.envelope.rollback_outcomes ? { rollback_outcomes: repaired.envelope.rollback_outcomes } : {}),
        ...(repaired.envelope.rollback_restored_paths ? { rollback_restored_paths: repaired.envelope.rollback_restored_paths } : {}),
        ...(repaired.envelope.rollback_concurrent_paths ? { rollback_concurrent_paths: repaired.envelope.rollback_concurrent_paths } : {}),
        ...(repaired.envelope.rollback_failed_paths ? { rollback_failed_paths: repaired.envelope.rollback_failed_paths } : {})
      };
    }
    try {
      await dependencies.afterAutomaticEolRepair?.(repaired.paths);
    } catch {
      const outcomes = await repaired.rollback();
      return {
        ...withoutPrecommitDiffContinuation(result),
        ok: false,
        verdict: "EOL_FIX_FAILED",
        code: "EOL_POST_REPAIR_CHECK_FAILED",
        note: "automatic EOL repair post-check failed; rollback attempted",
        remediation: "inspect rollback outcomes, then rerun svn_precommit",
        next_action: { tool: "eol_fix_verified", cwd: context.cwd, paths: repaired.paths },
        auto_eol_fix_attempted: true,
        ...rollbackOutcomeFields(outcomes)
      };
    }
    const targetCheck = await verifyRepairedEolTargets({
      cwd: context.cwd,
      wcRoot: context.wcRoot,
      precommit: result,
      repairedPaths: repaired.paths,
      explicitFilePaths
    });
    if (!targetCheck.ok) {
      const outcomes = await repaired.rollback();
      return {
        ...withoutPrecommitDiffContinuation(result),
        ok: false,
        verdict: "EOL_FIX_REFUSED",
        code: "EOL_POLICY_CHANGED_DURING_REPAIR",
        note: `safe automatic EOL repair refused: ${targetCheck.note}`,
        remediation: "recheck svn:eol-style or repository EOL policy, then rerun svn_precommit",
        auto_eol_fix_attempted: true,
        ...rollbackOutcomeFields(outcomes)
      };
    }
    const afterStatus = await svnStatus({ cwd: context.cwd, paths: scopedPaths, depth: "empty" });
    if (afterStatus.ok && afterStatus.changed_paths.length === 0 && afterStatus.conflicts.length === 0) {
      return {
        ...withoutPrecommitDiffContinuation(result),
        ok: true,
        verdict: "NOTHING_TO_COMMIT",
        changed_paths: [],
        conflicts: [],
        note: "automatic EOL repair restored a clean working-copy scope",
        auto_eol_fixed: true,
        auto_eol_fixed_paths: repaired.paths
      };
    }
    const afterRepair = await svnPrecommit({
      cwd: context.cwd,
      paths: input.paths,
      ...(input.lineLimit === undefined ? {} : { lineLimit: input.lineLimit }),
      ...(input.allowRoot === undefined ? {} : { allowRoot: input.allowRoot }),
      ...(input.allowDirectoryTargets === undefined ? {} : { allowDirectoryTargets: input.allowDirectoryTargets }),
      ...(input.expandDescendants === undefined ? {} : { expandDescendants: input.expandDescendants }),
      ...(input.requireUniformRevision === undefined ? {} : { requireUniformRevision: input.requireUniformRevision }),
      ...(input.baselineToken === undefined ? {} : { baselineToken: input.baselineToken }),
      autoFixEol: "off"
    });
    if (afterRepair.verdict === "READY") {
      return {
        ...afterRepair,
        auto_eol_fixed: true,
        auto_eol_fixed_paths: repaired.paths
      };
    }
    const outcomes = await repaired.rollback();
    return {
      ...withoutPrecommitDiffContinuation(afterRepair),
      ok: false,
      verdict: "EOL_FIX_FAILED",
      note: `automatic EOL repair completed but precommit remained ${String(afterRepair.verdict)}`,
      remediation: "inspect the reported post-repair verdict, then rerun svn_precommit",
      next_action: { tool: "eol_fix_verified", cwd: context.cwd, paths: repaired.paths },
      auto_eol_fix_attempted: true,
      ...rollbackOutcomeFields(outcomes)
    };
  }
  if (verdict !== "READY") return result;

  const captured = await captureCurrentWorkflowPathStates(context.cwd, context.wcRoot, scopedPaths);
  if (!captured.ok) {
    return {
      ...result,
      ok: false,
      verdict: "EVIDENCE_FAILED",
      code: "PRECOMMIT_STATE_UNAVAILABLE",
      note: `${result.note}; ${captured.note}`.replace(/^;\s*/, "")
    };
  }
  if (!workflowStatesEqual(stateBeforeChecks.states, captured.states)) {
    return {
      ...result,
      ok: false,
      verdict: "EVIDENCE_FAILED",
      code: "PRECOMMIT_STATE_CHANGED_DURING_CHECK",
      note: `${result.note}; commit paths changed while precommit checks were running; rerun svn_precommit`.replace(/^;\s*/, "")
    };
  }
  const remoteHeadRevision = await remoteHeadForTargets(context.cwd, scopedPaths)
    ?? await remoteHeadForTargets(context.cwd, [context.info.repo_root ?? context.wcRoot]);
  if (remoteHeadRevision === null) {
    return {
      ...result,
      ok: false,
      verdict: "EVIDENCE_FAILED",
      code: "PRECOMMIT_REMOTE_HEAD_UNAVAILABLE",
      note: `${result.note}; could not bind precommit to repository HEAD`.replace(/^;\s*/, "")
    };
  }
  const evidence = processWorkflowEvidence.put("precommit", workflowScope(context.wcRoot, scopedPaths), {
    schema: 1,
    repositoryRoot: context.info.repo_root,
    paths: captured.states,
    remoteHeadRevision,
    revisionRange: versionState?.range ?? null,
    policyIdentity: workflowPolicyIdentity(context.wcRoot),
    eolPolicyIdentity,
    eolVerdict: "passed-via-precommit",
    eolCheckComplete: eol.ok,
    diffIdentity: workflowDiffIdentity(diff),
    baselineToken: input.baselineToken ?? null,
    createdAt: Date.now()
  });
  if (!evidence.ok) {
    return {
      ...result,
      ok: false,
      verdict: "EVIDENCE_FAILED",
      code: evidence.code,
      note: `${result.note}; ${evidence.note}`.replace(/^;\s*/, "")
    };
  }
  const baselineByPath = new Map((baselineStates ?? []).map((state) => [
    normalizedRelativeIdentity(state.path),
    state
  ]));
  const baselinePathChanges = baselineStates
    ? captured.states
        .filter((state) => {
          const baseline = baselineByPath.get(normalizedRelativeIdentity(state.path));
          return !baseline || !workflowStatesEqual([baseline], [state]);
        })
        .map((state) => state.path)
    : [];
  return {
    ...result,
    precommit_token: evidence.token,
    precommit_expires_at: evidence.expiresAt,
    remote_head_revision: remoteHeadRevision,
    ...(input.baselineToken
      ? {
          baseline_token: input.baselineToken,
          baseline_path_changes: baselinePathChanges,
          remote_head_changed_since_baseline: baselineRemoteHead !== null && baselineRemoteHead !== remoteHeadRevision
        }
      : {})
  };
}

function withoutPrecommitDiffContinuation(result: ToolEnvelope): ToolEnvelope {
  const {
    diff_operation_id: _diffOperationId,
    diff_evidence_expires_at: _diffEvidenceExpiresAt,
    diff_next_cursor: _diffNextCursor,
    diff_evidence_capped: _diffEvidenceCapped,
    next_action: nextAction,
    ...rest
  } = result;
  return nextAction && typeof nextAction === "object"
    && !Array.isArray(nextAction)
    && (nextAction as Record<string, unknown>).tool !== "svn_diff"
    ? { ...rest, next_action: nextAction }
    : rest;
}

function precommitEolPaths(result: ToolEnvelope): string[] {
  return ((result.per_file as Array<Record<string, unknown>> | undefined) ?? [])
    .filter((file) => file.eol_mismatch === true || file.pure_eol_churn === true)
    .map((file) => file.path)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

export async function svnPrepareCommit(input: {
  cwd?: string;
  paths: string[];
  revision: string;
  expectedRemoteHead?: number;
  lineLimit?: number;
  allowRoot?: boolean;
  allowDirectoryTargets?: boolean;
  expandDescendants?: boolean;
  requireUniformRevision?: boolean;
  autoFixEol?: "safe" | "off";
  operationId?: string;
  baselineToken?: string;
}): Promise<ToolEnvelope> {
  if (input.operationId) {
    const { operationId, ...coreInput } = input;
    const cwd = resolveCwd(input.cwd);
    return withDurableOperation({
      operationId,
      kind: "svn_prepare_commit",
      fingerprint: stableOperationFingerprint({
        kind: "svn_prepare_commit",
        cwd: pathIdentityKey(cwd),
        paths: normalizedCompositePaths(cwd, input.paths),
        revision: input.revision,
        expectedRemoteHead: input.expectedRemoteHead ?? null,
        lineLimit: input.lineLimit ?? null,
        allowRoot: input.allowRoot ?? false,
        allowDirectoryTargets: input.allowDirectoryTargets ?? false,
        expandDescendants: input.expandDescendants ?? false,
        requireUniformRevision: input.requireUniformRevision ?? false,
        autoFixEol: input.autoFixEol !== "off",
        baselineToken: input.baselineToken ?? null
      }),
      command: "svn commit --prepare",
      cwd,
      execute: () => svnPrepareCommit(coreInput)
    });
  }
  const cwd = resolveCwd(input.cwd);
  if (readonlyMode()) {
    return prepareCommitFailure(failEnvelope("svn_prepare_commit", cwd, "READONLY instance"), "READONLY");
  }
  if (!/^\d+$/.test(input.revision)) {
    return prepareCommitFailure(failEnvelope("svn_prepare_commit", cwd, "revision must be an exact numeric revision"), "INVALID_REVISION");
  }
  const explicitError = requireExplicitPaths(input.paths);
  if (explicitError) {
    return prepareCommitFailure(failEnvelope("svn_prepare_commit", cwd, explicitError), "GUARD_BLOCKED");
  }

  const context = await getWcContext(input.cwd, input.paths);
  if (!context.ok) {
    return prepareCommitFailure(context.envelope, "GUARD_BLOCKED");
  }
  const resolved = resolveTargetsInsideWc(context.cwd, context.wcRoot, input.paths);
  if (!resolved.ok) {
    return prepareCommitFailure(failEnvelope("svn_prepare_commit", context.cwd, resolved.note), "GUARD_BLOCKED");
  }
  if (!input.allowRoot && resolved.paths.some((target) => pathIdentityKey(target) === pathIdentityKey(context.wcRoot))) {
    return prepareCommitFailure(
      failEnvelope("svn_prepare_commit", context.cwd, "working-copy root commit requires allowRoot:true"),
      "GUARD_BLOCKED"
    );
  }
  const preflightScope = await resolveCommitScope({
    cwd: context.cwd,
    wcRoot: context.wcRoot,
    paths: resolved.paths,
    ...(input.expandDescendants === undefined ? {} : { expandDescendants: input.expandDescendants }),
    ...(input.allowDirectoryTargets === undefined ? {} : { allowDirectoryTargets: input.allowDirectoryTargets })
  });
  if (!preflightScope.ok) {
    return {
      ...prepareCommitFailure(
        preflightScope.envelope ?? failEnvelope("svn_prepare_commit", context.cwd, preflightScope.note),
        "GUARD_BLOCKED"
      ),
      ...(preflightScope.nextAction
        ? { next_action: { tool: "svn_commit", paths: input.paths, operation: "prepare", ...preflightScope.nextAction } }
        : {})
    };
  }
  const preflightGuardPaths = preflightScope.paths.length > 0 ? preflightScope.paths : resolved.paths;
  for (const target of preflightGuardPaths) {
    const hit = neverCommitHit(target, context.wcRoot);
    if (hit) {
      return prepareCommitFailure(
        failEnvelope("svn_prepare_commit", context.cwd, neverCommitNote(hit, target, context.wcRoot)),
        "GUARD_BLOCKED"
      );
    }
  }
  const directoryTargets = resolved.paths.filter((candidate) => {
    try {
      return fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });
  const directoryKeys = new Set(directoryTargets.map((candidate) => pathIdentityKey(candidate)));
  const localBefore = await scopedStatusMap(context.cwd, context.wcRoot, resolved.paths);
  if (!localBefore.envelope.ok) {
    return prepareCommitFailure(localBefore.envelope, "STATUS_FAILED");
  }
  const localPathsBefore = localBefore.envelope.changed_paths.map((entry) =>
    repoRelativePath(path.resolve(context.cwd, entry.path), context.wcRoot));

  const updated = await svnUpdate({
    cwd: context.cwd,
    paths: input.paths,
    revision: input.revision,
    ...(directoryTargets.length > 0 && input.expandDescendants !== true ? { depth: "empty" as const } : {}),
    ...(input.expectedRemoteHead === undefined ? {} : { expectedRemoteHead: input.expectedRemoteHead }),
    ...(input.baselineToken === undefined ? {} : { baselineToken: input.baselineToken }),
    skipAdded: true
  });
  if (!updated.ok) {
    const verdict = updated.note.includes("remote HEAD changed") ? "REMOTE_HEAD_CHANGED" : "UPDATE_FAILED";
    return prepareCommitFailure(updated, verdict);
  }
  if (updated.collision === true) {
    return {
      ...prepareCommitFailure(
        failEnvelope("svn_prepare_commit", context.cwd, "same-path collision detected; reconcile and reverify"),
        "COLLISION_DETECTED"
      ),
      baseline_token: input.baselineToken,
      collision_paths: updated.collision_paths,
      path_states: updated.path_states,
      recommended_action: updated.recommended_action
    };
  }

  const unexpectedTouchedPaths = updated.changed_paths
    .map((entry) => path.resolve(context.cwd, entry.path))
    .filter((candidate) => !resolved.paths.some((target) =>
      pathIdentityKey(candidate) === pathIdentityKey(target)
      || (directoryKeys.has(pathIdentityKey(target)) && isInsideOrEqual(candidate, target))))
    .map((candidate) => repoRelativePath(candidate, context.wcRoot));
  if (unexpectedTouchedPaths.length > 0) {
    return {
      ...prepareCommitFailure(
        failEnvelope("svn_prepare_commit", context.cwd, "update touched paths outside the explicit prepare scope"),
        "UNEXPECTED_PATHS"
      ),
      requested_revision: input.revision,
      resulting_revision: updated.resulting_revision,
      unexpected_touched_paths: unexpectedTouchedPaths
    };
  }
  if (updated.conflicts.length > 0) {
    return {
      ...prepareCommitFailure(
        createEnvelope({
          ok: false,
          command: "svn_prepare_commit",
          cwd: context.cwd,
          changed_paths: updated.changed_paths,
          conflicts: updated.conflicts,
          note: "conflicts postponed; reconcile and rerun prepare_commit"
        }),
        "CONFLICTS_PRESENT"
      ),
      requested_revision: input.revision,
      resulting_revision: updated.resulting_revision,
      revision_range: updated.revision_range,
      mixed_revision: updated.mixed_revision,
      unexpected_touched_paths: []
    };
  }

  let precommit = await svnPrecommit({
    cwd: context.cwd,
    paths: input.paths,
    ...(input.lineLimit === undefined ? {} : { lineLimit: input.lineLimit }),
    ...(input.allowRoot === undefined ? {} : { allowRoot: input.allowRoot }),
    ...(input.allowDirectoryTargets === undefined ? {} : { allowDirectoryTargets: input.allowDirectoryTargets }),
    ...(input.expandDescendants === undefined ? {} : { expandDescendants: input.expandDescendants }),
    ...(input.requireUniformRevision === undefined ? {} : { requireUniformRevision: input.requireUniformRevision }),
    ...(input.autoFixEol === undefined ? {} : { autoFixEol: input.autoFixEol })
  });
  const autoEolFixedPaths = stringList(precommit.auto_eol_fixed_paths);
  const finalScope = precommit.scope_expanded === true && Array.isArray(precommit.expanded_paths)
    ? precommit.expanded_paths
    : resolved.paths.map((candidate) => repoRelativePath(candidate, context.wcRoot));
  const resultingRevision = typeof updated.resulting_revision === "number"
    ? updated.resulting_revision
    : Number.parseInt(input.revision, 10);
  return {
    ...createEnvelope({
      ok: precommit.ok && precommit.verdict === "READY",
      command: "svn_prepare_commit",
      cwd: context.cwd,
      revision: resultingRevision,
      changed_paths: precommit.changed_paths,
      conflicts: precommit.conflicts,
      note: precommit.note
    }),
    verdict: precommit.verdict,
    requested_revision: input.revision,
    resulting_revision: resultingRevision,
    revision_range: updated.revision_range,
    mixed_revision: updated.mixed_revision,
    expected_remote_head: input.expectedRemoteHead ?? null,
    observed_remote_head: updated.observed_remote_head ?? null,
    local_paths_before_update: localPathsBefore,
    updated_paths: updated.changed_paths.map((entry) => repoRelativePath(path.resolve(context.cwd, entry.path), context.wcRoot)),
    unexpected_touched_paths: [],
    final_commit_scope: finalScope,
    scope_expanded: precommit.scope_expanded === true,
    operation: "prepare_commit",
    precommit,
    ...(precommit.code ? { code: precommit.code } : {}),
    ...(precommit.auto_eol_fixed === true
      ? { auto_eol_fixed: true, auto_eol_fixed_paths: autoEolFixedPaths }
      : {})
  };
}

export async function svnCommitWorkflow(input: {
  operation?: "commit" | "prepare" | "safe" | "detail";
  cwd?: string;
  paths: string[];
  message?: string;
  revision?: string;
  expectedRemoteHead?: number;
  lineLimit?: number;
  riskAck?: boolean;
  allowRoot?: boolean;
  allowDirectoryTargets?: boolean;
  expandDescendants?: boolean;
  requireUniformRevision?: boolean;
  autoFixEol?: "safe" | "off";
  operationId?: string;
  baselineToken?: string;
  precommitToken?: string;
  detailOperationId?: string;
  cursor?: string;
  maxChars?: number;
}): Promise<ToolEnvelope> {
  if (input.operation === "detail") {
    return safeCommitDetail(input);
  }
  if (input.operation === "safe") {
    return svnSafeCommit(input);
  }
  if (input.operation === "prepare") {
    if (!input.revision) {
      return prepareCommitFailure(
        failEnvelope("svn commit --prepare", resolveCwd(input.cwd), "operation:prepare requires an exact numeric revision"),
        "INVALID_REVISION"
      );
    }
    return svnPrepareCommit({
      paths: input.paths,
      revision: input.revision,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.expectedRemoteHead === undefined ? {} : { expectedRemoteHead: input.expectedRemoteHead }),
      ...(input.lineLimit === undefined ? {} : { lineLimit: input.lineLimit }),
      ...(input.allowRoot === undefined ? {} : { allowRoot: input.allowRoot }),
      ...(input.allowDirectoryTargets === undefined ? {} : { allowDirectoryTargets: input.allowDirectoryTargets }),
      ...(input.expandDescendants === undefined ? {} : { expandDescendants: input.expandDescendants }),
      ...(input.requireUniformRevision === undefined ? {} : { requireUniformRevision: input.requireUniformRevision }),
      ...(input.autoFixEol === undefined ? {} : { autoFixEol: input.autoFixEol }),
      ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
      ...(input.baselineToken === undefined ? {} : { baselineToken: input.baselineToken })
    });
  }
  if (input.message === undefined) {
    return failEnvelope("svn commit", resolveCwd(input.cwd), "operation:commit requires message");
  }
  const precommit = await svnPrecommit({
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    paths: input.paths,
    ...(input.allowRoot === undefined ? {} : { allowRoot: input.allowRoot }),
    ...(input.allowDirectoryTargets === undefined ? {} : { allowDirectoryTargets: input.allowDirectoryTargets }),
    ...(input.expandDescendants === undefined ? {} : { expandDescendants: input.expandDescendants }),
    ...(input.requireUniformRevision === undefined ? {} : { requireUniformRevision: input.requireUniformRevision }),
    ...(input.autoFixEol === undefined ? {} : { autoFixEol: input.autoFixEol })
  });
  const autoEolFixedPaths = stringList(precommit.auto_eol_fixed_paths);
  if (precommit.auto_eol_fixed === true && precommit.verdict === "NOTHING_TO_COMMIT") {
    return {
      ...precommit,
      operation: "commit",
      auto_eol_fixed: true,
      auto_eol_fixed_paths: autoEolFixedPaths
    };
  }
  if (["EOL_FIX_NEEDED", "EOL_FIX_REFUSED", "EOL_FIX_FAILED"].includes(String(precommit.verdict))) {
    return {
      ...precommit,
      ok: false,
      operation: "commit"
    };
  }
  const precommitToken = typeof precommit.precommit_token === "string"
    ? precommit.precommit_token
    : input.precommitToken;
  const committed = await svnCommit({
    paths: input.paths,
    message: input.message,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.riskAck === undefined ? {} : { riskAck: input.riskAck }),
    ...(input.allowRoot === undefined ? {} : { allowRoot: input.allowRoot }),
    ...(input.allowDirectoryTargets === undefined ? {} : { allowDirectoryTargets: input.allowDirectoryTargets }),
    ...(input.expandDescendants === undefined ? {} : { expandDescendants: input.expandDescendants }),
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    ...(precommitToken === undefined ? {} : { precommitToken })
  });
  return {
    ...committed,
    ...(precommit.auto_eol_fixed === true
      ? { auto_eol_fixed: true, auto_eol_fixed_paths: autoEolFixedPaths, eol_verdict: "auto_fixed" }
      : {})
  };
}

type SafeCommitInput = {
  cwd?: string;
  paths: string[];
  message?: string;
  revision?: string;
  expectedRemoteHead?: number;
  lineLimit?: number;
  riskAck?: boolean;
  allowRoot?: boolean;
  allowDirectoryTargets?: boolean;
  expandDescendants?: boolean;
  requireUniformRevision?: boolean;
  autoFixEol?: "safe" | "off";
  operationId?: string;
  baselineToken?: string;
};

type ValidatedSafeCommitInput = Omit<SafeCommitInput, "message" | "revision" | "expectedRemoteHead"> & {
  message: string;
  revision: string;
  expectedRemoteHead: number;
};

async function svnSafeCommit(input: SafeCommitInput): Promise<ToolEnvelope> {
  const cwd = resolveCwd(input.cwd);
  if (readonlyMode()) return safeCommitFailure(cwd, "READONLY", "READONLY instance");
  if (!input.operationId) return safeCommitFailure(cwd, "OPERATION_ID_REQUIRED", "operation:safe requires operationId");
  const message = input.message;
  if (!message) return safeCommitFailure(cwd, "MESSAGE_REQUIRED", "operation:safe requires message");
  const messageValidation = validateCommitMessage(message);
  if (!messageValidation.valid) {
    return {
      ...safeCommitFailure(cwd, messageValidation.warningCode, messageValidation.warningDetail),
      warning_code: messageValidation.warningCode,
      failed_rule: messageValidation.failedRule,
      suggested_message: messageValidation.suggestedMessage
    };
  }
  const revision = input.revision;
  if (!revision || !/^\d+$/.test(revision)) {
    return safeCommitFailure(cwd, "INVALID_REVISION", "operation:safe requires an exact numeric revision");
  }
  const expectedRemoteHead = input.expectedRemoteHead;
  if (typeof expectedRemoteHead !== "number" || !Number.isSafeInteger(expectedRemoteHead) || expectedRemoteHead < 0) {
    return safeCommitFailure(cwd, "REMOTE_HEAD_REQUIRED", "operation:safe requires expectedRemoteHead");
  }
  const validated: ValidatedSafeCommitInput = { ...input, message, revision, expectedRemoteHead };
  return withDurableOperation({
    operationId: input.operationId,
    kind: "svn_safe_commit",
    fingerprint: stableOperationFingerprint({
      kind: "svn_safe_commit",
      cwd: pathIdentityKey(cwd),
      paths: normalizedCompositePaths(cwd, input.paths),
      messageHash: createHash("sha256").update(message.replace(/\r\n?/g, "\n").trimEnd()).digest("hex"),
      revision,
      expectedRemoteHead,
      baselineToken: input.baselineToken ?? null,
      riskAck: input.riskAck ?? false,
      allowRoot: input.allowRoot ?? false,
      allowDirectoryTargets: input.allowDirectoryTargets ?? false,
      expandDescendants: input.expandDescendants ?? false,
      requireUniformRevision: input.requireUniformRevision ?? false,
      autoFixEol: input.autoFixEol !== "off"
    }),
    command: "svn safe_commit",
    cwd,
    execute: () => executeSafeCommit(validated),
    recoverStale: ({ createdAt }) => recoverSafeCommit(validated, createdAt)
  });
}

async function executeSafeCommit(
  input: ValidatedSafeCommitInput
): Promise<ToolEnvelope> {
  const canonical = await canonicalSafeCommitInput(input);
  if (!canonical.ok) return canonical.envelope;
  return executeCanonicalSafeCommit(canonical.input);
}

async function executeCanonicalSafeCommit(
  input: ValidatedSafeCommitInput
): Promise<ToolEnvelope> {
  const stages: Array<Record<string, unknown>> = [];
  let baselineToken = input.baselineToken;
  let baselineCapturedAutomatically = false;
  let autoEolFixedPaths: string[] = [];
  if (!baselineToken) {
    const baseline = await captureSafeCommitBaseline(input);
    if (!baseline.ok) return baseline.envelope;
    baselineToken = baseline.token;
    baselineCapturedAutomatically = true;
    stages.push({ stage: "baseline", token: baseline.token, expiresAt: baseline.expiresAt });
  }
  const effectiveInput: ValidatedSafeCommitInput = { ...input, baselineToken };
  const prepared = await svnPrepareCommit({
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    paths: input.paths,
    revision: input.revision,
    expectedRemoteHead: input.expectedRemoteHead,
    ...(input.lineLimit === undefined ? {} : { lineLimit: input.lineLimit }),
    ...(input.allowRoot === undefined ? {} : { allowRoot: input.allowRoot }),
    ...(input.allowDirectoryTargets === undefined ? {} : { allowDirectoryTargets: input.allowDirectoryTargets }),
    ...(input.expandDescendants === undefined ? {} : { expandDescendants: input.expandDescendants }),
    ...(input.requireUniformRevision === undefined ? {} : { requireUniformRevision: input.requireUniformRevision }),
    ...(input.autoFixEol === undefined ? {} : { autoFixEol: input.autoFixEol }),
    baselineToken
  });
  stages.push({ stage: "prepare", result: prepared });
  let precommit = prepared.precommit && typeof prepared.precommit === "object"
    ? prepared.precommit as ToolEnvelope
    : null;
  autoEolFixedPaths = stringList(prepared.auto_eol_fixed_paths);
  const finalScope = (stringList(prepared.final_commit_scope).length > 0
    ? stringList(prepared.final_commit_scope)
    : input.paths)
    .map((candidate) => path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(resolveCwd(input.cwd), candidate));

  if (prepared.verdict === "EOL_FIX_NEEDED" && precommit && input.autoFixEol !== "off") {
    const eolPaths = ((precommit.per_file as Array<Record<string, unknown>> | undefined) ?? [])
      .filter((file) => file.eol_mismatch === true || file.pure_eol_churn === true)
      .map((file) => file.path)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    if (eolPaths.length === 0) {
      return attachSafeDetail(effectiveInput, safeCommitFailure(resolveCwd(input.cwd), "EOL_FIX_FAILED", "precommit requested EOL repair without explicit failing paths"), stages);
    }
    const fixed = await eolFixVerified({
      paths: eolPaths,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd })
    });
    stages.push({ stage: "eol_fix", result: fixed });
    if (!fixed.ok) {
      return attachSafeDetail(effectiveInput, safeCommitFailure(fixed.cwd, "EOL_FIX_FAILED", fixed.note), stages);
    }
    autoEolFixedPaths = eolPaths;
    precommit = await svnPrecommit({
      paths: finalScope,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.lineLimit === undefined ? {} : { lineLimit: input.lineLimit }),
      ...(input.requireUniformRevision === undefined ? {} : { requireUniformRevision: input.requireUniformRevision }),
      autoFixEol: "off",
      ...(input.allowRoot === undefined ? {} : { allowRoot: input.allowRoot }),
      // finalScope was produced and guarded by prepare; internal revalidation
      // must accept directory nodes introduced by descendant expansion.
      allowDirectoryTargets: true
    });
    stages.push({ stage: "precommit_after_eol", result: precommit });
  }

  if (!precommit || precommit.verdict !== "READY" || typeof precommit.precommit_token !== "string") {
    const note = precommit?.note || prepared.note || "safe commit precommit did not reach READY";
    const failed = safeCommitFailure(
      resolveCwd(input.cwd),
      String(precommit?.code ?? precommit?.verdict ?? prepared.code ?? prepared.verdict ?? "PRECOMMIT_FAILED"),
      note
    );
    if (precommit?.verdict) failed.verdict = precommit.verdict;
    const detailed = await attachSafeDetail(effectiveInput, failed, stages);
    return {
      ...detailed,
      ...(autoEolFixedPaths.length > 0
        ? { auto_eol_fixed: true, auto_eol_fixed_paths: autoEolFixedPaths }
        : {})
    };
  }

  const committed = await svnCommit({
    paths: finalScope,
    message: input.message,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.riskAck === undefined ? {} : { riskAck: input.riskAck }),
    ...(input.allowRoot === undefined ? {} : { allowRoot: input.allowRoot }),
    // This is the already prepared exact scope, not a fresh caller-provided
    // directory acknowledgement.
    allowDirectoryTargets: true,
    precommitToken: precommit.precommit_token
  });
  stages.push({ stage: "commit", result: committed });
  if (!committed.ok || typeof committed.committed_revision !== "number") {
    return attachSafeDetail(effectiveInput, safeCommitFailure(committed.cwd, "COMMIT_FAILED", committed.note), stages);
  }
  const finalized = await finalizeSafeCommit(effectiveInput, committed, finalScope, stages);
  return {
    ...finalized,
    baseline_token: baselineToken,
    baseline_captured_automatically: baselineCapturedAutomatically,
    ...(autoEolFixedPaths.length > 0
      ? { auto_eol_fixed: true, auto_eol_fixed_paths: autoEolFixedPaths }
      : {})
  };
}

async function captureSafeCommitBaseline(
  input: Pick<ValidatedSafeCommitInput, "cwd" | "paths">
): Promise<{ ok: true; token: string; expiresAt: number } | { ok: false; envelope: ToolEnvelope }> {
  const context = await getWcContext(input.cwd, input.paths);
  if (!context.ok) return { ok: false, envelope: context.envelope };
  const resolved = resolveTargetsInsideWc(context.cwd, context.wcRoot, input.paths);
  if (!resolved.ok) {
    return { ok: false, envelope: safeCommitFailure(context.cwd, "BASELINE_SCOPE_INVALID", resolved.note) };
  }
  if (resolved.paths.some((candidate) => {
    try {
      return fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  })) {
    return {
      ok: false,
      envelope: safeCommitFailure(context.cwd, "BASELINE_FILE_SCOPE_REQUIRED", "operation:safe accepts explicit files unless a file baselineToken is supplied")
    };
  }
  const captured = await captureCurrentWorkflowPathStates(context.cwd, context.wcRoot, resolved.paths);
  if (!captured.ok) {
    return { ok: false, envelope: safeCommitFailure(context.cwd, "BASELINE_CAPTURE_FAILED", captured.note) };
  }
  const remoteHeadRevision = await remoteHeadForTargets(context.cwd, resolved.paths)
    ?? await remoteHeadForTargets(context.cwd, [context.info.repo_root ?? context.wcRoot]);
  if (remoteHeadRevision === null) {
    return { ok: false, envelope: safeCommitFailure(context.cwd, "BASELINE_REMOTE_HEAD_UNAVAILABLE", "could not capture repository HEAD") };
  }
  const stored = processWorkflowEvidence.put("baseline", workflowScope(context.wcRoot, resolved.paths), {
    schema: 1,
    wcRoot: context.wcRoot,
    repositoryRoot: context.info.repo_root,
    paths: captured.states,
    remoteHeadRevision,
    revisionRange: workflowRevisionRange(captured.states),
    mixedRevision: false,
    switched: false,
    partial: false,
    policyIdentity: workflowPolicyIdentity(context.wcRoot),
    createdAt: Date.now()
  });
  if (!stored.ok) {
    return { ok: false, envelope: safeCommitFailure(context.cwd, stored.code, stored.note) };
  }
  return { ok: true, token: stored.token, expiresAt: stored.expiresAt };
}

async function canonicalSafeCommitInput(
  input: ValidatedSafeCommitInput
): Promise<{ ok: true; input: ValidatedSafeCommitInput } | { ok: false; envelope: ToolEnvelope }> {
  const context = await getWcContext(input.cwd, input.paths);
  if (!context.ok) return { ok: false, envelope: context.envelope };
  const resolved = resolveTargetsInsideWc(context.cwd, context.wcRoot, input.paths);
  if (!resolved.ok) {
    return { ok: false, envelope: safeCommitFailure(context.cwd, "SAFE_SCOPE_INVALID", resolved.note) };
  }
  return {
    ok: true,
    input: { ...input, cwd: context.wcRoot, paths: resolved.paths }
  };
}

async function finalizeSafeCommit(
  input: SafeCommitInput,
  committed: ToolEnvelope,
  finalScope: string[],
  stages: Array<Record<string, unknown>>
): Promise<ToolEnvelope> {
  const revision = Number(committed.committed_revision);
  const wcRoot = resolveCwd(input.cwd);
  const deleted = new Set(committed.changed_paths
    .filter((entry) => entry.status === "D")
    .map((entry) => normalizedRelativeIdentity(entry.path)));
  const updateScope = finalScope.filter((candidate) => !deleted.has(normalizedRelativeIdentity(
    repoRelativePath(path.isAbsolute(candidate) ? candidate : path.resolve(wcRoot, candidate), wcRoot)
  )));
  const updated = updateScope.length > 0
    ? await svnUpdate({
        paths: updateScope,
        revision: String(revision),
        ...(input.cwd === undefined ? {} : { cwd: input.cwd })
      })
    : {
        ...createEnvelope({ ok: true, command: "svn update (deleted scope skipped)", cwd: committed.cwd, revision }),
        requested_revision: String(revision),
        resulting_revision: revision,
        revision_range: { min: revision, max: revision },
        mixed_revision: false
      };
  stages.push({ stage: "pin_committed_scope", result: updated });
  if (!updated.ok || updated.conflicts.length > 0) {
    return attachSafeDetail(input, safeCommitFailure(updated.cwd, "FINAL_UPDATE_FAILED", updated.note || "final pinned update failed"), stages);
  }
  const finalStatus = updateScope.length > 0
    ? await svnStatus({
        paths: updateScope,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd })
      })
    : createEnvelope({ ok: true, command: "svn status (deleted scope skipped)", cwd: committed.cwd });
  const finalSnapshot = updateScope.length > 0
    ? await svnSnapshot({
        paths: updateScope,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd })
      })
    : null;
  stages.push({ stage: "final_status", result: finalStatus });
  if (finalSnapshot) stages.push({ stage: "final_snapshot", result: finalSnapshot });
  const context = await getWcContext(input.cwd, updateScope.length > 0 ? updateScope : finalScope);
  const resolved = context.ok && updateScope.length > 0
    ? resolveTargetsInsideWc(context.cwd, context.wcRoot, updateScope)
    : null;
  const captured = context.ok && resolved?.ok && updateScope.length > 0
    ? await captureCurrentWorkflowPathStates(context.cwd, context.wcRoot, resolved.paths)
    : null;
  const scopeUniform = updateScope.length === 0
    || Boolean(captured?.ok && captured.states.every((state) => state.baseRevision === revision));
  const finalScopeClean = finalStatus.ok
    && finalStatus.changed_paths.length === 0
    && finalStatus.conflicts.length === 0;
  const result: ToolEnvelope = {
    ...createEnvelope({
      ok: finalScopeClean && scopeUniform,
      command: "svn safe_commit",
      cwd: committed.cwd,
      revision,
      changed_paths: committed.changed_paths,
      conflicts: finalStatus.conflicts,
      note: finalScopeClean && scopeUniform ? "" : "final committed scope verification failed"
    }),
    operation: "safe_commit",
    verdict: finalScopeClean && scopeUniform ? "COMMITTED" : "FINAL_VERIFICATION_FAILED",
    committed_revision: revision,
    committed_paths: committed.committed_paths,
    committed_count: committed.committed_count,
    path_count: committed.path_count,
    base_revision: committed.base_revision,
    remote_head_revision: committed.remote_head_revision,
    eol_verdict: "verified",
    content_hashes: committed.content_hashes,
    diff_stat: committed.diff_stat,
    post_status_clean: committed.post_status_clean,
    final_scope_clean: finalScopeClean,
    scope_uniform: scopeUniform,
    final_revision_range: updateScope.length === 0
      ? { min: revision, max: revision }
      : captured?.ok ? workflowRevisionRange(captured.states) : null
  };
  return attachSafeDetail(input, result, stages);
}

async function recoverSafeCommit(
  input: ValidatedSafeCommitInput,
  createdAt: number
): Promise<ToolEnvelope | null> {
  const canonical = await canonicalSafeCommitInput(input);
  if (!canonical.ok) return null;
  const recovered = await recoverCommittedOperation(canonical.input, createdAt);
  if (!recovered || typeof recovered.committed_revision !== "number") return null;
  return finalizeSafeCommit(canonical.input, recovered, canonical.input.paths, [{ stage: "commit_recovered", result: recovered }]);
}

async function attachSafeDetail(
  input: Pick<SafeCommitInput, "cwd" | "paths">,
  result: ToolEnvelope,
  stages: Array<Record<string, unknown>>
): Promise<ToolEnvelope> {
  const context = await getWcContext(input.cwd, input.paths);
  if (!context.ok) return result;
  const resolved = resolveTargetsInsideWc(context.cwd, context.wcRoot, input.paths);
  if (!resolved.ok) return result;
  const stored = processEvidenceStore.put(
    "safe_commit_detail",
    workflowScope(context.wcRoot, resolved.paths),
    JSON.stringify({ stages }, null, 2),
    {}
  );
  return {
    ...result,
    detail_operation_id: stored.operationId,
    detail_expires_at: stored.expiresAt,
    detail_cursor: "0",
    ...(stored.truncated ? { detail_truncated: true } : {})
  };
}

async function safeCommitDetail(input: {
  cwd?: string;
  paths: string[];
  detailOperationId?: string;
  cursor?: string;
  maxChars?: number;
}): Promise<ToolEnvelope> {
  const cwd = resolveCwd(input.cwd);
  if (!input.detailOperationId) return safeCommitFailure(cwd, "DETAIL_ID_REQUIRED", "operation:detail requires detailOperationId");
  const context = await getWcContext(input.cwd, input.paths);
  if (!context.ok) return context.envelope;
  const resolved = resolveTargetsInsideWc(context.cwd, context.wcRoot, input.paths);
  if (!resolved.ok) return failEnvelope("svn safe_commit --detail", context.cwd, resolved.note);
  const evidence = processEvidenceStore.get(
    input.detailOperationId,
    "safe_commit_detail",
    workflowScope(context.wcRoot, resolved.paths)
  );
  if (!evidence.ok) {
    return { ...failEnvelope("svn safe_commit --detail", context.cwd, evidence.note), code: evidence.code };
  }
  const offset = /^\d+$/.test(input.cursor ?? "") ? Number.parseInt(input.cursor ?? "0", 10) : 0;
  const maxChars = Math.max(256, Math.min(input.maxChars ?? 12000, 64000));
  const detail = evidence.text.slice(offset, offset + maxChars);
  const nextOffset = offset + detail.length;
  return {
    ...createEnvelope({ ok: true, command: "svn safe_commit --detail", cwd: context.cwd }),
    operation: "safe_commit_detail",
    detail_operation_id: input.detailOperationId,
    detail,
    truncated: evidence.truncated || nextOffset < evidence.text.length,
    ...(nextOffset < evidence.text.length ? { next_cursor: String(nextOffset) } : {})
  };
}

function safeCommitFailure(cwd: string, code: string, note: string): ToolEnvelope {
  return {
    ...failEnvelope("svn safe_commit", cwd, note),
    operation: "safe_commit",
    verdict: code,
    code
  };
}

function workflowRevisionRange(states: WorkflowPathState[]): { min: number; max: number } | null {
  const revisions = states.map((state) => state.baseRevision).filter((value): value is number => value !== null);
  if (revisions.length === 0) return null;
  return { min: Math.min(...revisions), max: Math.max(...revisions) };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizedRelativeIdentity(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function prepareCommitFailure(envelope: ToolEnvelope, verdict: string): ToolEnvelope {
  return {
    ...envelope,
    ok: false,
    operation: "prepare_commit",
    verdict,
    unexpected_touched_paths: [],
    final_commit_scope: []
  };
}

function blockedPrecommit(envelope: ToolEnvelope): ToolEnvelope {
  return {
    ...envelope,
    verdict: "GUARD_BLOCKED",
    per_file: [],
    risk_signals: [],
    diff_excerpt: ""
  };
}

function rollbackOutcomeFields(
  outcomes: Array<{ path: string; outcome: "restored" | "changed" | "failed" }>
): Record<string, unknown> {
  const restoredPaths = outcomes.filter((outcome) => outcome.outcome === "restored").map((outcome) => outcome.path);
  const concurrentPaths = outcomes.filter((outcome) => outcome.outcome === "changed").map((outcome) => outcome.path);
  const failedPaths = outcomes.filter((outcome) => outcome.outcome === "failed").map((outcome) => outcome.path);
  return {
    ...(outcomes.length > 0 ? { rollback_outcomes: outcomes } : {}),
    ...(restoredPaths.length > 0 ? { rollback_restored_paths: restoredPaths } : {}),
    ...(concurrentPaths.length > 0 ? { rollback_concurrent_paths: concurrentPaths, concurrent_change_detected: true } : {}),
    ...(failedPaths.length > 0 ? { rollback_failed_paths: failedPaths } : {})
  };
}

async function automaticallyRepairEol(
  cwd: string,
  precommit: ToolEnvelope,
  explicitFilePaths?: ReadonlyMap<string, string>
): Promise<
  { ok: true; paths: string[]; rollback: () => Promise<Array<{ path: string; outcome: "restored" | "changed" | "failed" }>> }
  | { ok: false; envelope: ToolEnvelope }
> {
  const candidates = ((precommit.per_file as Array<Record<string, unknown>> | undefined) ?? [])
    .filter((file) => file.eol_mismatch === true || file.pure_eol_churn === true);
  if (precommit.eol_check_complete !== true) {
    return {
      ok: false,
      envelope: failEnvelope(
        "svn_precommit",
        cwd,
        "safe automatic EOL repair refused: EOL check evidence is incomplete",
        { code: "EOL_AUTO_FIX_REFUSED" }
      )
    };
  }
  if (candidates.length === 0) {
    return {
      ok: false,
      envelope: failEnvelope("svn_precommit", cwd, "safe automatic EOL repair refused: precommit did not identify an exact failing path", {
        code: "EOL_AUTO_FIX_REFUSED"
      })
    };
  }
  const expectedContentHashes = new Map<string, string>();
  const expectedNormalizedHashes = new Map<string, string>();
  for (const file of candidates) {
    const filePath = typeof file.path === "string" ? file.path : "unknown path";
    const absolutePath = explicitFilePaths?.get(filePath);
    if (!absolutePath) {
      return {
        ok: false,
        envelope: failEnvelope("svn_precommit", cwd, `safe automatic EOL repair refused: ${filePath}: automatic repair requires an exact explicit file target`, {
          code: "EOL_AUTO_FIX_REFUSED"
        })
      };
    }
    const eolTarget = file.eol_target === "crlf" || file.eol_target === "lf" ? file.eol_target : null;
    if (!eolTarget) {
      return {
        ok: false,
        envelope: failEnvelope("svn_precommit", cwd, `safe automatic EOL repair refused: ${filePath}: no declared EOL target`, {
          code: "EOL_TARGET_UNDECLARED"
        })
      };
    }
    const allowsCleanEolMismatch = file.eol_mismatch === true && String(file.status ?? "") === "";
    const refusal = file.bom === true
        ? `${filePath}: BOM or encoding risk requires explicit repair`
        : file.binary === true || file.eol === "binary"
          ? `${filePath}: binary file refused`
          : file.eol === "skipped-too-large"
            ? `${filePath}: file is too large for automatic repair`
            : !isCommittableStatus(String(file.status ?? "")) && !allowsCleanEolMismatch
              ? `${filePath}: file is not a tracked committable target`
              : null;
    if (refusal) {
      return {
        ok: false,
        envelope: failEnvelope("svn_precommit", cwd, `safe automatic EOL repair refused: ${refusal}`, {
          code: "EOL_AUTO_FIX_REFUSED"
        })
      };
    }
    try {
      const workingContent = await fs.promises.readFile(absolutePath);
      if (hasUtf8Bom(workingContent) || !isValidUtf8(workingContent)) {
        return {
          ok: false,
          envelope: failEnvelope("svn_precommit", cwd, `safe automatic EOL repair refused: ${filePath}: BOM or encoding risk requires explicit repair`, {
            code: "EOL_AUTO_FIX_REFUSED"
          })
        };
      }
      expectedContentHashes.set(filePath, createHash("sha256").update(workingContent).digest("hex"));
      expectedNormalizedHashes.set(filePath, normalizedContentHash(workingContent));
    } catch {
      return {
        ok: false,
        envelope: failEnvelope("svn_precommit", cwd, `safe automatic EOL repair refused: ${filePath}: file content is unavailable`, {
          code: "EOL_AUTO_FIX_REFUSED"
        })
      };
    }
  }
  const ignoredDiffProvesEolOnly = precommit.diff_totals_complete === true && precommit.eol_only === true;
  if (!ignoredDiffProvesEolOnly) {
    const refusal = await proveExactEolOnlyAgainstBase(cwd, precommit, candidates, explicitFilePaths, expectedContentHashes);
    if (refusal) {
      return {
        ok: false,
        envelope: failEnvelope("svn_precommit", cwd, `safe automatic EOL repair refused: ${refusal}`, {
          code: "EOL_AUTO_FIX_REFUSED"
        })
      };
    }
  }
  const repairs: Array<{ path: string; absolutePath: string; backup: Buffer; convertedHash: string }> = [];
  const rollback = async (): Promise<Array<{ path: string; outcome: "restored" | "changed" | "failed" }>> => {
    return Promise.all(repairs.map(async (repair) => ({
      path: repair.path,
      outcome: await restoreBackupForEolRepair({
        cwd,
        filePath: repair.absolutePath,
        backup: repair.backup,
        expectedHash: repair.convertedHash
      })
    })));
  };
  const withRollbackOutcomes = (
    envelope: ToolEnvelope,
    outcomes: Array<{ path: string; outcome: "restored" | "changed" | "failed" }>
  ): ToolEnvelope => {
    return {
      ...envelope,
      ...rollbackOutcomeFields(outcomes)
    };
  };
  for (const file of candidates) {
    const filePath = typeof file.path === "string" ? file.path : "unknown path";
    const absolutePath = explicitFilePaths?.get(filePath);
    if (!absolutePath) {
      const outcomes = await rollback();
      return {
        ok: false,
        envelope: withRollbackOutcomes(
          failEnvelope("svn_precommit", cwd, `safe automatic EOL repair refused: ${filePath}: exact file target became unavailable`, {
            code: "EOL_AUTO_FIX_REFUSED"
          }),
          outcomes
        )
      };
    }
    const expectedContentHash = expectedContentHashes.get(filePath);
    if (!expectedContentHash || await sha256File(absolutePath) !== expectedContentHash) {
      const outcomes = await rollback();
      return {
        ok: false,
        envelope: withRollbackOutcomes(
          failEnvelope("svn_precommit", cwd, `safe automatic EOL repair refused: ${filePath}: file changed after safe EOL proof`, {
            code: "EOL_AUTO_FIX_REFUSED"
          }),
          outcomes
        )
      };
    }
    const backup = await fs.promises.readFile(absolutePath);
    const eolTarget = file.eol_target === "crlf" || file.eol_target === "lf" ? file.eol_target : null;
    if (!eolTarget) {
      const outcomes = await rollback();
      return {
        ok: false,
        envelope: withRollbackOutcomes(
          failEnvelope("svn_precommit", cwd, `${filePath}: EOL target became unavailable`, { code: "EOL_TARGET_UNDECLARED" }),
          outcomes
        )
      };
    }
    const fixed = await eolFixVerified({ cwd, path: absolutePath, expectedContentHash, target: eolTarget });
    if (!fixed.ok) {
      const outcomes = await rollback();
      return { ok: false, envelope: withRollbackOutcomes(fixed, outcomes) };
    }
    const convertedHash = await sha256File(absolutePath);
    repairs.push({ path: filePath, absolutePath, backup, convertedHash });
    const addedTextFile = file.status === "A" && file.added_text_file === true;
    const verified = addedTextFile ? null : await svnDiff({ cwd, paths: [absolutePath], ignoreEol: true });
    const contentPreserved = addedTextFile
      ? typeof fixed.normalized_content_hash === "string"
        && fixed.normalized_content_hash === expectedNormalizedHashes.get(filePath)
      : verified?.ok === true
        && verified.totals_complete === true
        && verified.per_file.length === 0
        && verified.property_files === 0;
    if (!contentPreserved) {
      const outcomes = await rollback();
      return {
        ok: false,
        envelope: withRollbackOutcomes(
          failEnvelope(
            "svn_precommit",
            cwd,
            `safe automatic EOL repair refused: ${filePath}: ignored-EOL diff is incomplete or contains content/property changes; rollback attempted`,
            { code: "EOL_AUTO_FIX_REFUSED" }
          ),
          outcomes
        )
      };
    }
  }
  return { ok: true, paths: repairs.map((repair) => repair.path), rollback };
}

async function proveExactEolOnlyAgainstBase(
  cwd: string,
  precommit: ToolEnvelope,
  candidates: Array<Record<string, unknown>>,
  explicitFilePaths?: ReadonlyMap<string, string>,
  expectedContentHashes?: ReadonlyMap<string, string>
): Promise<string | null> {
  if (precommit.diff_recovery_tool !== "eol_fix_verified" && precommit.diff_totals_complete !== true) {
    return "ignored-EOL diff evidence is incomplete";
  }
  const candidateByPath = new Map(candidates
    .filter((file): file is Record<string, unknown> & { path: string } => typeof file.path === "string")
    .map((file) => [file.path, file]));
  const candidatePaths = new Set(candidateByPath.keys());
  // Only repaired files need EOL-only proof. Ordinary changes elsewhere in the
  // explicit scope remain untouched and are checked again before minting a token.
  for (const filePath of candidatePaths) {
    if (candidateByPath.get(filePath)?.status === "A") continue;
    const absolutePath = explicitFilePaths?.get(filePath);
    if (!absolutePath) return `${filePath}: automatic repair requires an exact explicit file target`;
    const workingContent = await fs.promises.readFile(absolutePath);
    const expectedContentHash = expectedContentHashes?.get(filePath);
    if (!expectedContentHash || createHash("sha256").update(workingContent).digest("hex") !== expectedContentHash) {
      return `${filePath}: file changed while safe EOL proof was running`;
    }
    const baseContent = await readBaseContent(cwd, absolutePath);
    if (!baseContent) return `${filePath}: repository BASE content is unavailable for safe comparison`;
    if (hasUtf8Bom(baseContent) || !isValidUtf8(baseContent)) {
      return `${filePath}: repository BASE has BOM or encoding risk`;
    }
    const propertyChanged = await localPropertyChangeState(cwd, absolutePath);
    if (propertyChanged === null) {
      return `${filePath}: property-change evidence is unavailable`;
    }
    if (propertyChanged) return `${filePath}: property changes require explicit repair`;
    if (normalizedContentHash(workingContent) !== normalizedContentHash(baseContent)) {
      return `${filePath}: normalized BASE content shows a real content change`;
    }
  }
  return null;
}

async function verifyRepairedEolTargets(input: {
  cwd: string;
  wcRoot: string;
  precommit: ToolEnvelope;
  repairedPaths: string[];
  explicitFilePaths: ReadonlyMap<string, string>;
}): Promise<{ ok: true } | { ok: false; note: string }> {
  const policy = repositoryEolPolicy(input.wcRoot);
  if (policy.invalid) return { ok: false, note: policy.invalid };
  const absolutePaths = input.repairedPaths
    .map((filePath) => input.explicitFilePaths.get(filePath))
    .filter((filePath): filePath is string => typeof filePath === "string");
  if (absolutePaths.length !== input.repairedPaths.length) {
    return { ok: false, note: "repaired EOL target became unavailable" };
  }
  const checked = await eolCheck({ cwd: input.cwd, paths: absolutePaths });
  if (!checked.ok) return { ok: false, note: "post-repair EOL evidence is unavailable" };
  const checkedByPath = new Map(
    ((checked.files as Array<{ path: string }> | undefined) ?? [])
      .map((file) => [pathIdentityKey(file.path), file as Record<string, unknown>])
  );
  const originalByPath = new Map(
    ((input.precommit.per_file as Array<Record<string, unknown>> | undefined) ?? [])
      .filter((file): file is Record<string, unknown> & { path: string } => typeof file.path === "string")
      .map((file) => [file.path, file])
  );
  for (const filePath of input.repairedPaths) {
    const absolutePath = input.explicitFilePaths.get(filePath)!;
    const original = originalByPath.get(filePath);
    const expectedTarget = original?.eol_target;
    const current = checkedByPath.get(pathIdentityKey(absolutePath));
    const explicitTarget = expectedEolKind(typeof current?.eol_style === "string" ? current.eol_style : null);
    const policyTarget = eolPolicyExcludes(absolutePath, input.wcRoot, policy.excludes) ? null : policy.target;
    const currentTarget = explicitTarget ?? policyTarget;
    if ((expectedTarget !== "crlf" && expectedTarget !== "lf") || currentTarget !== expectedTarget) {
      return { ok: false, note: `${filePath}: declared EOL target changed during automatic repair` };
    }
    if (current?.has_bom === true || (current?.kind !== currentTarget && current?.kind !== "none")) {
      return { ok: false, note: `${filePath}: repaired EOL no longer matches the declared target` };
    }
  }
  return { ok: true };
}

async function localPropertyChangeState(cwd: string, absolutePath: string): Promise<boolean | null> {
  const status = await runSvn(["status", "--xml", "--verbose", "--depth", "empty", "--", escapeSvnTarget(absolutePath)], cwd);
  if (status.exitCode !== 0 || status.truncated) return null;
  const propertyMatch = /<wc-status\b[^>]*\bprops="([^"]*)"/.exec(status.stdout);
  if (!propertyMatch) return null;
  const value = propertyMatch[1] ?? "";
  return value !== "" && value !== "none" && value !== "normal";
}

async function readBaseContent(cwd: string, absolutePath: string): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let length = 0;
  let exceeded = false;
  const result = await runSvnStreamingChunks(
    ["cat", "-r", "BASE", "--", escapeSvnTarget(absolutePath)],
    cwd,
    (chunk) => {
      if (exceeded) return;
      if (length + chunk.length > AUTO_EOL_BASE_MAX_BYTES) {
        exceeded = true;
        return;
      }
      chunks.push(chunk);
      length += chunk.length;
    }
  );
  return result.exitCode === 0 && !exceeded ? Buffer.concat(chunks, length) : null;
}

function hasUtf8Bom(content: Buffer): boolean {
  return content.length >= 3 && content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf;
}

function isValidUtf8(content: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return true;
  } catch {
    return false;
  }
}

async function applyStagedEolFile(input: {
  cwd: string;
  filePath: string;
  convertedFile: string;
  backupFile: string;
  expectedHash: string;
  expectedConvertedHash: string;
}): Promise<"applied" | "changed" | "candidate-changed" | "restored" | "restore-failed" | "failed"> {
  if (process.platform !== "win32") {
    if (await sha256File(input.convertedFile) !== input.expectedConvertedHash) return "candidate-changed";
    if (await sha256File(input.filePath) !== input.expectedHash) return "changed";
    try {
      await fs.promises.rename(input.convertedFile, input.filePath);
      return "applied";
    } catch {
      return "failed";
    }
  }
  const powershell = path.join(
    process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const scriptFile = path.join(path.dirname(input.backupFile), "apply.ps1");
  await fs.promises.writeFile(scriptFile, WINDOWS_STAGED_APPLY_SCRIPT, "utf8");
  const run = await runExecutable(
    powershell,
    [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile,
      input.filePath, input.convertedFile, input.backupFile, input.expectedHash, input.expectedConvertedHash
    ],
    { cwd: input.cwd }
  );
  if (run.exitCode === 0) return "applied";
  if (run.exitCode === 2) return "changed";
  if (run.exitCode === 6) return "candidate-changed";
  if (run.exitCode === 3) return "restored";
  if (run.exitCode === 4) return "restore-failed";
  return "failed";
}

async function restoreBackupForEolRepair(input: {
  cwd: string;
  filePath: string;
  backup: Buffer;
  expectedHash: string;
}): Promise<"restored" | "changed" | "failed"> {
  const stageDir = fs.mkdtempSync(path.join(path.dirname(input.filePath), ".svn-agent-eol-rollback-"));
  const candidateFile = path.join(stageDir, "restore.bin");
  const backupFile = path.join(stageDir, "original.bin");
  try {
    await Promise.all([
      fs.promises.writeFile(candidateFile, input.backup),
      fs.promises.writeFile(backupFile, input.backup)
    ]);
    const backupHash = await sha256File(backupFile);
    const outcome = await applyStagedEolFile({
      cwd: input.cwd,
      filePath: input.filePath,
      convertedFile: candidateFile,
      backupFile,
      expectedHash: input.expectedHash,
      expectedConvertedHash: backupHash
    });
    return outcome === "applied" || outcome === "restored"
      ? "restored"
      : outcome === "changed"
        ? "changed"
        : "failed";
  } catch {
    return "failed";
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

export async function eolFixVerified(input: {
  cwd?: string;
  path?: string;
  paths?: string[];
  target?: "crlf" | "lf";
  removeBom?: boolean;
  dryRun?: boolean;
  allowLarge?: boolean;
  expectedContentHash?: string;
  operationId?: string;
}): Promise<ToolEnvelope> {
  if (input.operationId) {
    const { operationId, ...coreInput } = input;
    const cwd = resolveCwd(input.cwd);
    const requested = input.paths ?? (input.path ? [input.path] : []);
    return withDurableOperation({
      operationId,
      kind: "eol_fix_verified",
      fingerprint: stableOperationFingerprint({
        kind: "eol_fix_verified",
        cwd: pathIdentityKey(cwd),
        paths: normalizedCompositePaths(cwd, requested),
        target: input.target ?? null,
        removeBom: input.removeBom ?? true,
        dryRun: input.dryRun ?? false,
        allowLarge: input.allowLarge ?? false,
        expectedContentHash: input.expectedContentHash ?? null
      }),
      command: "eol_fix_verified",
      cwd,
      execute: () => eolFixVerified(coreInput)
    });
  }
  const requested = input.paths ?? (input.path ? [input.path] : []);
  const cwd = resolveCwd(input.cwd);
  if (input.path && input.paths) {
    return failEnvelope("eol_fix_verified", cwd, "use path or paths, not both");
  }
  if (input.expectedContentHash !== undefined && !/^[a-f0-9]{64}$/i.test(input.expectedContentHash)) {
    return failEnvelope("eol_fix_verified", cwd, "expectedContentHash must be a SHA-256 hex digest");
  }
  if (requested.length === 0) {
    return failEnvelope("eol_fix_verified", cwd, "explicit path or paths required");
  }
  if (requested.length > 500) {
    return failEnvelope("eol_fix_verified", cwd, `paths count ${requested.length} exceeds maximum 500`);
  }
  if (input.path) {
    return eolFixOneVerified({ ...input, path: input.path });
  }

  const files: Array<Record<string, unknown>> = [];
  for (const filePath of requested) {
    const result = await eolFixOneVerified({ ...input, path: filePath });
    files.push({
      path: filePath,
      ok: result.ok,
      before: eolKind(result.before),
      after: eolKind(result.after),
      target: result.target,
      pure_eol_churn: result.pure_eol_churn === true,
      normalized_content_hash: result.normalized_content_hash,
      ...(result.ok
        ? {}
        : {
            failure: result.note,
            ...(result.code ? { code: result.code } : {}),
            ...(result.remediation ? { remediation: result.remediation } : {}),
            ...(result.next_action ? { next_action: result.next_action } : {})
          })
    });
  }
  const passed = files.filter((file) => file.ok === true).length;
  const failed = files.length - passed;
  return {
    ...createEnvelope({
      ok: failed === 0,
      command: "eol_fix_verified",
      cwd,
      note: failed === 0 ? "batch EOL verification complete" : `${failed} EOL path(s) failed`
    }),
    batch: true,
    counts: { passed, failed, total: files.length },
    files
  };
}

async function eolFixOneVerified(input: {
  cwd?: string;
  path: string;
  target?: "crlf" | "lf";
  removeBom?: boolean;
  dryRun?: boolean;
  allowLarge?: boolean;
  expectedContentHash?: string;
}): Promise<ToolEnvelope> {
  const cwd = resolveCwd(input.cwd);
  if (readonlyMode() && !input.dryRun) {
    return failEnvelope("eol_fix_verified", cwd, "READONLY instance");
  }

  const context = await getWcContext(input.cwd, [input.path]);
  if (!context.ok) {
    return context.envelope;
  }

  const resolved = resolveTargetsInsideWc(context.cwd, context.wcRoot, [input.path]);
  if (!resolved.ok) {
    return failEnvelope("eol_fix_verified", context.cwd, resolved.note);
  }

  const [filePath] = resolved.paths;
  if (!filePath) {
    return failEnvelope("eol_fix_verified", context.cwd, "explicit path required");
  }
  const existsError = assertExistingTargets([filePath]);
  if (existsError) {
    return failEnvelope("eol_fix_verified", context.cwd, existsError);
  }
  if (!pathIsFile(filePath)) {
    return failEnvelope("eol_fix_verified", context.cwd, `path is not a file: ${repoRelativePath(filePath, context.wcRoot)}`);
  }

  const neverCommit = neverCommitHit(filePath, context.wcRoot);
  if (neverCommit) {
    return failEnvelope("eol_fix_verified", context.cwd, neverCommitNote(neverCommit, filePath, context.wcRoot));
  }

  const before = await sniffEol(filePath, input.allowLarge ? Number.MAX_SAFE_INTEGER : undefined);
  if (isBinaryKind(before.kind)) {
    return {
      ...failEnvelope("eol_fix_verified", context.cwd, "binary file refused"),
      code: "BINARY_FILE",
      before
    };
  }
  if (before.kind === "skipped-too-large" && !input.allowLarge) {
    return {
      ...failEnvelope("eol_fix_verified", context.cwd, "file too large for EOL repair without allowLarge:true"),
      before
    };
  }
  const normalizedHashBefore = await normalizedContentHashFile(filePath);

  const prop = await runSvn(["propget", "--", "svn:eol-style", escapeSvnTarget(filePath)], context.cwd);
  const eolStyle = prop.exitCode === 0 ? prop.stdout.trim() || null : null;
  const target = normalizeEolTarget(input.target, eolStyle);
  const converter = converterForEolTarget(target);
  if (input.dryRun) {
    return {
      ...createEnvelope({
        ok: true,
        command: "eol_fix_verified",
        cwd: context.cwd,
        note: `dry run: would convert to ${target}`
      }),
      before,
      after: before,
      target,
      eol_style: eolStyle,
      converter,
      normalized_content_hash: normalizedHashBefore,
      pure_eol_churn: false
    };
  }

  const backupDir = fs.mkdtempSync(path.join(path.dirname(filePath), ".svn-agent-eol-fix-"));
  const backupFile = path.join(backupDir, "original.bin");
  const convertedFile = path.join(backupDir, "converted.bin");
  try {
    await fs.promises.copyFile(filePath, backupFile);
    const backupHash = await sha256File(backupFile);
    const currentHash = await sha256File(filePath);
    if ((input.expectedContentHash && backupHash !== input.expectedContentHash) || currentHash !== backupHash) {
      return failEnvelope("eol_fix_verified", context.cwd, "file changed after safe EOL proof; conversion refused");
    }
    await fs.promises.copyFile(backupFile, convertedFile);
    const conversion = await convertEol({
      filePath: convertedFile,
      target,
      removeBom: input.removeBom ?? true,
      cwd: context.cwd
    });
    if (conversion.exitCode !== 0) {
      return {
        ...envelopeFromRun({
          run: conversion,
          ok: false,
          note: "EOL converter failed; original remained unchanged"
        }),
        code: "EOL_CONVERTER_FAILED",
        remediation: "run svn_self_check; repair SVN_AGENT_DOS2UNIX_DIR, bundled converters, or PATH before retrying",
        next_action: { tool: "svn_self_check", cwd: context.cwd },
        target,
        eol_style: eolStyle,
        converter,
        before,
        original_unchanged: true
      };
    }

    const convertedHash = await sha256File(convertedFile);
    const after = await sniffEol(convertedFile, input.allowLarge ? Number.MAX_SAFE_INTEGER : undefined);
    const normalizedHashAfter = await normalizedContentHashFile(convertedFile);
    const contentPreserved = normalizedHashAfter === normalizedHashBefore;
    const targetVerified = (after.kind === target || after.kind === "none") && !after.has_bom;
    if (!contentPreserved || !targetVerified) {
      return {
        ...failEnvelope(
          "eol_fix_verified",
          context.cwd,
          "normalized content or EOL verification failed; original remained unchanged"
        ),
        before,
        after,
        target,
        eol_style: eolStyle,
        converter,
        normalized_content_hash: normalizedHashAfter,
        pure_eol_churn: false,
        original_unchanged: true
      };
    }
    const apply = await applyStagedEolFile({
      cwd: context.cwd,
      filePath,
      convertedFile,
      backupFile,
      expectedHash: backupHash,
      expectedConvertedHash: convertedHash
    });
    if (apply === "changed") {
      return {
        ...failEnvelope("eol_fix_verified", context.cwd, "file changed during staged EOL repair; conversion refused"),
        code: "EOL_CONCURRENT_CHANGE",
        before,
        target,
        eol_style: eolStyle,
        converter,
        concurrent_change_detected: true,
        original_unchanged: true
      };
    }
    if (apply === "candidate-changed") {
      return {
        ...failEnvelope("eol_fix_verified", context.cwd, "staged EOL content changed before it could be applied"),
        code: "EOL_STAGED_CONTENT_CHANGED",
        before,
        target,
        eol_style: eolStyle,
        converter,
        original_unchanged: true
      };
    }
    if (apply !== "applied") {
      return {
        ...failEnvelope(
          "eol_fix_verified",
          context.cwd,
          apply === "restored"
            ? "staged EOL apply failed; original restored"
            : apply === "restore-failed"
              ? "staged EOL apply failed; restoring the original also failed"
              : "could not apply staged EOL repair; original may be unavailable"
        ),
        code: "EOL_APPLY_FAILED",
        before,
        target,
        eol_style: eolStyle,
        converter,
        ...(apply === "restored" ? { original_restored: true } : {}),
        ...(apply === "restore-failed" ? { rollback_failed: true } : {})
      };
    }
    if (await sha256File(filePath) !== convertedHash) {
      return {
        ...failEnvelope("eol_fix_verified", context.cwd, "file changed while staged EOL repair was applied"),
        code: "EOL_CONCURRENT_CHANGE",
        before,
        target,
        eol_style: eolStyle,
        converter,
        concurrent_change_detected: true
      };
    }
    const diff = await svnDiff({ cwd: context.cwd, paths: [filePath], ignoreEol: true, lineLimit: defaultDiffLineLimit() });
    const pureEolChurn = diff.ok && !diff.per_file_truncated && diff.per_file.every((file) =>
      file.added === 0 && file.removed === 0 && !file.binary && !file.property_changed
    );

    return {
      ...envelopeFromRun({
        run: conversion,
        ok: true,
        note: pureEolChurn ? "pure EOL churn verified" : "EOL fixed; content diff remains"
      }),
      before,
      after,
      target,
      eol_style: eolStyle,
      converter,
      normalized_content_hash: normalizedHashAfter,
      verification_command: diff.command,
      diff_ignored_eol: true,
      pure_eol_churn: pureEolChurn
    };
  } finally {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
}

function eolKind(value: unknown): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>).kind : undefined;
}

function pathIsFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function normalizedCompositePaths(cwd: string, paths: string[]): string[] {
  return paths.map((candidate) => pathIdentityKey(path.resolve(cwd, candidate))).sort();
}
