import path from "node:path";
import { redactText } from "./envelope.js";
import type { ChangedPath, ToolEnvelope } from "./types.js";

export type ResponseMode = "compact" | "standard" | "full";

export interface ResponseOptions {
  responseMode?: ResponseMode;
  request?: Record<string, unknown>;
}

type ToolResult<T extends Record<string, unknown>> = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: T;
};

const STATUS_NAMES: Record<string, string> = {
  "!": "missing",
  "?": "unversioned",
  A: "added",
  C: "conflicted",
  D: "deleted",
  I: "ignored",
  M: "modified",
  R: "replaced",
  X: "external",
  _M: "property-modified",
  "~": "obstructed"
};

const MUTATION_STATUS: Record<string, string> = {
  eol_fix_verified: "verified",
  svn_add: "added",
  svn_cleanup: "cleaned",
  svn_commit: "committed",
  svn_copy: "copied",
  svn_export: "exported",
  svn_import: "imported",
  svn_move: "renamed",
  svn_propset: "property-set",
  svn_propset_eol_style: "property-set",
  svn_rename: "renamed",
  svn_resolved: "resolved",
  svn_revert: "reverted",
  svn_update: "updated"
};

export function defaultResponseMode(
  env: Readonly<Record<string, string | undefined>> = process.env
): ResponseMode {
  const value = env.SVN_MCP_RESPONSE_MODE?.trim().toLowerCase();
  return value === "standard" || value === "full" ? value : "compact";
}

export function toToolResult<T extends ToolEnvelope>(
  tool: string,
  payload: T,
  options: ResponseOptions = {}
): ToolResult<Record<string, unknown>> {
  const mode = options.responseMode ?? defaultResponseMode();
  const shaped = shapePayload(tool, payload, mode, options.request ?? {});
  const warning = mode === "compact" && payload.ok ? payload.stderr_summary.slice(0, 2000) : "";
  const structured = warning
    ? {
        ...shaped,
        warning,
        ...(warning.length < payload.stderr_summary.length ? { warningTruncated: true } : {})
      }
    : shaped;
  const text = mode === "full" ? JSON.stringify(payload, null, 2) : summarizeToolResult(tool, structured);

  return {
    content: [{ type: "text", text }],
    structuredContent: structured
  };
}

function shapePayload(
  tool: string,
  payload: ToolEnvelope,
  mode: ResponseMode,
  request: Record<string, unknown>
): Record<string, unknown> {
  if (mode === "full") {
    return payload;
  }

  if (mode === "compact" && tool === "svn_diagnose") {
    return compactDiagnose(payload);
  }

  if (mode === "compact" && tool === "svn_precommit") {
    return compactPrecommit(payload, request);
  }

  if (mode === "compact" && tool === "svn_self_check") {
    return compactSelfCheck(payload, request);
  }

  if (mode === "compact" && tool === "eol_fix_verified") {
    return compactEolFix(payload, request);
  }

  if (!payload.ok) {
    return mode === "compact" ? compactError(payload) : payload;
  }

  if (mode === "compact" && tool === "svn_status") {
    return compactStatus(payload, request);
  }

  if (mode === "compact" && tool === "svn_info") {
    return compactInfo(payload, request);
  }

  if (mode === "compact" && tool === "svn_log") {
    return compactLog(payload, request);
  }

  if (mode === "compact" && tool === "svn_diff") {
    return compactDiff(payload, request);
  }

  if (mode === "compact" && tool === "eol_check") {
    return compactEolCheck(payload, request);
  }

  if (mode === "compact" && tool === "svn_propget") {
    return compactPropget(payload, request);
  }

  if (mode === "compact" && MUTATION_STATUS[tool]) {
    return compactMutation(tool, payload, request);
  }

  return {
    ...payload,
    stdout_summary: ""
  };
}

function compactError(payload: ToolEnvelope): Record<string, unknown> {
  const conflicts = payload.conflicts.slice(0, 100);
  const riskSignals = stringArray(payload.risk_signals);
  return {
    ok: false,
    note: payload.note || "svn command failed",
    ...(payload.stdout_summary ? { stdout: payload.stdout_summary } : {}),
    ...(payload.stderr_summary ? { stderr: payload.stderr_summary } : {}),
    ...(conflicts.length > 0 ? { conflicts } : {}),
    ...(payload.conflicts.length > conflicts.length
      ? { conflictCount: payload.conflicts.length, conflictsTruncated: true }
      : {}),
    ...(payload.truncated ? { truncated: true } : {}),
    ...(payload.recovery_tool ? { recoveryTool: payload.recovery_tool } : {}),
    ...(riskSignals.length > 0 ? { riskSignals } : {})
  };
}

