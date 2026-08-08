import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { createEnvelope, envelopeFromRun, failEnvelope, noteFromRun, redactText } from "../envelope.js";
import { makeEolCheck } from "../eol.js";
import { processEvidenceStore } from "../evidenceStore.js";
import {
  assertExistingTargets,
  isInsideOrEqual,
  pathIdentityKey,
  realPathOfNearestExisting,
  repoRelativePath,
  requireExplicitPaths,
  resolveCwd,
  resolveTargetsInsideWc,
  riskySignals,
  statusMap,
  validatePropertyName,
  wcRootFromInfo
} from "../guards.js";
import { parseBlameXml } from "../parse/blameXml.js";
import { createDiffAccumulator } from "../parse/diffText.js";
import { parseInfoXml } from "../parse/infoXml.js";
import { parseLogXml } from "../parse/logXml.js";
import { parseStatusXml } from "../parse/statusXml.js";
import { svnXmlEntityLimits } from "../parse/xmlOptions.js";
import { escapeSvnTarget, runSvn, runSvnStreamingLines, runSvnVersion } from "../runner.js";
import type { ChangedPath, DiffSummary, EolCheckResult, Envelope, SvnLockInfo, ToolEnvelope, WcInfo } from "../types.js";

export interface ToolInputWithCwd {
  cwd?: string;
}

export const STALE_LOCK_CANDIDATE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_COMMENT_OUTPUT_LIMIT = 512;

export interface LockInspection {
  path: string;
  repository_path: string;
  repository_url: string | null;
  local_lock: SvnLockInfo | null;
  repository_lock: SvnLockInfo | null;
}

export type LockInspectionResult =
  | { ok: true; cwd: string; wcRoot: string; rows: LockInspection[]; run: Awaited<ReturnType<typeof runSvn>> }
  | { ok: false; envelope: ToolEnvelope };

const propgetParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "text",
  parseTagValue: false,
  trimValues: false,
  processEntities: svnXmlEntityLimits
});

const EVIDENCE_PER_FILE_LIMIT = 200;
const EVIDENCE_PREVIEW_CHAR_LIMIT = 512;

export async function getWcContext(cwdInput?: string, pathHints: string[] = []): Promise<{ ok: true; cwd: string; info: WcInfo; wcRoot: string } | { ok: false; envelope: Envelope }> {
  if (!cwdInput && !pathHints.some((hint) => path.isAbsolute(hint))) {
    return {
      ok: false,
      envelope: failEnvelope("svn info --xml", process.cwd(), "cwd or absolute path required")
    };
  }

  let lastRun: Awaited<ReturnType<typeof runSvn>> | null = null;

  for (const probe of wcProbeCandidates(cwdInput, pathHints)) {
    const run = await runSvn(["info", "--xml", "--", escapeSvnTarget(probe.target)], probe.execCwd);
    if (run.exitCode !== 0) {
      lastRun = run;
      continue;
    }

    const entries = parseInfoXml(run.stdout);
    const rawWcRoot = wcRootFromInfo(entries);
    if (!rawWcRoot) {
      return {
        ok: false,
        envelope: failEnvelope(run.command, probe.execCwd, "path is not inside a working copy")
      };
    }
    const wcRoot = realPathOfNearestExisting(rawWcRoot);

    return {
      ok: true,
      cwd: probe.cwd ? realPathOfNearestExisting(probe.cwd) : wcRoot,
      info: entries[0] ?? { url: null, repo_root: null, wc_root: wcRoot, revision: null },
      wcRoot
    };
  }

  if (lastRun) {
    return {
      ok: false,
      envelope: envelopeFromRun({
        run: lastRun,
        ok: false,
        note: noteFromRun(lastRun)
      })
    };
  }

  const cwd = resolveCwd(cwdInput);
  return {
    ok: false,
    envelope: failEnvelope("svn info --xml", cwd, "path is not inside a working copy")
  };
}

export async function svnStatus(input: {
  cwd?: string;
  paths?: string[];
  includeIgnored?: boolean;
  hideNoise?: boolean;
  includeRevisionState?: boolean;
  depth?: "empty";
}): Promise<ToolEnvelope> {
  const context = await getWcContext(input.cwd, input.paths ?? []);
  if (!context.ok) {
    return context.envelope;
  }

  const targets = input.paths && input.paths.length > 0 ? input.paths : [];
  const resolved = resolveTargetsInsideWc(context.cwd, context.wcRoot, targets.length > 0 ? targets : [context.cwd]);
  if (!resolved.ok) {
    return failEnvelope("svn status --xml", context.cwd, resolved.note);
  }

  const args = [
    "status",
    "--xml",
    ...(input.includeIgnored ? ["--no-ignore"] : []),
    ...(input.depth ? ["--depth", input.depth] : []),
    ...(targets.length > 0 ? ["--", ...resolved.paths.map(escapeSvnTarget)] : [])
  ];
  const run = await runSvn(args, context.cwd);
  const versionRun = run.exitCode === 0 && input.includeRevisionState === true
    ? await runSvnVersion(context.wcRoot, context.cwd)
    : null;
  const versionState = versionRun?.exitCode === 0
    ? parseSvnVersion(versionRun.stdout)
    : { range: null, mixed: false, modified: false, switched: false, partial: false };
  const parsed: ReturnType<typeof parseStatusXml> = run.exitCode === 0
    ? parseStatusXml(run.stdout)
    : { changed_paths: [], conflicts: [], out_of_date_paths: [] };
  if (run.exitCode === 0 && input.includeIgnored && /W155010/.test(`${run.stderr}\n${run.stdout}`)) {
    const knownPaths = new Set(parsed.changed_paths.map((entry) => pathIdentityKey(path.resolve(context.cwd, entry.path))));
    for (const target of resolved.paths) {
      if (knownPaths.has(pathIdentityKey(target)) || !fs.existsSync(target)) {
        continue;
      }
      const ignoredAncestor = await findIgnoredAncestor(context.cwd, context.wcRoot, target);
      if (ignoredAncestor) {
        parsed.changed_paths.push({
          status: "I",
          path: target,
          covered_by_ignored_ancestor: true,
          ignored_ancestor: repoRelativePath(ignoredAncestor, context.wcRoot)
        });
      }
    }
  }
  const filtered = input.hideNoise ? filterNoisePaths(parsed.changed_paths, context.cwd, context.wcRoot) : {
    changed_paths: parsed.changed_paths,
    filtered_paths: []
  };
  return {
    ...envelopeFromRun({
      run,
      ok: run.exitCode === 0,
      changed_paths: filtered.changed_paths,
      conflicts: parsed.conflicts,
      note: run.exitCode === 0 ? successfulRunWarning(run.stderr) : noteFromRun(run)
    }),
    wc_root: context.wcRoot,
    revision: versionState.range && versionState.range.min === versionState.range.max
      ? versionState.range.max
      : null,
    revision_range: versionState.range,
    mixed_revision: versionState.mixed,
    svnversion: versionRun?.exitCode === 0 ? versionRun.stdout.trim() : null,
    filtered_paths: filtered.filtered_paths
  };
}

