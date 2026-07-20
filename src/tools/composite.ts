import fs from "node:fs";
import path from "node:path";
import { createEnvelope, envelopeFromRun, failEnvelope, noteFromRun } from "../envelope.js";
import { converterForEolTarget, convertEol, isBinaryKind, normalizeEolTarget, sniffEol } from "../eol.js";
import {
  assertExistingTargets,
  neverCommitHit,
  neverCommitNote,
  readonlyMode,
  repoRelativePath,
  requireExplicitPaths,
  resolveCwd,
  resolveTargetsInsideWc
} from "../guards.js";
import { parseDiffText } from "../parse/diffText.js";
import { runSvn, runSvnVersion } from "../runner.js";
import type { ToolEnvelope } from "../types.js";
import {
  defaultDiffLineLimit,
  dryRiskSignals,
  eolCheck,
  getWcContext,
  normalizeStatusLookup,
  scopedStatusMap,
  svnDiff
} from "./readonly.js";

export async function svnPrecommit(input: { cwd?: string; paths: string[]; lineLimit?: number }): Promise<ToolEnvelope> {
  const explicitError = requireExplicitPaths(input.paths);
  const cwd = resolveCwd(input.cwd);
  if (explicitError) {
    return {
      ...failEnvelope("svn_precommit", cwd, explicitError),
      verdict: "GUARD_BLOCKED",
      per_file: [],
      risk_signals: [],
      diff_excerpt: ""
    };
  }

  const context = await getWcContext(input.cwd, input.paths);
  if (!context.ok) {
    return {
      ...context.envelope,
      verdict: "GUARD_BLOCKED",
      per_file: [],
      risk_signals: [],
      diff_excerpt: ""
    };
  }

  const resolved = resolveTargetsInsideWc(context.cwd, context.wcRoot, input.paths);
  if (!resolved.ok) {
    return {
      ...failEnvelope("svn_precommit", context.cwd, resolved.note),
      verdict: "GUARD_BLOCKED",
      per_file: [],
      risk_signals: [],
      diff_excerpt: ""
    };
  }

  const status = await scopedStatusMap(context.cwd, context.wcRoot, input.paths);
  if (!status.envelope.ok) {
    return {
      ...status.envelope,
      verdict: "GUARD_BLOCKED",
      per_file: [],
      risk_signals: [],
      diff_excerpt: ""
    };
  }

  const diff = await svnDiff({
    cwd: context.cwd,
    paths: input.paths,
    ignoreEol: true,
    lineLimit: input.lineLimit ?? defaultDiffLineLimit()
  });
  const eol = await eolCheck({ cwd: context.cwd, paths: input.paths });
  const eolFiles = new Map(
    ((eol.files as Array<{ path: string }> | undefined) ?? []).map((file) => [path.resolve(file.path).toLowerCase(), file])
  );
  const diffFiles = new Map(diff.per_file.map((file) => [path.resolve(context.cwd, file.path).toLowerCase(), file]));
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
    const lower = target.toLowerCase();
    const statusCode = normalizeStatusLookup(status.map, target);
    const diffFile = diffFiles.get(lower);
    const eolFile = eolFiles.get(lower) as
      | { kind?: string; eol_style?: string | null; has_bom?: boolean; mismatch?: boolean }
      | undefined;
    const never = neverCommitHit(target, context.wcRoot);
    const guard = never
      ? neverCommitNote(never, target, context.wcRoot)
      : !statusCode || statusCode === "?" || statusCode === "!" || statusCode === "I"
        ? `path is not committable: ${repoRelativePath(target, context.wcRoot)}`
        : null;

    if (guard) {
      guardNotes.push(guard);
    }

    const pureEolChurn = statusCode === "M" && !diffFile;
    if (eolFile?.mismatch || pureEolChurn) {
      needsEolFix = true;
    }
    if (statusCode && statusCode !== "?" && statusCode !== "!" && statusCode !== "I" && !pureEolChurn) {
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

  const version = await runSvnVersion(context.cwd, context.cwd);
  const mixedRevision = version.exitCode === 0 && version.stdout.includes(":");
  const verdict = guardNotes.length > 0
    ? "GUARD_BLOCKED"
    : !diff.ok && diff.recovery_tool !== "eol_fix_verified"
      ? "DIFF_FAILED"
      : needsEolFix
        ? "EOL_FIX_NEEDED"
        : !hasRealChange
          ? "NOTHING_TO_COMMIT"
          : "READY";

  const notes = [
    verdict,
    ...guardNotes,
    ...diffNotes,
    mixedRevision ? "mixed revision working copy" : ""
  ].filter(Boolean);

  return {
    ...createEnvelope({
      ok: verdict !== "GUARD_BLOCKED" && verdict !== "DIFF_FAILED",
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
    diff_excerpt: diff.diff_excerpt,
    truncated: diff.truncated
  };
}

export async function eolFixVerified(input: {
  cwd?: string;
  path: string;
  target?: "crlf" | "lf";
  removeBom?: boolean;
  dryRun?: boolean;
  allowLarge?: boolean;
}): Promise<ToolEnvelope> {
  const cwd = resolveCwd(input.cwd);
  if (readonlyMode()) {
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

  const filePath = resolved.paths[0]!;
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

  const prop = await runSvn(["propget", "svn:eol-style", filePath], context.cwd);
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
  const diff = await svnDiff({ cwd: context.cwd, paths: [filePath], ignoreEol: true, lineLimit: defaultDiffLineLimit() });
  const pureEolChurn = diff.ok && diff.diff_excerpt.trim() === "";

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
    verification_command: diff.command,
    diff_ignored_eol: true,
    pure_eol_churn: pureEolChurn
  };
}

function pathIsFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