function compactDiagnose(payload: ToolEnvelope): Record<string, unknown> {
  const checks = recordArray(payload.checks);
  const failed = checks
    .filter((check) => check.ok !== true)
    .map((check) => ({ name: check.name, ...(check.note ? { note: check.note } : {}) }));
  const suggestions = stringArray(payload.suggestions);
  return {
    ok: payload.ok,
    health: payload.health,
    svnAvailable: payload.svn_available,
    workingCopyValid: payload.working_copy_valid,
    remoteAccessible: payload.remote_accessible,
    checks: { passed: checks.length - failed.length, failed },
    ...(payload.note ? { note: payload.note } : {}),
    ...(suggestions.length > 0 ? { suggestions } : {})
  };
}

function compactInfo(payload: ToolEnvelope, request: Record<string, unknown>): Record<string, unknown> {
  const available: Record<string, unknown> = {
    root: payload.wc_root ?? payload.cwd,
    revision: payload.revision,
    url: redactText(stringValue(payload.url)),
    repositoryRoot: redactText(stringValue(payload.repo_root)),
    mixedRevision: payload.mixed_revision,
    revisionRange: payload.revision_range,
    localModifications: payload.local_modifications,
    switched: payload.switched,
    partial: payload.partial,
    remoteHeadRevision: payload.remote_head_revision,
    staleBase: payload.stale_base
  };
  const fields = stringArray(request.fields);
  const selected = fields.length > 0
    ? projectFields(available, fields)
    : {
        revision: payload.revision,
        mixedRevision: payload.mixed_revision,
        ...(payload.mixed_revision === true ? { revisionRange: payload.revision_range } : {}),
        localModifications: payload.local_modifications,
        ...(payload.switched === true ? { switched: true } : {}),
        ...(payload.partial === true ? { partial: true } : {}),
        remoteHeadRevision: payload.remote_head_revision,
        staleBase: payload.stale_base
      };
  return { ok: true, ...selected };
}

function compactPropget(payload: ToolEnvelope, request: Record<string, unknown>): Record<string, unknown> {
  const fields = stringArray(request.fields);
  const maxValueChars = boundedInteger(request.maxValueChars, 4096, 256, 64000);
  const sourceProperties = recordArray(payload.properties).map((property) => {
    const selected = projectFields(property, fields.length > 0 ? fields : ["path", "value"]);
    const value = selected.value;
    if (typeof selected.path === "string") {
      selected.path = redactText(selected.path).slice(0, 4096);
    }
    if (typeof selected.name === "string") {
      selected.name = redactText(selected.name).slice(0, 256);
    }
    if (typeof value === "string") {
      const redacted = redactText(value);
      const boundedValue = redacted.slice(0, maxValueChars);
      selected.value = boundedValue;
      if (boundedValue.length < redacted.length) {
        selected.valueTruncated = true;
      }
    }
    return selected;
  });
  const sourceMissingPaths = stringArray(payload.missing_paths).map((item) => redactText(item).slice(0, 4096));
  const combined = [
    ...sourceProperties.map((value) => ({ kind: "property" as const, value })),
    ...sourceMissingPaths.map((value) => ({ kind: "missing" as const, value }))
  ];
  const offset = cursorOffset(request.cursor);
  const countOnly = request.countOnly === true;
  const maxItems = countOnly ? 0 : boundedInteger(request.maxItems, 100, 1, 500);
  const page = maxItems === 0 ? [] : combined.slice(offset, offset + maxItems);
  const properties = page.filter((item) => item.kind === "property").map((item) => item.value);
  const missingPaths = page.filter((item) => item.kind === "missing").map((item) => item.value as string);
  const nextOffset = offset + page.length;
  const truncated = !countOnly && nextOffset < combined.length;
  const paged = countOnly || offset > 0 || truncated;
  return {
    ok: true,
    name: request.name,
    properties,
    missingPaths,
    ...(paged
      ? {
          counts: { found: sourceProperties.length, missing: sourceMissingPaths.length },
          truncated,
          ...(truncated ? { nextCursor: String(nextOffset) } : {})
        }
      : {})
  };
}