export async function svnInfo(input: { cwd?: string; paths?: string[] }): Promise<ToolEnvelope> {
  const context = await getWcContext(input.cwd, input.paths ?? []);
  if (!context.ok) {
    return context.envelope;
  }

  const targets = input.paths && input.paths.length > 0 ? input.paths : [context.cwd];
  const resolved = resolveTargetsInsideWc(context.cwd, context.wcRoot, targets);
  if (!resolved.ok) {
    return failEnvelope("svn info --xml", context.cwd, resolved.note);
  }

  const run = await runSvn(["info", "--xml", "--", ...resolved.paths.map(escapeSvnTarget)], context.cwd);
  const entries = run.exitCode === 0 ? parseInfoXml(run.stdout) : [];
  const versionNotes: string[] = [];
  let mixedRevision = false;
  let modified = false;
  let switched = false;
  let partial = false;
  let revisionRange: { min: number; max: number } | null = null;
  let svnVersion = "";

  const version = await runSvnVersion(context.wcRoot, context.cwd);
  if (version.exitCode === 0) {
    const value = version.stdout.trim();
    svnVersion = value;
    const parsed = parseSvnVersion(value);
    mixedRevision = mixedRevision || parsed.mixed;
    modified = modified || parsed.modified;
    switched = switched || parsed.switched;
    partial = partial || parsed.partial;
    revisionRange = mergeRevisionRange(revisionRange, parsed.range);
  }

  if (mixedRevision) {
    versionNotes.push("mixed revision working copy");
  }
  if (modified) {
    versionNotes.push("local modifications present");
  }
  if (switched) {
    versionNotes.push("switched path present");
  }
  if (partial) {
    versionNotes.push("partial working copy");
  }

  const first = entries[0] ?? context.info;
  let remoteHeadRevision = await remoteHeadForTargets(context.cwd, resolved.paths);
  if (remoteHeadRevision === null) {
    remoteHeadRevision = await remoteHeadForTargets(context.cwd, [first.repo_root ?? context.info.repo_root ?? context.wcRoot]);
  }
  const remoteHeadUnavailableReason = remoteHeadRevision === null
    ? "repository HEAD unavailable after scoped and repository-root probes"
    : null;
  if (remoteHeadRevision !== null && revisionRange && remoteHeadRevision > revisionRange.max) {
    versionNotes.push(`remote HEAD newer than working copy (${remoteHeadRevision} > ${revisionRange.max})`);
  }
  return {
    ...envelopeFromRun({
      run,
      ok: run.exitCode === 0,
      revision: first.revision,
      note: run.exitCode === 0 ? versionNotes.join("; ") : noteFromRun(run)
    }),
    url: first.url,
    repo_root: first.repo_root,
    wc_root: first.wc_root,
    entries,
    mixed_revision: mixedRevision,
    svnversion: svnVersion,
    revision_range: revisionRange,
    local_modifications: modified,
    switched,
    partial,
    remote_head_revision: remoteHeadRevision,
    ...(remoteHeadUnavailableReason ? { remote_head_unavailable_reason: remoteHeadUnavailableReason } : {}),
    stale_base: remoteHeadRevision !== null && revisionRange !== null ? remoteHeadRevision > revisionRange.max : false
  };
}

