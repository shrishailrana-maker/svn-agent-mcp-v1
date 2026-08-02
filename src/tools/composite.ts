import fs from "node:fs";
import path from "node:path";
import { createEnvelope, envelopeFromRun, failEnvelope, noteFromRun } from "../envelope.js";
import { converterForEolTarget, convertEol, isBinaryKind, normalizeEolTarget, normalizedContentHash, sniffEol } from "../eol.js";
import {
  assertExistingTargets,
  findExistingDirectoryTarget,
  isCommittableStatus,
  neverCommitHit,
  neverCommitNote,
  pathIdentityKey,
  readonlyMode,
  repoRelativePath,
  requireExplicitPaths,
  resolveCwd,
  resolveTargetsInsideWc
} from "../guards.js";
import { escapeSvnTarget, runSvn, runSvnVersion } from "../runner.js";
import type { ToolEnvelope } from "../types.js";
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
  const directoryTarget = findExistingDirectoryTarget(resolved.paths);
  if (!directoryTarget.ok) {
    return blockedPrecommit(failEnvelope("svn_precommit", context.cwd, directoryTarget.note));
  }
  if (directoryTarget.target && !input.allowDirectoryTargets) {
    return blockedPrecommit(failEnvelope(
      "svn_precommit",
      context.cwd,
      `directory commit target requires allowDirectoryTargets:true because --depth empty excludes descendants: ${repoRelativePath(directoryTarget.target, context.wcRoot)}`
    ));
  }

  const status = await scopedStatusMap(context.cwd, context.wcRoot, input.paths);
  if (!status.envelope.ok) {
    return blockedPrecommit(status.envelope);
  }

  const diff = await svnDiff({
    cwd: context.cwd,
    paths: input.paths,
    ignoreEol: true,
    lineLimit: input.lineLimit ?? defaultDiffLineLimit()
  });
  const eol = await eolCheck({ cwd: context.cwd, paths: input.paths });
  const eolFiles = new Map(
    ((eol.files as Array<{ path: string }> | undefined) ?? []).map((file) => [pathIdentityKey(file.path), file])
  );
  const diffFiles = new Map(diff.per_file.map((file) => [pathIdentityKey(path.resolve(context.cwd, file.path)), file]));
  const conflictedTargets = new Set(
    status.envelope.conflicts.map((conflict) => pathIdentityKey(path.resolve(context.cwd, conflict.path)))
  );
  const riskSignals = dryRiskSignals(resolved.paths, context.wcRoot, status.map);
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

  for (const target of resolved.paths) {
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
    ...(remediation ? { remediation } : {}),
    diff_excerpt: diff.diff_excerpt,
    truncated: diff.truncated
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