function compactSelfCheck(payload: ToolEnvelope, request: Record<string, unknown>): Record<string, unknown> {
  if (request.detailed === true) {
    return { ...payload, stdout_summary: "" };
  }
  return {
    ok: payload.ok,
    version: payload.server_version,
    available: payload.toolchain_ok === true && payload.current_matches_package === true,
    ...(payload.note ? { diagnostics: payload.note } : {})
  };
}

function compactLog(payload: ToolEnvelope, request: Record<string, unknown>): Record<string, unknown> {
  const sourceEntries = recordArray(payload.entries);
  const limit = boundedInteger(request.limit, 10, 1, 100);
  const includeFullMessage = request.fullMessage === true;
  const includeChangedPaths = request.changedPaths === true || request.verbose === true;
  const maxMessageChars = boundedInteger(request.maxMessageChars, includeFullMessage ? 2000 : 240, 32, 8000);
  const maxChangedPaths = boundedInteger(request.maxChangedPaths, 100, 1, 500);
  const entries = sourceEntries.slice(0, limit).map((entry) => {
    const rawMessage = redactText(includeFullMessage ? stringValue(entry.msg) : firstLine(stringValue(entry.msg)));
    const message = rawMessage.slice(0, maxMessageChars);
    const allChangedPaths = recordArray(entry.changed_paths);
    const changedPaths = allChangedPaths.slice(0, maxChangedPaths).map((item) => ({
      status: redactText(stringValue(item.status)).slice(0, 16),
      path: redactText(stringValue(item.path)).slice(0, 4096)
    }));
    return {
      revision: numberValue(entry.rev),
      author: redactText(stringValue(entry.author)).slice(0, 256),
      date: redactText(stringValue(entry.date)).slice(0, 64),
      message,
      ...(message.length < rawMessage.length ? { messageTruncated: true } : {}),
      ...(includeChangedPaths
        ? {
            changedPaths,
            ...(changedPaths.length < allChangedPaths.length ? { changedPathsTruncated: true } : {})
          }
        : {})
    };
  });
  const lastRevision = entries.at(-1)?.revision;
  const truncated = payload.has_more === true || sourceEntries.length > entries.length;

  return {
    ok: true,
    entries,
    ...(payload.target_mode === "working-copy-path" ? { targetMode: payload.target_mode } : {}),
    truncated,
    ...(truncated && typeof lastRevision === "number" ? { nextCursor: String(Math.max(0, lastRevision - 1)) } : {})
  };
}

function compactDiff(payload: ToolEnvelope, request: Record<string, unknown>): Record<string, unknown> {
  const mode = request.diffMode === "summary" || request.diffMode === "full" ? request.diffMode : "compact";
  const sourceFiles = recordArray(payload.per_file);
  const fileOffset = cursorOffset(request.fileCursor);
  const maxFiles = boundedInteger(request.maxFiles, 100, 1, 500);
  const files = sourceFiles.slice(fileOffset, fileOffset + maxFiles).map((file) => ({
    path: redactText(stringValue(file.path)).slice(0, 4096),
    added: file.added,
    removed: file.removed,
    binary: file.binary,
    ...(file.property_changed === true ? { propertyChanged: true } : {})
  }));
  const nextFileOffset = fileOffset + files.length;
  const filesTruncated = nextFileOffset < sourceFiles.length;
  const pagedFiles = fileOffset > 0 || filesTruncated;
  const excerpt = stringValue(payload.diff_excerpt);
  const offset = numberValue(payload.page_offset);
  const base = {
    ok: true,
    files,
    ...(pagedFiles
      ? {
          totalFiles: sourceFiles.length,
          filesTruncated,
          ...(filesTruncated ? { nextFileCursor: String(nextFileOffset) } : {})
        }
      : {}),
    ...(payload.ignore_eol === false ? { ignoreEol: false } : {})
  };

  if (mode === "summary") {
    return {
      ...base,
      truncated: false
    };
  }

  if (mode === "full") {
    return {
      ...base,
      excerpt,
      truncated: Boolean(payload.truncated),
      ...(payload.truncated ? { nextCursor: String(offset + lineCount(excerpt)) } : {})
    };
  }

  const page = boundedDiffExcerpt(
    excerpt,
    0,
    boundedInteger(request.maxChars, 3000, 256, 64000),
    boundedInteger(request.maxHunksPerFile, 3, 1, 20)
  );
  const hasContinuation = page.nextOffset < lineCount(excerpt) || Boolean(payload.truncated);
  const truncated = hasContinuation || page.lineTruncated;

  return {
    ...base,
    excerpt: page.text,
    truncated,
    ...(page.lineTruncated ? { lineTruncated: true } : {}),
    ...(hasContinuation ? { nextCursor: String(offset + page.nextOffset) } : {})
  };
}