export async function svnDiff(input: {
  cwd?: string;
  paths: string[];
  ignoreEol?: boolean;
  showEolChanges?: boolean;
  lineLimit?: number;
  cursor?: string;
  revision?: string;
  file?: string;
  operationId?: string;
}): Promise<ToolEnvelope & DiffSummary> {
  const explicitError = requireExplicitPaths(input.paths);
  const cwd = resolveCwd(input.cwd);
  if (explicitError) {
    return {
      ...failEnvelope("svn diff", cwd, explicitError),
      per_file: [],
      per_file_truncated: false,
      diff_excerpt: "",
      truncated: false,
      total_files: 0,
      total_lines: 0,
      total_chars: 0,
      total_hunks: 0,
      total_added: 0,
      total_removed: 0,
      binary_files: 0,
      property_files: 0
    };
  }

  const revisionError = revisionSelectorError(input.revision);
  if (revisionError) {
    return {
      ...failEnvelope("svn diff", cwd, revisionError),
      per_file: [],
      per_file_truncated: false,
      diff_excerpt: "",
      truncated: false,
      total_files: 0,
      total_lines: 0,
      total_chars: 0,
      total_hunks: 0,
      total_added: 0,
      total_removed: 0,
      binary_files: 0,
      property_files: 0
    };
  }

  const context = await getWcContext(input.cwd, input.paths);
  if (!context.ok) {
    return {
      ...context.envelope,
      per_file: [],
      per_file_truncated: false,
      diff_excerpt: "",
      truncated: context.envelope.truncated,
      total_files: 0,
      total_lines: 0,
      total_chars: 0,
      total_hunks: 0,
      total_added: 0,
      total_removed: 0,
      binary_files: 0,
      property_files: 0
    };
  }

  const resolved = resolveTargetsInsideWc(context.cwd, context.wcRoot, input.paths);
  if (!resolved.ok) {
    return {
      ...failEnvelope("svn diff", context.cwd, resolved.note),
      per_file: [],
      per_file_truncated: false,
      diff_excerpt: "",
      truncated: false,
      total_files: 0,
      total_lines: 0,
      total_chars: 0,
      total_hunks: 0,
      total_added: 0,
      total_removed: 0,
      binary_files: 0,
      property_files: 0
    };
  }

  let effectivePaths = resolved.paths;
  if (input.file) {
    const selected = resolveTargetsInsideWc(context.cwd, context.wcRoot, [input.file]);
    if (!selected.ok || !selected.paths[0]) {
      return emptyDiffEnvelope(context.cwd, selected.ok ? "explicit diff file required" : selected.note);
    }
    const selectedPath = selected.paths[0];
    if (!resolved.paths.some((scopePath) => isInsideOrEqual(selectedPath, scopePath))) {
      return emptyDiffEnvelope(context.cwd, "selected diff file is outside the explicit path scope");
    }
    effectivePaths = [selectedPath];
  }

  const lineLimit = input.lineLimit ?? defaultDiffLineLimit();
  const lineOffset = cursorValue(input.cursor);
  const ignoreEol = input.showEolChanges ? false : input.ignoreEol ?? true;
  const evidenceScope = diffEvidenceScope(context.wcRoot, effectivePaths, input.revision, ignoreEol);
  if (input.operationId) {
    const evidence = processEvidenceStore.get(input.operationId, "svn_diff", evidenceScope);
    if (!evidence.ok) {
      return {
        ...emptyDiffEnvelope(context.cwd, evidence.note),
        code: evidence.code,
        wc_root: context.wcRoot
      };
    }
    const storedSummary = evidence.metadata.summary as DiffSummary;
    const evidenceTruncated = evidence.truncated || evidence.metadata.sourceTruncated === true;
    const lines = evidence.text ? evidence.text.split("\n") : [];
    const page = lines.slice(lineOffset, lineOffset + lineLimit);
    const nextOffset = lineOffset + page.length;
    const hasMore = nextOffset < lines.length;
    return {
      ...createEnvelope({
        ok: true,
        command: "svn diff evidence",
        cwd: context.cwd,
        truncated: hasMore || evidenceTruncated
      }),
      ...storedSummary,
      diff_excerpt: page.join("\n"),
      truncated: hasMore || evidenceTruncated,
      wc_root: context.wcRoot,
      page_offset: lineOffset,
      ...(hasMore ? { next_cursor: String(nextOffset) } : {}),
      operation_id: input.operationId,
      evidence_expires_at: evidence.expiresAt,
      evidence_truncated: evidenceTruncated,
      evidence_terminal_truncation: evidenceTruncated && !hasMore,
      ignore_eol: ignoreEol
    };
  }
  const revisionArgs = input.revision
    ? [isRevisionRange(input.revision) ? "-r" : "-c", input.revision]
    : [];
  // Working-copy diffs treat local operands literally; appending '@' changes
  // valid filenames. Revision diffs enable peg parsing and require escaping.
  const diffTargets = revisionArgs.length > 0 ? effectivePaths.map(escapeSvnTarget) : effectivePaths;
  const args = ignoreEol
    ? ["diff", ...revisionArgs, "--internal-diff", "-x", "--ignore-eol-style", "--", ...diffTargets]
    : ["diff", ...revisionArgs, "--internal-diff", "--", ...diffTargets];
  const diffAccumulator = createDiffAccumulator(lineLimit, lineOffset);
  const run = await runSvnStreamingLines(args, context.cwd, diffAccumulator.pushLine, { stdoutLineLimit: lineLimit });
  const rawDiff = run.exitCode === 0
    ? diffAccumulator.summary()
    : {
        per_file: [], per_file_truncated: false, diff_excerpt: "", truncated: false,
        total_files: 0, total_lines: 0, total_chars: 0, total_hunks: 0,
        total_added: 0, total_removed: 0, binary_files: 0, property_files: 0
      };
  const diff = {
    ...rawDiff,
    diff_excerpt: redactText(rawDiff.diff_excerpt),
    truncated: rawDiff.truncated || Boolean(run.truncated)
  };
  const detail = diffAccumulator.detail();
  const storedEvidence = run.exitCode === 0
    ? processEvidenceStore.put("svn_diff", evidenceScope, redactText(detail.text), {
        summary: boundedEvidenceDiffSummary(diff),
        sourceTruncated: detail.truncated || Boolean(run.truncated)
      })
    : null;
  const eolDiagnostic = run.exitCode !== 0 && isInconsistentEolRun(run)
    ? await eolCheck({ cwd: context.cwd, paths: resolved.paths })
    : null;
  const ignoredDiffEmpty = run.exitCode === 0
    && ignoreEol
    && diff.per_file.length === 0
    && diff.diff_excerpt.length === 0;
  const ignoredStatus = ignoredDiffEmpty ? await svnStatus({ cwd: context.cwd, paths: resolved.paths }) : null;
  const eolOnly = ignoredStatus?.ok === true
    && ignoredStatus.changed_paths.some((entry) => entry.status === "M");
  const evidencePage = storedEvidence
    ? diffEvidencePage({
        pageOffset: lineOffset,
        pageLineCount: excerptLineCount(diff.diff_excerpt),
        storedLineCount: storedEvidence.storedLineCount,
        sourceTruncated: detail.truncated || Boolean(run.truncated) || storedEvidence.truncated
      })
    : null;
  return {
    ...envelopeFromRun({
      run,
      ok: run.exitCode === 0,
      note: run.exitCode === 0
        ? eolOnly
          ? "EOL-only, no content change"
          : input.showEolChanges
            ? "EOL changes included"
            : ""
        : noteFromRun(run),
      truncated: diff.truncated
    }),
    ...diff,
    totals_complete: run.callbackTruncated !== true,
    wc_root: context.wcRoot,
    page_offset: lineOffset,
    ...(evidencePage?.nextCursor ? { next_cursor: evidencePage.nextCursor } : {}),
    ...(storedEvidence
      ? {
          operation_id: storedEvidence.operationId,
          evidence_expires_at: storedEvidence.expiresAt,
          evidence_truncated: evidencePage?.sourceTruncated === true,
          evidence_terminal_truncation: evidencePage?.terminalTruncation === true
        }
      : {}),
    ignore_eol: ignoreEol,
    eol_only: eolOnly,
    ...(input.showEolChanges ? { eol_changes_included: true } : {}),
    ...(eolDiagnostic
      ? {
          recovery_tool: "eol_fix_verified",
          eol_files: eolDiagnostic.files ?? []
        }
      : {})
  };
}

/**
 * Inspect local and repository lock state without exposing lock bearer tokens.
 * The internal result is shared by `svn_lock_status` and normal `svn_unlock`
 * preflight checks. Callers must only copy the booleans and bounded metadata.
 */
