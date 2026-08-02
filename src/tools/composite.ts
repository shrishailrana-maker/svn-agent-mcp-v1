import fs from "node:fs";
import os from "node:os";
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
  isBinaryKind,
  normalizeEolTarget,
  normalizedContentHashFile,
  restoreBackupIfUnchanged,
  sniffEol
} from "../eol.js";
import { sha256File } from "../fileHash.js";
import {
  assertExistingTargets,
  isCommittableStatus,
  isInsideOrEqual,
  neverCommitHit,
  neverCommitNote,
  pathIdentityKey,
  readonlyMode,
  repoRelativePath,
  requireExplicitPaths,
  resolveCwd,
  resolveTargetsInsideWc,
  validateCommitMessage
} from "../guards.js";
import { escapeSvnTarget, runSvn, runSvnVersion } from "../runner.js";
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
  svnDiff,
  svnInfo,
  svnStatus
} from "./readonly.js";

export async function svnSnapshot(input: {
  cwd?: string;
  paths?: string[];
  includeIgnored?: boolean;
  hideNoise?: boolean;
  fields?: string[];
  captureBaseline?: boolean;
}): Promise<ToolEnvelope> {
  if (input.captureBaseline && (!input.paths || input.paths.length === 0)) {
    return failEnvelope("svn snapshot", resolveCwd(input.cwd), "captureBaseline requires explicit paths");
  }
  const requested = new Set(input.fields ?? []);
  const projected = requested.size > 0;
  const statusFields = ["changedPaths", "counts", "items", "conflicts"];
  const infoFields = [
    "revision", "revisionRange", "mixedRevision", "localModifications", "switched", "partial",
    "remoteHeadRevision", "staleBase"
  ];
  const needStatus = input.captureBaseline === true || !projected || statusFields.some((field) => requested.has(field));
  const needInfo = input.captureBaseline === true || !projected || infoFields.some((field) => requested.has(field));
  const [status, info] = await Promise.all([
    needStatus ? svnStatus(input) : Promise.resolve(null),
    needInfo ? svnInfo({
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.paths === undefined ? {} : { paths: input.paths })
    }) : Promise.resolve(null)
  ]);
  const ok = (status?.ok ?? true) && (info?.ok ?? true);
  const cwd = status?.cwd ?? info?.cwd ?? resolveCwd(input.cwd);
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
    mixed_revision: info?.mixed_revision,
    revision_range: info?.revision_range,
    local_modifications: info?.local_modifications,
    switched: info?.switched,
    partial: info?.partial,
    remote_head_revision: info?.remote_head_revision,
    stale_base: info?.stale_base,
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