function compactEolCheck(payload: ToolEnvelope, request: Record<string, unknown>): Record<string, unknown> {
  const sourceFiles = recordArray(payload.files);
  const failed = sourceFiles.filter((file) => file.mismatch === true);
  const skipped = sourceFiles.filter((file) => file.sniff !== "ok");
  const problems = sourceFiles.filter((file) => file.mismatch === true || file.sniff !== "ok");
  const counts = {
    passed: sourceFiles.filter((file) => file.mismatch !== true && file.sniff === "ok").length,
    failed: failed.length,
    ...(skipped.length > 0 ? { skipped: skipped.length } : {})
  };
  const selected = request.includePassing === true ? sourceFiles : problems;
  const offset = cursorOffset(request.cursor);
  const countOnly = request.countOnly === true;
  const maxItems = countOnly ? 0 : boundedInteger(request.maxItems, 100, 1, 500);
  const page = maxItems === 0 ? [] : selected.slice(offset, offset + maxItems);
  const files = page.map((file) => ({
    path: relativePath(payload.cwd, stringValue(file.path)),
    expected: file.eol_style ?? null,
    detected: file.kind ?? null,
    ...(request.includePassing === true ? { ok: file.mismatch !== true && file.sniff === "ok" } : {}),
    ...(file.mismatch === true
      ? { remediation: "run eol_fix_verified" }
      : file.sniff !== "ok"
        ? { remediation: "inspect file manually" }
        : {})
  }));
  const nextOffset = offset + files.length;
  const truncated = !countOnly && nextOffset < selected.length;

  return {
    ok: true,
    counts,
    files,
    truncated,
    ...(truncated ? { nextCursor: String(nextOffset) } : {})
  };
}

function compactPrecommit(payload: ToolEnvelope, request: Record<string, unknown>): Record<string, unknown> {
  const files = recordArray(payload.per_file);
  const verdict = stringValue(payload.verdict);
  if (!payload.ok && files.length === 0) {
    return {
      ...compactError(payload),
      ready: false,
      verdict,
      pathCount: stringArray(request.paths).length
    };
  }
  const allGuardFailures = uniqueStrings([
    ...stringArray(payload.guard_failures),
    ...files
      .map((file) => file.guard)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
  ]);
  const guardFailures = allGuardFailures.slice(0, 100);
  const riskSignals = uniqueStrings(stringArray(payload.risk_signals)).slice(0, 100);
  const allEolFailures = uniqueStrings(files
    .filter((file) => file.pure_eol_churn === true || file.eol_mismatch === true)
    .map((file) => stringValue(file.path)));
  const eolFailures = allEolFailures.slice(0, 100);
  const filesWithDiff = files.filter((file) =>
    numberValue(file.added) > 0 ||
    numberValue(file.removed) > 0 ||
    file.binary === true ||
    file.property_changed === true
  );
  const diff = {
    files: filesWithDiff.length,
    added: files.reduce((sum, file) => sum + numberValue(file.added), 0),
    removed: files.reduce((sum, file) => sum + numberValue(file.removed), 0),
    truncated: Boolean(payload.truncated)
  };
  const statuses = files
    .map((file) => normalizeStatus(stringValue(file.status)))
    .filter(Boolean)
    .map((status) => ({ status }));
  const statusCounts = countByStatus(statuses);
  const mixedRevision = payload.mixed_revision === true || stringValue(payload.note).toLowerCase().includes("mixed revision");
  const rawDiffExcerpt = stringValue(payload.diff_excerpt);
  const diffCharLimit = boundedInteger(request.maxChars, 12000, 256, 64000);
  const diffExcerpt = rawDiffExcerpt.slice(0, diffCharLimit);

  return {
    ok: payload.ok,
    ready: verdict === "READY",
    verdict,
    pathCount: stringArray(request.paths).length,
    statusCounts,
    diff,
    eol: {
      ok: allEolFailures.length === 0 && verdict !== "EOL_FIX_NEEDED",
      ...(eolFailures.length > 0 ? { failures: eolFailures } : {}),
      ...(allEolFailures.length > eolFailures.length
        ? { failureCount: allEolFailures.length, failuresTruncated: true }
        : {})
    },
    mixedRevision,
    ...(guardFailures.length > 0 ? { guardFailures } : {}),
    ...(allGuardFailures.length > guardFailures.length
      ? { guardFailureCount: allGuardFailures.length, guardFailuresTruncated: true }
      : {}),
    ...(riskSignals.length > 0 ? { riskSignals } : {}),
    ...(!payload.ok && payload.note ? { note: payload.note } : {}),
    ...(request.includeDiff === true
      ? {
          diffExcerpt,
          ...(diffExcerpt.length < rawDiffExcerpt.length ? { diffExcerptTruncated: true } : {})
        }
      : {}),
    ...(payload.truncated === true ? { truncated: true } : {})
  };
}