export async function inspectLockState(input: { cwd?: string; paths: string[] }): Promise<LockInspectionResult> {
  const cwd = resolveCwd(input.cwd);
  const explicitError = requireExplicitPaths(input.paths);
  if (explicitError) {
    return { ok: false, envelope: failEnvelope("svn info --xml", cwd, explicitError) };
  }

  const context = await getWcContext(input.cwd, input.paths);
  if (!context.ok) {
    return { ok: false, envelope: context.envelope };
  }
  const resolved = resolveTargetsInsideWc(context.cwd, context.wcRoot, input.paths);
  if (!resolved.ok) {
    return { ok: false, envelope: failEnvelope("svn info --xml", context.cwd, resolved.note) };
  }
  const existsError = assertExistingTargets(resolved.paths);
  if (existsError) {
    return { ok: false, envelope: failEnvelope("svn info --xml", context.cwd, existsError) };
  }

  const localRun = await runSvn(
    ["info", "--xml", "--", ...resolved.paths.map(escapeSvnTarget)],
    context.cwd
  );
  if (localRun.exitCode !== 0) {
    return {
      ok: false,
      envelope: envelopeFromRun({ run: localRun, ok: false, note: noteFromRun(localRun) })
    };
  }
  const localEntries = parseInfoXml(localRun.stdout);
  if (localEntries.length === 0) {
    return { ok: false, envelope: failEnvelope(localRun.command, context.cwd, "target is not versioned") };
  }

  const localByPath = new Map<string, WcInfo>();
  for (const entry of localEntries) {
    if (!entry.path) continue;
    localByPath.set(pathIdentityKey(path.resolve(context.cwd, entry.path)), entry);
  }
  const urls = resolved.paths.map((target, index) => {
    const local = localByPath.get(pathIdentityKey(target)) ?? localEntries[index] ?? localEntries[0];
    return local?.url ?? null;
  });
  const uniqueUrls = [...new Set(urls.filter((value): value is string => Boolean(value)))];
  if (uniqueUrls.length === 0) {
    return { ok: false, envelope: failEnvelope(localRun.command, context.cwd, "target has no repository URL") };
  }

  // Query the repository URL, not the local WC path. Local info tells us only
  // whether this checkout carries a token; the URL is the current lock state.
  const repositoryRun = await runSvn(
    ["info", "--xml", "--", ...uniqueUrls.map(escapeSvnTarget)],
    context.cwd
  );
  if (repositoryRun.exitCode !== 0) {
    return {
      ok: false,
      envelope: envelopeFromRun({ run: repositoryRun, ok: false, note: noteFromRun(repositoryRun) })
    };
  }
  const repositoryEntries = parseInfoXml(repositoryRun.stdout);
  const repositoryByUrl = new Map<string, WcInfo>();
  for (const entry of repositoryEntries) {
    const key = entry.url ?? entry.path;
    if (key) repositoryByUrl.set(key, entry);
  }

  const rows: LockInspection[] = resolved.paths.map((target, index) => {
    const local = localByPath.get(pathIdentityKey(target)) ?? localEntries[index] ?? localEntries[0];
    const url = urls[index] ?? local?.url ?? null;
    const repository = (url ? repositoryByUrl.get(url) : undefined) ?? repositoryEntries[index] ?? repositoryEntries[0];
    return {
      path: repoRelativePath(target, context.wcRoot),
      repository_path: repositoryRelativePathFromUrl(
        url,
        repository?.repo_root ?? context.info.repo_root,
        repoRelativePath(target, context.wcRoot)
      ),
      repository_url: url,
      local_lock: local?.lock ?? null,
      repository_lock: repository?.lock ?? null
    };
  });

  return { ok: true, cwd: context.cwd, wcRoot: context.wcRoot, rows, run: repositoryRun };
}

export async function svnLockStatus(input: {
  cwd?: string;
  paths: string[];
  maxItems?: number;
  cursor?: string;
}): Promise<ToolEnvelope> {
  const inspected = await inspectLockState(input);
  if (!inspected.ok) {
    return inspected.envelope;
  }

  const rows = inspected.rows.map((row) => lockStatusRow(row));
  const offset = lockCursorOffset(input.cursor);
  const maxItems = Math.min(500, Math.max(1, input.maxItems ?? 100));
  const page = rows.slice(offset, offset + maxItems);
  const nextOffset = offset + page.length;
  return {
    ...envelopeFromRun({
      run: inspected.run,
      ok: true,
      note: ""
    }),
    wc_root: inspected.wcRoot,
    locks: page,
    lock_count: rows.length,
    ...(nextOffset < rows.length ? { next_cursor: String(nextOffset), truncated: true } : {})
  };
}

function lockStatusRow(row: LockInspection): Record<string, unknown> {
  const repositoryLock = row.repository_lock;
  const localToken = row.local_lock?.token;
  const repositoryToken = repositoryLock?.token;
  const stale = repositoryLock?.created ? isStaleLockDate(repositoryLock.created) : false;
  let state: "unlocked" | "held-local" | "held-elsewhere" | "orphaned-token" | "stale-candidate";
  if (!repositoryLock) {
    state = localToken ? "orphaned-token" : "unlocked";
  } else if (stale) {
    state = "stale-candidate";
  } else if (localToken && repositoryToken && localToken === repositoryToken) {
    state = "held-local";
  } else {
    state = "held-elsewhere";
  }

  const comment = boundedLockComment(repositoryLock?.comment);
  const workstationLabel = workstationLabelFromComment(comment);
  return {
    path: row.path,
    repository_path: row.repository_path.slice(0, 4096),
    repository_locked: Boolean(repositoryLock),
    owner: boundedLockText(repositoryLock?.owner, 256),
    created: boundedLockText(repositoryLock?.created, 64),
    expires: boundedLockText(repositoryLock?.expires, 64),
    comment,
    ...(workstationLabel ? { workstation_label: workstationLabel } : {}),
    local_token_possession: Boolean(localToken),
    state
  };
}

function isStaleLockDate(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && Date.now() - timestamp >= STALE_LOCK_CANDIDATE_AGE_MS;
}

function boundedLockComment(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(0, LOCK_COMMENT_OUTPUT_LIMIT);
}

function boundedLockText(value: string | null | undefined, limit: number): string | null {
  return value ? value.slice(0, limit) : null;
}

export function workstationLabelFromComment(comment: string | null | undefined): string | null {
  if (!comment) return null;
  const match = comment.match(/^\[svn-agent-mcp workstation=([A-Za-z0-9._-]{1,64})\]\s*/);
  return match?.[1] ?? null;
}

function repositoryRelativePathFromUrl(url: string | null, repositoryRoot: string | null, fallback: string): string {
  if (!url) return fallback;
  if (repositoryRoot && (url === repositoryRoot || url.startsWith(`${repositoryRoot}/`))) {
    return url === repositoryRoot ? "." : url.slice(repositoryRoot.length + 1);
  }
  return fallback;
}

