import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveCommitScope } from "../commitScope.js";
import { createEnvelope, envelopeFromRun, failEnvelope, noteFromRun } from "../envelope.js";
import { converterForEolTarget, convertEol, isBinaryKind, normalizeEolTarget, normalizedContentHash, sniffEol } from "../eol.js";
import {
  assertExistingTargets,
  isCommittableStatus,
  isInsideOrEqual,
  neverCommitHit,
  neverCommitNote,
  pathIdentityKey,
  readonlyMode,
  repositoryEolPolicy,
  repoRelativePath,
  requireExplicitPaths,
  resolveCwd,
  resolveTargetsInsideWc
} from "../guards.js";
import { escapeSvnTarget, runSvn, runSvnVersion } from "../runner.js";
import type { ToolEnvelope } from "../types.js";
import { svnCommit, svnUpdate } from "./mutating.js";
import {
  defaultDiffLineLimit,
  dryRiskSignals,
  eolCheck,
  getWcContext,
  normalizeStatusLookup,
  parseSvnVersion,
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
}): Promise<ToolEnvelope> {
  const requested = new Set(input.fields ?? []);
  const projected = requested.size > 0;
  const statusFields = ["changedPaths", "counts", "items", "conflicts"];
  const infoFields = [
    "revision", "revisionRange", "mixedRevision", "localModifications", "switched", "partial",
    "remoteHeadRevision", "staleBase"
  ];
  const needStatus = !projected || statusFields.some((field) => requested.has(field));
  const needInfo = !projected || infoFields.some((field) => requested.has(field));
  const [status, info] = await Promise.all([
    needStatus ? svnStatus(input) : Promise.resolve(null),
    needInfo ? svnInfo({
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.paths === undefined ? {} : { paths: input.paths })
    }) : Promise.resolve(null)
  ]);
  const ok = (status?.ok ?? true) && (info?.ok ?? true);
  const cwd = status?.cwd ?? info?.cwd ?? resolveCwd(input.cwd);
  return {
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
}

export async function svnPrecommit(input: {
  cwd?: string;
  paths: string[];
  lineLimit?: number;
  allowRoot?: boolean;
  allowDirectoryTargets?: boolean;
  expandDescendants?: boolean;
  requireUniformRevision?: boolean;
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
  const eolPolicy = repositoryEolPolicy(context.wcRoot);
  const eolPolicyIdentity = `sha256:${createHash("sha256")
    .update(JSON.stringify({ target: eolPolicy.target, excludes: eolPolicy.excludes }))
    .digest("hex")}`;
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

  return {
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
}): Promise<ToolEnvelope> {
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
    ...(input.expectedRemoteHead === undefined ? {} : { expectedRemoteHead: input.expectedRemoteHead })
  });
  if (!updated.ok) {
    const verdict = updated.note.includes("remote HEAD changed") ? "REMOTE_HEAD_CHANGED" : "UPDATE_FAILED";
    return prepareCommitFailure(updated, verdict);
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
  operation?: "commit" | "prepare";
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
}): Promise<ToolEnvelope> {
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
      ...(input.requireUniformRevision === undefined ? {} : { requireUniformRevision: input.requireUniformRevision })
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
    ...(input.expandDescendants === undefined ? {} : { expandDescendants: input.expandDescendants })
  });
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
}): Promise<ToolEnvelope> {
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

  const before = await sniffEol(filePath);
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
  const originalBytes = fs.readFileSync(filePath);
  const normalizedHashBefore = normalizedContentHash(originalBytes);

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

  const after = await sniffEol(filePath);
  const normalizedHashAfter = normalizedContentHash(fs.readFileSync(filePath));
  const contentPreserved = normalizedHashAfter === normalizedHashBefore;
  const targetVerified = (after.kind === target || after.kind === "none") && !after.has_bom;
  if (!contentPreserved || !targetVerified) {
    fs.writeFileSync(filePath, originalBytes);
    return {
      ...failEnvelope("eol_fix_verified", context.cwd, "normalized content or EOL verification failed; original restored"),
      before,
      after,
      target,
      eol_style: eolStyle,
      converter,
      normalized_content_hash: normalizedHashAfter,
      pure_eol_churn: false
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