function compactMutation(tool: string, payload: ToolEnvelope, request: Record<string, unknown>): Record<string, unknown> {
  if (tool === "svn_revert" && request.dryRun === true) {
    return {
      ok: true,
      action: "revert",
      dryRun: true,
      counts: countByStatus(payload.changed_paths.map((item) => ({ status: normalizeStatus(item.status) })))
    };
  }

  const result = MUTATION_STATUS[tool];
  const verified = (tool === "svn_move" || tool === "svn_rename" || tool === "svn_copy")
    ? payload.changed_paths.length > 0
    : tool === "svn_commit"
      ? payload.revision !== null
      : tool === "eol_fix_verified"
        ? payload.after !== undefined
        : false;
  const receipt: Record<string, unknown> = {
    ok: true,
    action: tool.replace(/^svn_/, ""),
    ...(request.src !== undefined ? { source: request.src } : {}),
    ...(request.dest !== undefined ? { target: request.dest } : request.url !== undefined ? { target: request.url } : {}),
    ...(request.path !== undefined ? { path: request.path } : {}),
    ...(payload.revision !== null ? { revision: payload.revision } : {}),
    ...(verified ? { verifiedStatus: result } : { status: result })
  };

  if (payload.conflicts.length > 0) {
    receipt.conflicts = payload.conflicts.slice(0, 100).map((conflict) => ({
      path: relativePath(payload.cwd, conflict.path),
      type: conflict.type
    }));
    if (payload.conflicts.length > 100) {
      receipt.conflictCount = payload.conflicts.length;
      receipt.conflictsTruncated = true;
    }
  }
  if (payload.post_status_clean !== undefined) {
    receipt.postStatusClean = payload.post_status_clean;
  }
  if (tool === "svn_commit" && payload.post_status_clean === false && payload.changed_paths.length > 0) {
    receipt.residue = payload.changed_paths.slice(0, 100).map((item) => compactStatusItem(item, payload.cwd));
  }
  if (tool === "svn_update" && payload.changed_paths.length > 0) {
    receipt.counts = countByStatus(payload.changed_paths.map((item) => ({ status: normalizeStatus(item.status) })));
  }
  return receipt;
}

function compactEolFix(payload: ToolEnvelope, request: Record<string, unknown>): Record<string, unknown> {
  const before = compactEolState(payload.before);
  const after = compactEolState(payload.after);
  if (!payload.ok) {
    return {
      ...compactError(payload),
      action: "eol_fix_verified",
      ...(request.path ? { path: request.path } : {}),
      ...(before ? { before } : {})
    };
  }

  const dryRun = request.dryRun === true;
  return {
    ok: true,
    action: "eol_fix_verified",
    ...(request.path ? { path: request.path } : {}),
    target: payload.target,
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    pureEolChurn: payload.pure_eol_churn === true,
    ...(dryRun ? { dryRun: true } : { verified: after !== null })
  };
}

function compactStatus(payload: ToolEnvelope, request: Record<string, unknown>): Record<string, unknown> {
  const root = payload.cwd;
  const includeUnversioned = request.includeUnversioned !== false;
  const requestedStatuses = stringArray(request.statuses);
  const allowedStatuses = requestedStatuses.length > 0
    ? new Set(requestedStatuses.map((value) => normalizeStatus(value)))
    : null;
  const changed = payload.changed_paths
    .map((item) => compactStatusItem(item, root))
    .filter((item) => includeUnversioned || item.status !== "unversioned")
    .filter((item) => !allowedStatuses || allowedStatuses.has(item.status));
  const counts = countByStatus(changed);
  const offset = cursorOffset(request.cursor);
  const countOnly = request.countOnly === true;
  const maxItems = countOnly ? 0 : boundedInteger(request.maxItems, 100, 1, 500);
  const items = maxItems === 0 ? [] : changed.slice(offset, offset + maxItems);
  const nextOffset = offset + items.length;
  const truncated = !countOnly && nextOffset < changed.length;
  const conflicts = payload.conflicts.slice(0, 100).map((conflict) => ({
    path: relativePath(root, conflict.path),
    type: conflict.type
  }));

  return {
    ok: true,
    ...(request.cwd === undefined ? { root } : {}),
    counts,
    items,
    ...(conflicts.length > 0 ? { conflicts } : {}),
    ...(payload.conflicts.length > conflicts.length
      ? { conflictCount: payload.conflicts.length, conflictsTruncated: true }
      : {}),
    ...(payload.note ? { note: payload.note } : {}),
    truncated,
    ...(truncated ? { nextCursor: String(nextOffset) } : {})
  };
}