function lockCursorOffset(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function diffEvidencePage(input: {
  pageOffset: number;
  pageLineCount: number;
  storedLineCount: number;
  sourceTruncated: boolean;
}): {
  sourceTruncated: boolean;
  terminalTruncation: boolean;
  nextCursor?: string;
} {
  const nextOffset = input.pageOffset + input.pageLineCount;
  const hasMore = input.pageLineCount > 0 && nextOffset < input.storedLineCount;
  return {
    sourceTruncated: input.sourceTruncated,
    terminalTruncation: input.sourceTruncated && !hasMore,
    ...(hasMore ? { nextCursor: String(nextOffset) } : {})
  };
}

function emptyDiffEnvelope(cwd: string, note: string): ToolEnvelope & DiffSummary {
  return {
    ...failEnvelope("svn diff", cwd, note),
    per_file: [],
    per_file_truncated: false,
    diff_excerpt: "",
    truncated: false,
    total_files: 0,
    total_lines: 0,
    total_chars: 0,
    total_hunks: 0,
    total_added: 0,
    total_removed: 0,
    binary_files: 0,
    property_files: 0
  };
}

function diffEvidenceScope(wcRoot: string, paths: string[], revision: string | undefined, ignoreEol: boolean): string {
  const value = JSON.stringify({
    wcRoot: pathIdentityKey(wcRoot),
    paths: paths.map((item) => pathIdentityKey(item)).sort(),
    revision: revision ?? null,
    ignoreEol
  });
  return createHash("sha256").update(value).digest("base64url");
}

export async function svnLog(input: {
  cwd?: string;
  paths?: string[];
  limit?: number;
  verbose?: boolean;
  changedPaths?: boolean;
  changedPathsSummary?: boolean;
  messageContains?: string;
  messageCaseSensitive?: boolean;
  scanLimit?: number;
  cursor?: string;
  revision?: string;
}): Promise<ToolEnvelope> {
  const cwd = resolveCwd(input.cwd);
  const revisionError = revisionSelectorError(input.revision);
  if (revisionError) {
    return failEnvelope("svn log", cwd, revisionError);
  }
  if (input.revision && input.cursor) {
    return failEnvelope("svn log", cwd, "revision and cursor cannot be combined");
  }
  if (input.cursor && (!/^\d+(?::\d+)?$/.test(input.cursor) || !input.cursor.split(":").every(isSafeDecimal))) {
    return failEnvelope("svn log", cwd, "invalid cursor");
  }
  if (input.messageContains !== undefined && (!input.messageContains.trim() || input.messageContains.length > 256)) {
    return failEnvelope("svn log", cwd, "messageContains must contain 1 to 256 characters");
  }

  const context = await getWcContext(input.cwd, input.paths ?? []);
  if (!context.ok) {
    return context.envelope;
  }

  const targets = input.paths && input.paths.length > 0 ? input.paths : [context.cwd];
  const resolved = resolveTargetsInsideWc(context.cwd, context.wcRoot, targets);
  if (!resolved.ok) {
    return failEnvelope("svn log", context.cwd, resolved.note);
  }

  const logTargets = await repositoryLogTargets(context.cwd, resolved.paths);
  const limit = input.limit ?? 10;
  const scanLimit = input.messageContains ? input.scanLimit ?? Math.max(limit, 100) : limit;
  const args = ["log", "--xml", "-l", String(scanLimit + 1)];
  if (input.changedPathsSummary || input.changedPaths || input.verbose) {
    args.push("-v");
  }
  if (input.cursor) {
    // A range-aware cursor ("next:floor") keeps the lower bound of the
    // originally requested revision range across pages.
    args.push("-r", input.cursor.includes(":") ? input.cursor : `${input.cursor}:0`);
  } else if (input.revision) {
    args.push("-r", input.revision);
  }
  args.push("--", ...logTargets.targets.map(escapeSvnTarget));

  const run = await runSvn(args, context.cwd);
  const parsedEntries = run.exitCode === 0 ? parseLogXml(run.stdout) : [];
  const scannedEntries = parsedEntries.slice(0, scanLimit);
  const needle = input.messageContains ?? "";
  const comparableNeedle = input.messageCaseSensitive ? needle : needle.toLocaleLowerCase();
  const matchingEntries = needle
    ? scannedEntries.filter((entry) => {
        const message = input.messageCaseSensitive ? entry.msg : entry.msg.toLocaleLowerCase();
        return message.includes(comparableNeedle);
      })
    : scannedEntries;
  const entries = matchingEntries.slice(0, limit);
  const scanTruncated = parsedEntries.length > scannedEntries.length;
  const matchesTruncated = matchingEntries.length > entries.length;
  const continuationRevision = matchesTruncated
    ? (entries.at(-1)?.rev ?? 0) - 1
    : scanTruncated
      ? (scannedEntries.at(-1)?.rev ?? 0) - 1
      : null;
  const nextCursor = continuationRevision !== null
    ? boundedLogCursor(continuationRevision, input.cursor, input.revision)
    : null;
  const revisions = entries.map((entry) => entry.rev);
  const revisionRange = revisions.length > 1
    ? { min: Math.min(...revisions), max: Math.max(...revisions) }
    : null;
  return {
    ...envelopeFromRun({
      run,
      ok: run.exitCode === 0,
      revision: entries.length === 1 ? entries[0]?.rev ?? null : null,
      note: run.exitCode === 0 ? logTargets.note : noteFromRun(run)
    }),
    entries,
    entry_count: entries.length,
    revision_range: revisionRange,
    has_more: matchesTruncated || scanTruncated,
    scanned_count: scannedEntries.length,
    matched_count: matchingEntries.length,
    scan_truncated: scanTruncated,
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
    target_mode: logTargets.mode
  };
}

function boundedLogCursor(nextRevision: number, cursor?: string, revision?: string): string | null {
  const cursorFloor = cursor?.match(/^\d+:(\d+)$/)?.[1];
  const range = revision?.match(/^(\d+):(\d+)$/);
  const floor = cursorFloor !== undefined
    ? cursorValue(cursorFloor)
    : cursor && /^\d+$/.test(cursor)
      ? 0
      : !revision
        ? 0
        : range && Number.parseInt(range[1] ?? "0", 10) >= Number.parseInt(range[2] ?? "0", 10)
          ? Number.parseInt(range[2] ?? "0", 10)
          : null;
  if (floor === null || nextRevision < floor) {
    return null;
  }
  return floor > 0 ? `${nextRevision}:${floor}` : String(Math.max(0, nextRevision));
}

export async function svnCat(input: {
  cwd?: string;
  path: string;
  revision?: string;
  maxChars?: number;
  cursor?: string;
}): Promise<ToolEnvelope> {
  const cwd = resolveCwd(input.cwd);
  if (!input.path.trim()) {
    return failEnvelope("svn cat", cwd, "explicit path required");
  }
  const revisionError = revisionSelectorError(input.revision, false);
  if (revisionError) {
    return failEnvelope("svn cat", cwd, revisionError);
  }

  const context = await getWcContext(input.cwd, [input.path]);
  if (!context.ok) {
    return context.envelope;
  }
  const resolved = resolveTargetsInsideWc(context.cwd, context.wcRoot, [input.path]);
  if (!resolved.ok) {
    return failEnvelope("svn cat", context.cwd, resolved.note);
  }
  const target = resolved.paths[0];
  if (!target) {
    return failEnvelope("svn cat", context.cwd, "explicit path required");
  }

  const run = await runSvn([
    "cat",
    ...(input.revision ? ["-r", input.revision] : []),
    "--",
    escapeSvnTarget(target)
  ], context.cwd);
  if (run.exitCode !== 0) {
    return envelopeFromRun({ run, ok: false, note: noteFromRun(run) });
  }

  const binary = run.stdout.includes("\0");
  const offset = cursorValue(input.cursor);
  const maxChars = boundedInteger(input.maxChars, 16000, 256, 64000);
  const content = binary ? "" : run.stdout.slice(offset, offset + maxChars);
  const hasMore = !binary && offset + content.length < run.stdout.length;
  return {
    ...createEnvelope({
      ok: true,
      command: run.command,
      cwd: context.cwd,
      note: binary ? "binary content omitted" : "",
      truncated: hasMore
    }),
    path: repoRelativePath(target, context.wcRoot),
    content,
    binary,
    page_offset: offset,
    has_more: hasMore,
    ...(hasMore ? { next_cursor: String(offset + content.length) } : {})
  };
}

export async function svnBlame(input: {
  cwd?: string;
  path: string;
  revision?: string;
  maxLines?: number;
  cursor?: string;
  showEolChanges?: boolean;
}): Promise<ToolEnvelope> {
  const cwd = resolveCwd(input.cwd);
  if (!input.path.trim()) {
    return failEnvelope("svn blame", cwd, "explicit path required");
  }
  const revisionError = revisionSelectorError(input.revision, false);
  if (revisionError) {
    return failEnvelope("svn blame", cwd, revisionError);
  }

  const context = await getWcContext(input.cwd, [input.path]);
  if (!context.ok) {
    return context.envelope;
  }
  const resolved = resolveTargetsInsideWc(context.cwd, context.wcRoot, [input.path]);
  if (!resolved.ok) {
    return failEnvelope("svn blame", context.cwd, resolved.note);
  }
  const target = resolved.paths[0];
  if (!target) {
    return failEnvelope("svn blame", context.cwd, "explicit path required");
  }

  const run = await runSvn([
    "blame",
    "--xml",
    ...(input.revision ? ["-r", input.revision] : []),
    ...(!input.showEolChanges ? ["-x", "--ignore-eol-style"] : []),
    "--",
    escapeSvnTarget(target)
  ], context.cwd);
  if (run.exitCode !== 0) {
    return envelopeFromRun({ run, ok: false, note: noteFromRun(run) });
  }

  let allLines;
  try {
    allLines = parseBlameXml(run.stdout);
  } catch {
    return failEnvelope("svn blame --xml", context.cwd, "invalid SVN blame XML");
  }
  const offset = cursorValue(input.cursor);
  const maxLines = boundedInteger(input.maxLines, 100, 1, 500);
  const lines = allLines.slice(offset, offset + maxLines);
  const hasMore = offset + lines.length < allLines.length;
  return {
    ...createEnvelope({ ok: true, command: run.command, cwd: context.cwd, truncated: hasMore }),
    path: repoRelativePath(target, context.wcRoot),
    ignore_eol: !input.showEolChanges,
    ...(input.showEolChanges ? { eol_changes_included: true } : {}),
    lines,
    page_offset: offset,
    has_more: hasMore,
    ...(hasMore ? { next_cursor: String(offset + lines.length) } : {})
  };
}

export async function eolCheck(input: { cwd?: string; paths: string[] }): Promise<ToolEnvelope> {
  const explicitError = requireExplicitPaths(input.paths);
  const cwd = resolveCwd(input.cwd);
  if (explicitError) {
    return {
      ...failEnvelope("eol_check", cwd, explicitError),
      files: []
    };
  }

  const context = await getWcContext(input.cwd, input.paths);
  if (!context.ok) {
    return {
      ...context.envelope,
      files: []
    };
  }

  const resolved = resolveTargetsInsideWc(context.cwd, context.wcRoot, input.paths);
  if (!resolved.ok) {
    return {
      ...failEnvelope("eol_check", context.cwd, resolved.note),
      files: []
    };
  }

  const existsError = assertExistingTargets(resolved.paths);
  if (existsError) {
    return {
      ...failEnvelope("eol_check", context.cwd, existsError),
      files: []
    };
  }

  const files: EolCheckResult[] = [];
  const eolProperties = await runSvn(
    ["propget", "--xml", "--", "svn:eol-style", ...resolved.paths.map(escapeSvnTarget)],
    context.cwd
  );
  if (eolProperties.exitCode !== 0 && !isMissingPropertyRun(eolProperties)) {
    return {
      ...envelopeFromRun({ run: eolProperties, ok: false, note: noteFromRun(eolProperties) }),
      files: []
    };
  }

  let eolStyles: Map<string, string>;
  try {
    eolStyles = parsePropgetEolStyles(eolProperties.stdout, context.cwd);
  } catch {
    return {
      ...failEnvelope("eol_check", context.cwd, "invalid SVN property XML"),
      files: []
    };
  }
  for (const target of resolved.paths) {
    files.push(await makeEolCheck(target, eolStyles.get(pathIdentityKey(target)) ?? null));
  }

  return {
    ...createEnvelope({
      ok: true,
      command: "eol_check",
      cwd: context.cwd,
      note: files.some((file) => file.mismatch) ? "EOL mismatch detected" : ""
    }),
    wc_root: context.wcRoot,
    files
  };
}

export async function svnPropget(input: { cwd?: string; paths: string[]; name: string }): Promise<ToolEnvelope> {
  const explicitError = requireExplicitPaths(input.paths);
  const cwd = resolveCwd(input.cwd);
  if (explicitError) {
    return {
      ...failEnvelope("svn propget", cwd, explicitError),
      properties: [],
      missing_paths: []
    };
  }

  const propertyError = validatePropertyName(input.name);
  if (propertyError) {
    return {
      ...failEnvelope("svn propget", cwd, propertyError),
      properties: [],
      missing_paths: []
    };
  }

  const context = await getWcContext(input.cwd, input.paths);
  if (!context.ok) {
    return {
      ...context.envelope,
      properties: [],
      missing_paths: []
    };
  }

  const resolved = resolveTargetsInsideWc(context.cwd, context.wcRoot, input.paths);
  if (!resolved.ok) {
    return {
      ...failEnvelope("svn propget", context.cwd, resolved.note),
      properties: [],
      missing_paths: []
    };
  }

  const existsError = assertExistingTargets(resolved.paths);
  if (existsError) {
    return {
      ...failEnvelope("svn propget", context.cwd, existsError),
      properties: [],
      missing_paths: []
    };
  }

  const run = await runSvn(["propget", "--xml", "--", input.name, ...resolved.paths.map(escapeSvnTarget)], context.cwd);
  const properties = parsePropgetProperties(run.stdout, context.cwd, context.wcRoot);
  const missingPaths = propertyMissingPaths(properties, resolved.paths, context.wcRoot);
  if (run.exitCode !== 0 && isMissingPropertyRun(run)) {
    return {
      ...createEnvelope({
        ok: true,
        command: run.command,
        cwd: context.cwd,
        stdout: run.stdout,
        stderr: run.stderr,
        note: properties.length > 0 ? "property not set on some paths" : "property not set"
      }),
      properties,
      missing_paths: missingPaths
    };
  }

  return {
    ...envelopeFromRun({
      run,
      ok: run.exitCode === 0,
      note: run.exitCode === 0 ? "" : noteFromRun(run)
    }),
    properties,
    missing_paths: missingPaths
  };
}

export async function scopedStatusMap(cwd: string, wcRoot: string, paths: string[]): Promise<{
  envelope: ToolEnvelope;
  map: Map<string, string>;
}> {
  const status = await svnStatus({ cwd, paths });
  return {
    envelope: status,
    map: statusMap(status.changed_paths, cwd)
  };
}

export function dryRiskSignals(absPaths: string[], wcRoot: string, statusByPath?: Map<string, string>): string[] {
  return riskySignals(absPaths, wcRoot, statusByPath);
}

export function defaultDiffLineLimit(): number {
  const parsed = Number.parseInt(process.env.SVN_AGENT_MAX_DIFF_LINES ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 2000) : 200;
}

export function revisionSelectorError(value: string | undefined, allowRange = true): string | null {
  if (value === undefined) {
    return null;
  }
  const revision = "(?:\\d+|HEAD|BASE|COMMITTED|PREV|\\{[^}\\r\\n\\x00]+\\})";
  const selector = new RegExp(allowRange ? `^${revision}(?::${revision})?$` : `^${revision}$`, "i");
  return selector.test(value) ? null : "invalid revision selector";
}

export function isRevisionRange(value: string): boolean {
  // A ':' inside a {date} selector is not a range separator.
  return value.replace(/\{[^}]*\}/g, "").includes(":");
}