export async function svnPrecommit(input: {
  cwd?: string;
  paths: string[];
  lineLimit?: number;
  allowRoot?: boolean;
  allowDirectoryTargets?: boolean;
  expandDescendants?: boolean;
  requireUniformRevision?: boolean;
  baselineToken?: string;
}): Promise<ToolEnvelope> {
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
    const never = neverCommitHit(target, context.wcRoot);
    const guard = never
      ? neverCommitNote(never, target, context.wcRoot)
      : !statusCode || statusCode === "?" || statusCode === "!" || statusCode === "I"
        ? `path is not committable: ${repoRelativePath(target, context.wcRoot)}`
        : !isCommittableStatus(statusCode)
          ? `path has non-committable status (${statusCode}): ${repoRelativePath(target, context.wcRoot)}`
          : conflictedTargets.has(targetKey)
            ? `path has unresolved conflicts: ${repoRelativePath(target, context.wcRoot)}`
            : null;

    if (guard) {
      guardNotes.push(guard);
    }

    const pureEolChurn = statusCode === "M" && !diffFile;
    if (eolFile?.mismatch || pureEolChurn) {
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
      eol_mismatch: eolFile?.mismatch ?? false,
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
    mixedRevision ? "mixed revision working copy" : "",
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
    eol_policy_identity: eolPolicyIdentity,
    ...(remediation ? { remediation } : {}),
    diff_excerpt: diff.diff_excerpt,
    truncated: diff.truncated,
    ...(scope.expanded ? { scope_expanded: true, expanded_paths: scope.expandedPaths } : {})
  };
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
    return prepareCommitFailure(
      preflightScope.envelope ?? failEnvelope("svn_prepare_commit", context.cwd, preflightScope.note),
      "GUARD_BLOCKED"
    );
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

  const precommit = await svnPrecommit({
    cwd: context.cwd,
    paths: input.paths,
    ...(input.lineLimit === undefined ? {} : { lineLimit: input.lineLimit }),
    ...(input.allowRoot === undefined ? {} : { allowRoot: input.allowRoot }),
    ...(input.allowDirectoryTargets === undefined ? {} : { allowDirectoryTargets: input.allowDirectoryTargets }),
    ...(input.expandDescendants === undefined ? {} : { expandDescendants: input.expandDescendants }),
    ...(input.requireUniformRevision === undefined ? {} : { requireUniformRevision: input.requireUniformRevision })
  });
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
    precommit
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
      ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
      ...(input.baselineToken === undefined ? {} : { baselineToken: input.baselineToken })
    });
  }
  if (input.message === undefined) {
    return failEnvelope("svn commit", resolveCwd(input.cwd), "operation:commit requires message");
  }
  return svnCommit({
    paths: input.paths,
    message: input.message,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.riskAck === undefined ? {} : { riskAck: input.riskAck }),
    ...(input.allowRoot === undefined ? {} : { allowRoot: input.allowRoot }),
    ...(input.allowDirectoryTargets === undefined ? {} : { allowDirectoryTargets: input.allowDirectoryTargets }),
    ...(input.expandDescendants === undefined ? {} : { expandDescendants: input.expandDescendants }),
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    ...(input.precommitToken === undefined ? {} : { precommitToken: input.precommitToken })
  });
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
      requireUniformRevision: input.requireUniformRevision ?? false
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
    baselineToken
  });
  stages.push({ stage: "prepare", result: prepared });
  let precommit = prepared.precommit && typeof prepared.precommit === "object"
    ? prepared.precommit as ToolEnvelope
    : null;
  const finalScope = (stringList(prepared.final_commit_scope).length > 0
    ? stringList(prepared.final_commit_scope)
    : input.paths)
    .map((candidate) => path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(resolveCwd(input.cwd), candidate));

  if (prepared.verdict === "EOL_FIX_NEEDED" && precommit) {
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
    precommit = await svnPrecommit({
      paths: finalScope,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.lineLimit === undefined ? {} : { lineLimit: input.lineLimit }),
      ...(input.requireUniformRevision === undefined ? {} : { requireUniformRevision: input.requireUniformRevision }),
      ...(input.allowRoot === undefined ? {} : { allowRoot: input.allowRoot }),
      // finalScope was produced and guarded by prepare; internal revalidation
      // must accept directory nodes introduced by descendant expansion.
      allowDirectoryTargets: true
    });
    stages.push({ stage: "precommit_after_eol", result: precommit });
  }

  if (!precommit || precommit.verdict !== "READY" || typeof precommit.precommit_token !== "string") {
    const note = precommit?.note || prepared.note || "safe commit precommit did not reach READY";
    const failed = safeCommitFailure(resolveCwd(input.cwd), String(precommit?.verdict ?? prepared.verdict ?? "PRECOMMIT_FAILED"), note);
    return attachSafeDetail(effectiveInput, failed, stages);
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
    baseline_captured_automatically: baselineCapturedAutomatically
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

export async function eolFixVerified(input: {
  cwd?: string;
  path?: string;
  paths?: string[];
  target?: "crlf" | "lf";
  removeBom?: boolean;
  dryRun?: boolean;
  allowLarge?: boolean;
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
        allowLarge: input.allowLarge ?? false
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
      ...(result.ok ? {} : { failure: result.note })
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

  const backupDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "svn-agent-eol-fix-"));
  const backupFile = path.join(backupDir, "original.bin");
  try {
    await fs.promises.copyFile(filePath, backupFile);
    const conversion = await convertEol({
      filePath,
      target,
      removeBom: input.removeBom ?? true,
      cwd: context.cwd
    });
    if (conversion.exitCode !== 0) {
      return {
        ...envelopeFromRun({
          run: conversion,
          ok: false,
          note: noteFromRun(conversion)
        }),
        target,
        eol_style: eolStyle,
        converter,
        before
      };
    }

    const convertedHash = await sha256File(filePath);
    const after = await sniffEol(filePath, input.allowLarge ? Number.MAX_SAFE_INTEGER : undefined);
    const normalizedHashAfter = await normalizedContentHashFile(filePath);
    const contentPreserved = normalizedHashAfter === normalizedHashBefore;
    const targetVerified = (after.kind === target || after.kind === "none") && !after.has_bom;
    if (!contentPreserved || !targetVerified) {
      const restore = await restoreBackupIfUnchanged(filePath, backupFile, convertedHash);
      return {
        ...failEnvelope(
          "eol_fix_verified",
          context.cwd,
          restore === "restored"
            ? "normalized content or EOL verification failed; original restored"
            : restore === "changed"
              ? "normalized content or EOL verification failed; original not restored because the file changed concurrently"
              : "normalized content or EOL verification failed; restoring the original also failed"
        ),
        before,
        after,
        target,
        eol_style: eolStyle,
        converter,
        normalized_content_hash: normalizedHashAfter,
        pure_eol_churn: false,
        original_restored: restore === "restored",
        ...(restore === "changed" ? { concurrent_change_detected: true } : {})
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