function compactStatusItem(item: ChangedPath, root: string): { path: string; status: string } {
  const relative = path.isAbsolute(item.path) ? path.relative(root, item.path) : item.path;
  return {
    path: relative || ".",
    status: normalizeStatus(item.status)
  };
}

function normalizeStatus(value: string): string {
  return STATUS_NAMES[value] ?? value.trim().toLowerCase();
}

function countByStatus(items: Array<{ status: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
  }
  return counts;
}

function summarizeToolResult(tool: string, payload: Record<string, unknown>): string {
  if (payload.ok !== true) {
    const note = typeof payload.note === "string" && payload.note ? payload.note : "command failed";
    return `ERROR ${tool}: ${note}`;
  }

  if (tool === "svn_status" && Array.isArray(payload.items)) {
    const total = sumCounts(payload.counts);
    const suffix = payload.truncated === true ? "; more available" : "";
    return `OK ${tool}: ${total} changes; ${payload.items.length} returned${suffix}`;
  }

  if (tool === "svn_log" && Array.isArray(payload.entries)) {
    return `OK ${tool}: ${payload.entries.length} revisions${payload.truncated === true ? "; more available" : ""}`;
  }

  if (tool === "svn_diff" && Array.isArray(payload.files)) {
    return `OK ${tool}: ${payload.files.length} changed files${payload.truncated === true ? "; more available" : ""}`;
  }

  return `OK ${tool}`;
}

function sumCounts(value: unknown): number {
  if (!value || typeof value !== "object") {
    return 0;
  }
  return Object.values(value).reduce<number>((sum, count) => sum + (typeof count === "number" ? count : 0), 0);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function compactEolState(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const state = value as Record<string, unknown>;
  return {
    kind: state.kind,
    hasBom: state.has_bom === true
  };
}

function cursorOffset(value: unknown): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return 0;
  }
  return Number.parseInt(value, 10);
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

function boundedDiffExcerpt(text: string, offset: number, maxChars: number, maxHunksPerFile: number): {
  text: string;
  nextOffset: number;
  lineTruncated: boolean;
} {
  const lines = text ? text.split("\n") : [];
  const selected: string[] = [];
  const hunksByFile = new Map<string, number>();
  let currentFile = "";
  let nextOffset = Math.min(offset, lines.length);
  let selectedChars = 0;
  let lineTruncated = false;

  for (let index = nextOffset; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("Index: ")) {
      currentFile = line.slice("Index: ".length);
    } else if (line.startsWith("@@")) {
      const count = (hunksByFile.get(currentFile) ?? 0) + 1;
      if (count > maxHunksPerFile) {
        break;
      }
      hunksByFile.set(currentFile, count);
    }

    const separator = selected.length === 0 ? "" : "\n";
    if (selectedChars + separator.length + line.length > maxChars) {
      if (selected.length === 0) {
        selected.push(line.slice(0, maxChars));
        nextOffset = index + 1;
        lineTruncated = true;
      }
      break;
    }
    selected.push(line);
    selectedChars += separator.length + line.length;
    nextOffset = index + 1;
  }

  return { text: selected.join("\n"), nextOffset, lineTruncated };
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
}

function projectFields(source: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter((field) => field in source).map((field) => [field, source[field]]));
}

function relativePath(root: string, candidate: string): string {
  if (!candidate || !path.isAbsolute(candidate)) {
    return candidate;
  }
  return path.relative(root, candidate) || ".";
}

function firstLine(value: string): string {
  return (value.split(/\r?\n/, 1)[0] ?? "").slice(0, 240);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function lineCount(value: string): number {
  return value ? value.split("\n").length : 0;
}