function excerptLineCount(excerpt: string): number {
  return excerpt ? excerpt.split("\n").length : 0;
}

function cursorValue(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "0", 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function isSafeDecimal(value: string): boolean {
  try {
    return /^\d+$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
  } catch {
    return false;
  }
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value ?? fallback));
}

export function normalizeStatusLookup(statuses: Map<string, string>, target: string): string | undefined {
  return statuses.get(pathIdentityKey(target));
}

function filterNoisePaths(changedPaths: ChangedPath[], cwd: string, wcRoot: string): {
  changed_paths: ChangedPath[];
  filtered_paths: string[];
} {
  const kept = [];
  const filtered = [];

  for (const entry of changedPaths) {
    const absPath = path.resolve(cwd, entry.path);
    const relative = repoRelativePath(absPath, wcRoot);
    if ((entry.status === "?" || entry.status === "I") && isNoisePath(relative)) {
      filtered.push(relative);
      continue;
    }
    kept.push(entry);
  }

  return { changed_paths: kept, filtered_paths: filtered };
}

function isNoisePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
  return [
    "node_modules",
    "dist",
    "current",
    ".cache",
    "coverage"
  ].some((value) => normalized === value || normalized.startsWith(`${value}/`));
}

export function parseSvnVersion(value: string): {
  range: { min: number; max: number } | null;
  mixed: boolean;
  modified: boolean;
  switched: boolean;
  partial: boolean;
} {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+)(?::(\d+))?/);
  const min = match?.[1] ? Number.parseInt(match[1], 10) : null;
  const max = match?.[2] ? Number.parseInt(match[2], 10) : min;
  const flagString = trimmed.replace(/^\d+(?::\d+)?/, "");
  return {
    range: min !== null && max !== null ? { min, max } : null,
    mixed: trimmed.includes(":"),
    modified: flagString.includes("M"),
    switched: flagString.includes("S"),
    partial: flagString.includes("P")
  };
}

function mergeRevisionRange(
  left: { min: number; max: number } | null,
  right: { min: number; max: number } | null
): { min: number; max: number } | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return {
    min: Math.min(left.min, right.min),
    max: Math.max(left.max, right.max)
  };
}

export async function remoteHeadForTargets(cwd: string, targets: string[]): Promise<number | null> {
  let head: number | null = null;
  const run = await runSvn(["info", "--xml", "-r", "HEAD", "--", ...targets.map(escapeSvnTarget)], cwd);
  if (run.exitCode !== 0) {
    return null;
  }
  for (const entry of parseInfoXml(run.stdout)) {
    if (entry.revision === null) {
      continue;
    }
    head = head === null ? entry.revision : Math.max(head, entry.revision);
  }
  return head;
}

async function findIgnoredAncestor(cwd: string, wcRoot: string, target: string): Promise<string | null> {
  let candidate: string;
  try {
    candidate = fs.statSync(target).isDirectory() ? target : path.dirname(target);
  } catch {
    return null;
  }

  while (isInsideOrEqual(candidate, wcRoot) && pathIdentityKey(candidate) !== pathIdentityKey(wcRoot)) {
    const run = await runSvn(["status", "--xml", "--no-ignore", "--", escapeSvnTarget(candidate)], cwd);
    if (run.exitCode === 0) {
      const ignored = parseStatusXml(run.stdout).changed_paths.some((entry) =>
        entry.status === "I" && pathIdentityKey(path.resolve(cwd, entry.path)) === pathIdentityKey(candidate)
      );
      if (ignored) {
        return candidate;
      }
    }
    candidate = path.dirname(candidate);
  }
  return null;
}

function successfulRunWarning(stderr: string): string {
  return redactText(stderr).replace(/\r\n?/g, "\n").trim().slice(0, 2000);
}

function parsePropgetEolStyles(xml: string, cwd: string): Map<string, string> {
  const styles = new Map<string, string>();
  if (!xml.trim()) {
    return styles;
  }

  const parsed = propgetParser.parse(xml) as {
    properties?: {
      target?: unknown;
    };
  };

  for (const target of asArray(parsed.properties?.target)) {
    const targetObj = target as { path?: string; property?: unknown };
    const targetPath = targetObj.path ? pathIdentityKey(path.resolve(cwd, targetObj.path)) : null;
    if (!targetPath) {
      continue;
    }
    for (const property of asArray(targetObj.property)) {
      const propertyObj = property as { name?: string; text?: string };
      if (propertyObj.name === "svn:eol-style" && propertyObj.text) {
        styles.set(targetPath, propertyObj.text.trim());
      }
    }
  }

  return styles;
}

function parsePropgetProperties(xml: string, cwd: string, wcRoot: string): Array<{ path: string; name: string; value: string }> {
  const properties: Array<{ path: string; name: string; value: string }> = [];
  if (!xml.trim()) {
    return properties;
  }

  const parsed = propgetParser.parse(xml) as {
    properties?: {
      target?: unknown;
    };
  };

  for (const target of asArray(parsed.properties?.target)) {
    const targetObj = target as { path?: string; property?: unknown };
    if (!targetObj.path) {
      continue;
    }
    const targetPath = displayPropertyPath(targetObj.path, cwd, wcRoot);
    for (const property of asArray(targetObj.property)) {
      const propertyObj = property as { name?: string; text?: unknown };
      if (propertyObj.name) {
        properties.push({
          path: targetPath,
          name: propertyObj.name,
          value: propertyObj.text === undefined ? "" : String(propertyObj.text)
        });
      }
    }
  }

  return properties;
}

function displayPropertyPath(value: string, cwd: string, wcRoot: string): string {
  const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
  return isInsideOrEqual(absolute, wcRoot)
    ? repoRelativePath(absolute, wcRoot)
    : value;
}

function isMissingPropertyRun(run: Awaited<ReturnType<typeof runSvn>>): boolean {
  return /W200017|Property '.+' not found/i.test(`${run.stderr}\n${run.stdout}`);
}

function propertyMissingPaths(
  properties: Array<{ path: string; name: string; value: string }>,
  resolvedPaths: string[],
  wcRoot: string
): string[] {
  const pathsWithProperty = new Set(properties.map((property) => pathIdentityKey(path.resolve(wcRoot, property.path))));
  return resolvedPaths
    .map((target) => repoRelativePath(target, wcRoot))
    .filter((target) => !pathsWithProperty.has(pathIdentityKey(path.resolve(wcRoot, target))));
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function isInconsistentEolRun(run: Awaited<ReturnType<typeof runSvn>>): boolean {
  return /E135000|inconsistent newlines|inconsistent line ending style/i.test(`${run.stderr}\n${run.stdout}`);
}

async function repositoryLogTargets(cwd: string, paths: string[]): Promise<{
  targets: string[];
  mode: "repository-url" | "working-copy-path";
  note: string;
}> {
  const info = await runSvn(["info", "--xml", "--", ...paths.map(escapeSvnTarget)], cwd);
  if (info.exitCode !== 0) {
    return { targets: paths, mode: "working-copy-path", note: "" };
  }

  const entries = parseInfoXml(info.stdout);
  const urls = entries.map((entry) => entry.url).filter((url): url is string => Boolean(url));
  if (urls.length !== paths.length) {
    return { targets: paths, mode: "working-copy-path", note: "" };
  }

  if (urls.length > 1) {
    const roots = entries.map((entry) => entry.repo_root).filter((root): root is string => Boolean(root));
    const repositoryRoot = roots.length === urls.length && roots.every((root) => root === roots[0]) ? roots[0] : null;
    if (!repositoryRoot || !urls.every((url) => url === repositoryRoot || url.startsWith(`${repositoryRoot}/`))) {
      return { targets: paths, mode: "working-copy-path", note: "" };
    }
    return {
      targets: [repositoryRoot, ...urls.map((url) => url === repositoryRoot ? "." : url.slice(repositoryRoot.length + 1))],
      mode: "repository-url",
      note: "queried one repository root URL with relative targets at HEAD"
    };
  }

  return {
    targets: urls,
    mode: "repository-url",
    note: "queried repository URL at HEAD to avoid working-copy peg revision log gaps"
  };
}

export function boundedEvidenceDiffSummary(diff: DiffSummary): DiffSummary {
  return {
    ...diff,
    diff_excerpt: "",
    per_file: diff.per_file.slice(0, EVIDENCE_PER_FILE_LIMIT).map((file) => {
      const firstHunk = boundedEvidencePreview(file.first_hunk);
      const firstMeaningfulLine = boundedEvidencePreview(file.first_meaningful_line);
      return {
        ...file,
        ...(firstHunk === undefined ? {} : { first_hunk: firstHunk.value }),
        ...(firstMeaningfulLine === undefined ? {} : { first_meaningful_line: firstMeaningfulLine.value }),
        ...(firstHunk?.truncated === true || firstMeaningfulLine?.truncated === true
          ? { preview_truncated: true }
          : {})
      };
    }),
    per_file_truncated: diff.per_file_truncated || diff.per_file.length > EVIDENCE_PER_FILE_LIMIT
  };
}

function boundedEvidencePreview(value: string | undefined): { value: string; truncated: boolean } | undefined {
  if (value === undefined) return undefined;
  if (value.length <= EVIDENCE_PREVIEW_CHAR_LIMIT) return { value, truncated: false };
  let end = EVIDENCE_PREVIEW_CHAR_LIMIT;
  if (/[\uD800-\uDBFF]/.test(value[end - 1] ?? "")) end -= 1;
  return { value: `${value.slice(0, end)}...`, truncated: true };
}

type WcProbe = {
  target: string;
  execCwd: string;
  cwd: string | null;
};

function wcProbeCandidates(cwdInput: string | undefined, pathHints: string[]): WcProbe[] {
  if (cwdInput) {
    const cwd = resolveCwd(cwdInput);
    return [{ target: cwd, execCwd: executableCwdForTarget(cwd), cwd }];
  }

  const probes: WcProbe[] = [];
  for (const hint of pathHints) {
    if (!path.isAbsolute(hint)) {
      continue;
    }
    for (const target of probeTargetsForAbsolutePath(hint)) {
      probes.push({ target, execCwd: executableCwdForTarget(target), cwd: null });
    }
  }

  // No launch-directory fallback: in global plug-and-play registration the MCP
  // process cwd is arbitrary and must never silently become the working copy.
  return uniqueProbes(probes);
}

function probeTargetsForAbsolutePath(value: string): string[] {
  const targets: string[] = [];
  let current = path.resolve(value);
  const startDirectory = existingDirectoryForPath(current);
  const wcMarkerRoot = startDirectory ? nearestSvnMarkerAncestor(startDirectory) : null;
  if (wcMarkerRoot) {
    return [realPathOfNearestExisting(wcMarkerRoot)];
  }

  if (fs.existsSync(current)) {
    targets.push(current);
    if (!fs.statSync(current).isDirectory()) {
      current = path.dirname(current);
    }
  } else {
    current = path.dirname(current);
  }

  while (true) {
    if (fs.existsSync(current)) {
      targets.push(current);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return Array.from(new Set(targets.map((target) => realPathOfNearestExisting(target))));
}

function existingDirectoryForPath(value: string): string | null {
  let current = path.resolve(value);

  if (fs.existsSync(current) && !fs.statSync(current).isDirectory()) {
    current = path.dirname(current);
  }

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }

  return fs.statSync(current).isDirectory() ? realPathOfNearestExisting(current) : realPathOfNearestExisting(path.dirname(current));
}

function nearestSvnMarkerAncestor(startDirectory: string): string | null {
  let current = path.resolve(startDirectory);

  while (true) {
    if (fs.existsSync(path.join(current, ".svn"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function executableCwdForTarget(target: string): string {
  let current = path.resolve(target);

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return process.cwd();
    }
    current = parent;
  }

  return fs.statSync(current).isDirectory() ? current : path.dirname(current);
}

function uniqueProbes(probes: WcProbe[]): WcProbe[] {
  const seen = new Set<string>();
  const unique: WcProbe[] = [];

  for (const probe of probes) {
    const key = pathIdentityKey(probe.target);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(probe);
    }
  }

  return unique;
}
