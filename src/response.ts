import path from "node:path";
import { redactText } from "./envelope.js";
import { processSnapshotTokens } from "./snapshotToken.js";
import type { ChangedPath, ToolEnvelope } from "./types.js";

export type ResponseMode = "compact" | "standard" | "full" | "receipt" | "structured-only";

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
  E: "existed",
  G: "merged",
  I: "ignored",
  M: "modified",
  R: "replaced",
  U: "updated",
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
  svn_delete: "deleted",
  svn_export: "exported",
  svn_import: "imported",
  svn_move: "renamed",
  svn_path_change: "changed",
  svn_prepare_commit: "prepared",
  svn_propset: "property-set",
  svn_propset_eol_style: "property-set",
  svn_rename: "renamed",
  svn_resolve: "resolved",
  svn_resolved: "resolved",
  svn_revert: "reverted",
  svn_update: "updated"
};

// Keep compact diff results comfortably below common client/relay message
// thresholds. Stdio is a byte stream, so clients must still buffer through the
// newline delimiter; this bound limits the damage from clients that do not.
const COMPACT_DIFF_RESULT_BUDGET_BYTES = 28 * 1024;
const COMPACT_LOG_RESULT_BUDGET_BYTES = 24 * 1024;
const COMPACT_DIFF_EXCERPT_CHAR_LIMIT = 8_000;
const COMPACT_DIFF_PREVIEW_CHAR_LIMIT = 512;
const COMPACT_CONFLICT_PAGE_SIZE = 100;
const COMPACT_TOP_FOLDER_LIMIT = 25;
const COMPACT_PREPARE_PATH_LIMIT = 25;
const RECEIPT_TOOLS = new Set(["svn_status", "svn_snapshot", "svn_precommit", "svn_prepare_commit", "svn_update", "svn_commit"]);

export function defaultResponseMode(
  env: Readonly<Record<string, string | undefined>> = process.env
): ResponseMode {
  const value = env.SVN_MCP_RESPONSE_MODE?.trim().toLowerCase();
  return value === "standard" || value === "full" || value === "receipt" || value === "structured-only"
    ? value
    : "compact";
}

export function toToolResult<T extends ToolEnvelope>(
  tool: string,
  payload: T,
  options: ResponseOptions = {}
): ToolResult<Record<string, unknown>> {
  const mode = options.responseMode ?? defaultResponseMode();
  const request = options.request ?? {};
  const responseRoot = stringValue(payload.wc_root) || payload.cwd;
  const safePayload = mode === "full" ? redactStructuredValue(payload) as T : payload;
  const shaped = shapePayload(tool, safePayload, mode, request);
  const candidateWarning = mode !== "full" && payload.ok
    ? sanitizeNonFullText(redactText(payload.stderr_summary.slice(0, 2000)), payload.cwd, responseRoot)
    : "";
  const shapedNote = sanitizeNonFullText(redactText(stringValue(shaped.note)), payload.cwd, responseRoot);
  const warning = candidateWarning && shapedNote !== candidateWarning ? candidateWarning : "";
  const warned = warning
    ? {
        ...shaped,
        warning,
        ...(warning.length < safePayload.stderr_summary.length ? { warningTruncated: true } : {})
      }
    : shaped;
  const projected = applyFieldProjection(tool, safePayload, warned, request);
  const structured = mode === "full"
    ? projected
    : sanitizeNonFullStructuredValue(redactStructuredValue(projected), payload.cwd, responseRoot) as Record<string, unknown>;
  const humanText = request.humanText === true;
  const text = mode === "full" ? JSON.stringify(safePayload, null, 2) : summarizeToolResult(tool, structured);

  return {
    content: humanText ? [{ type: "text", text }] : [],
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

  if (mode === "receipt" && RECEIPT_TOOLS.has(tool)) {
    return receiptPayload(tool, payload, request);
  }

  const compactMode = mode === "compact" || mode === "structured-only" || mode === "receipt";

  if (compactMode && tool === "svn_diagnose") {
    return compactDiagnose(payload, request);
  }

  if (compactMode && tool === "svn_precommit") {
    return compactPrecommit(payload, request);
  }

  if (compactMode && tool === "svn_commit"
      && (payload.operation === "safe_commit" || payload.operation === "safe_commit_detail")) {
    return compactSafeCommit(payload);
  }

  if (compactMode && (tool === "svn_prepare_commit" || (tool === "svn_commit" && payload.operation === "prepare_commit"))) {
    return compactPrepareCommit(payload, request);
  }

  if (compactMode && tool === "svn_self_check") {
    return compactSelfCheck(payload, request);
  }

  if (compactMode && tool === "eol_fix_verified") {
    return compactEolFix(payload, request);
  }

  if (!payload.ok) {
    return compactMode ? compactError(payload, request) : standardPayload(payload);
  }

  if (compactMode && tool === "svn_status") {
    return compactStatus(payload, request);
  }

  if (compactMode && tool === "svn_info") {
    return compactInfo(payload, request);
  }

  if (compactMode && tool === "svn_snapshot") {
    return compactSnapshot(payload, request);
  }

  if (compactMode && tool === "svn_log") {
    return compactLog(payload, request);
  }

  if (compactMode && tool === "svn_diff") {
    return compactDiff(payload, request);
  }

  if (compactMode && tool === "svn_cat") {
    return compactCat(payload, request);
  }

  if (compactMode && tool === "svn_blame") {
    return compactBlame(payload, request);
  }

  if (compactMode && tool === "eol_check") {
    return compactEolCheck(payload, request);
  }

  if (compactMode && tool === "svn_propget") {
    return compactPropget(payload, request);
  }

  if (compactMode && MUTATION_STATUS[tool]) {
    return compactMutation(tool, payload, request);
  }

  return standardPayload(payload);
}

function receiptPayload(
  tool: string,
  payload: ToolEnvelope,
  request: Record<string, unknown>
): Record<string, unknown> {
  if (tool === "svn_prepare_commit" || (tool === "svn_commit" && payload.operation === "prepare_commit")) {
    return compactPrepareReceipt(payload);
  }
  if (tool === "svn_commit" && (payload.operation === "safe_commit" || payload.operation === "safe_commit_detail")) {
    return compactSafeCommit(payload);
  }
  if (!payload.ok) {
    const error = compactError(payload, request);
    return {
      ok: false,
      ...(payload.operation_id ? { operationId: payload.operation_id } : {}),
      ...(payload.idempotent_replay === true ? { idempotentReplay: true } : {}),
      ...(payload.operation_recovered === true ? { operationRecovered: true } : {}),
      ...(payload.verdict ? { verdict: payload.verdict } : {}),
      ...(error.note ? { note: error.note } : {}),
      ...(error.recoveryTool ? { recoveryTool: error.recoveryTool } : {}),
      ...(error.expectedRemoteHead !== undefined ? { expectedRemoteHead: error.expectedRemoteHead } : {}),
      ...(error.observedRemoteHead !== undefined ? { observedRemoteHead: error.observedRemoteHead } : {})
    };
  }

  const root = stringValue(payload.wc_root) || payload.cwd;
  const sourcePaths = tool === "svn_commit" && payload.committed_paths !== undefined
    ? stringArray(payload.committed_paths)
    : payload.changed_paths.map((item) => item.path);
  const countOnly = request.countOnly === true;
  const changedPaths = countOnly
    ? []
    : uniqueStrings(sourcePaths.map((item) => workingCopyRelativePath(item, payload.cwd, root)));
  const offset = cursorOffset(request.cursor);
  const maxPaths = boundedInteger(request.maxItems, 25, 1, 100);
  const page = changedPaths.slice(offset, offset + maxPaths);
  const files = recordArray(payload.per_file);
  const added = files.reduce((sum, file) => sum + numberValue(file.added), 0);
  const removed = files.reduce((sum, file) => sum + numberValue(file.removed), 0);
  const baseRevision = payload.base_revision
    ?? (tool === "svn_status" || tool === "svn_snapshot" || tool === "svn_precommit" ? payload.revision : undefined);
  const remoteHead = payload.remote_head_revision ?? payload.observed_remote_head;
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < changedPaths.length ? String(nextOffset) : payload.next_cursor;

  const result = {
    ok: true,
    ...(payload.verdict ? { verdict: payload.verdict } : {}),
    ...(baseRevision !== null && baseRevision !== undefined ? { baseRevision } : {}),
    ...(payload.resulting_revision !== undefined ? { resultingRevision: payload.resulting_revision } : {}),
    ...(payload.committed_revision !== undefined ? { committedRevision: payload.committed_revision } : {}),
    ...(remoteHead !== null && remoteHead !== undefined ? { remoteHeadRevision: remoteHead } : {}),
    ...(countOnly ? { changedCount: sourcePaths.length } : {}),
    ...(page.length > 0 ? { changedPaths: page } : {}),
    conflictCount: payload.conflicts.length,
    ...(files.length > 0 ? { added, removed } : {}),
    ...(payload.operation_id ? { operationId: payload.operation_id } : {}),
    ...(payload.idempotent_replay === true ? { idempotentReplay: true } : {}),
    ...(payload.operation_recovered === true ? { operationRecovered: true } : {}),
    ...(nextCursor ? { nextCursor } : {})
  };
  if (tool === "svn_status" || tool === "svn_snapshot") {
    const snapshotRoot = stringValue(payload.wc_root) || payload.cwd;
    return withSnapshotToken(tool, payload, request, result, {
      revision: payload.revision,
      revisionRange: payload.revision_range,
      mixedRevision: payload.mixed_revision,
      remoteHeadRevision: payload.remote_head_revision,
      changed: canonicalStatusItems(payload, request, payload.cwd, snapshotRoot),
      conflicts: payload.conflicts
    });
  }
  return result;
}

function standardPayload(payload: ToolEnvelope): Record<string, unknown> {
  const root = stringValue(payload.wc_root) || payload.cwd;
  const relative = relativeizeStructuredPaths(payload, payload.cwd, root) as Record<string, unknown>;
  const result: Record<string, unknown> = { ...relative, stdout_summary: "" };
  delete result.command;
  delete result.cwd;
  delete result.wc_root;
  return result;
}

const PROJECTION_SAFETY_FIELDS = [
  "ok", "ready", "verdict", "code", "note", "warning", "warningCode", "warningDetail",
  "failedRule", "suggestedMessage", "guardCode", "guardFailures", "conflicts",
  "conflictsTruncated", "nextConflictCursor", "truncated", "nextCursor", "nextFileCursor",
  "hasMore", "recoveryTool", "remediation",
  "snapshotToken", "unchangedSinceCursor", "changedSinceCursor",
  "operationId", "idempotentReplay", "operationRecovered"
] as const;

function applyFieldProjection(
  tool: string,
  payload: ToolEnvelope,
  shaped: Record<string, unknown>,
  request: Record<string, unknown>
): Record<string, unknown> {
  const fields = stringArray(request.fields);
  if (fields.length === 0 || !payload.ok || tool === "svn_propget") {
    return shaped;
  }

  const root = stringValue(payload.wc_root) || payload.cwd;
  const perFile = recordArray(payload.per_file);
  const fallbackOffset = cursorOffset(request.cursor);
  const fallbackLimit = boundedInteger(request.maxItems, 100, 1, 500);
  const usesFallbackChangedPaths = !Array.isArray(shaped.changedPaths) && !Array.isArray(shaped.items);
  const fallbackNextOffset = Math.min(payload.changed_paths.length, fallbackOffset + fallbackLimit);
  const fallbackHasMore = usesFallbackChangedPaths && fallbackNextOffset < payload.changed_paths.length;
  const standardShape = Array.isArray(shaped.changed_paths);
  const changedPaths = Array.isArray(shaped.changedPaths)
    ? shaped.changedPaths
    : Array.isArray(shaped.items)
      ? shaped.items
      : payload.changed_paths.slice(fallbackOffset, fallbackOffset + fallbackLimit).map((item) => ({
          status: item.status,
          path: workingCopyRelativePath(item.path, payload.cwd, root)
        }));
  const boundedConflicts = compactConflictPage(payload, request, payload.cwd, root);
  const conflicts = !standardShape && Array.isArray(shaped.conflicts)
    ? shaped.conflicts
    : boundedConflicts.conflicts;
  const source: Record<string, unknown> = {
    ...shaped,
    revision: payload.revision,
    revisionRange: payload.revision_range,
    mixedRevision: payload.mixed_revision,
    remoteHeadRevision: payload.remote_head_revision ?? payload.observed_remote_head,
    changedPaths,
    conflicts,
    ...(standardShape ? boundedConflicts : {}),
    totalFiles: perFile.length,
    added: payload.total_added ?? perFile.reduce((sum, file) => sum + numberValue(file.added), 0),
    removed: payload.total_removed ?? perFile.reduce((sum, file) => sum + numberValue(file.removed), 0),
    ...(fallbackHasMore ? { truncated: true, nextCursor: String(fallbackNextOffset) } : {})
  };
  const projected = projectFields(source, fields);
  for (const field of PROJECTION_SAFETY_FIELDS) {
    const value = source[field];
    if (value !== undefined && value !== false && value !== ""
        && (!Array.isArray(value) || value.length > 0) && projected[field] === undefined) {
      projected[field] = value;
    }
  }
  if (source.conflictsTruncated === true && source.conflictCount !== undefined
      && projected.conflictCount === undefined) {
    projected.conflictCount = source.conflictCount;
  }
  return { ok: true, ...projected };
}

const ROOT_RELATIVE_PATH_ARRAY_KEYS = new Set(["committed_paths", "filtered_paths", "missing_paths"]);
const PATH_STRING_KEYS = new Set(["path", "src", "dest", "source", "target"]);

function relativeizeStructuredPaths(value: unknown, cwd: string, wcRoot: string, parentKey = ""): unknown {
  if (Array.isArray(value)) {
    if (ROOT_RELATIVE_PATH_ARRAY_KEYS.has(parentKey)) {
      return value.map((item) => typeof item === "string" ? item.replace(/\\/g, "/") : item);
    }
    return value.map((item) => relativeizeStructuredPaths(item, cwd, wcRoot, parentKey));
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && PATH_STRING_KEYS.has(parentKey)) {
      return workingCopyPathIfInside(value, cwd, wcRoot);
    }
    return value;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    relativeizeStructuredPaths(item, cwd, wcRoot, key)
  ]));
}

function workingCopyPathIfInside(value: string, cwd: string, wcRoot: string): string {
  if (!value || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    return value;
  }
  const pathApi = pathImplementationFor(cwd, wcRoot, value);
  const absolute = pathApi.isAbsolute(value) ? value : pathApi.resolve(cwd, value);
  const relative = pathApi.relative(wcRoot, absolute);
  if (relative === ".." || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
    return value.replace(/\\/g, "/");
  }
  return (relative || ".").replace(/\\/g, "/");
}

function compactError(payload: ToolEnvelope, request: Record<string, unknown> = {}): Record<string, unknown> {
  const conflicts = payload.conflicts.slice(0, 100);
  const riskSignals = stringArray(payload.risk_signals);
  const guardCode = classifyGuardCode(payload.note);
  const submittedPathCount = stringArray(request.paths).length;
  return {
    ok: false,
    ...(payload.operation_id ? { operationId: payload.operation_id } : {}),
    ...(payload.idempotent_replay === true ? { idempotentReplay: true } : {}),
    ...(payload.operation_recovered === true ? { operationRecovered: true } : {}),
    ...(payload.code ? { code: payload.code } : {}),
    ...(guardCode ? { guardCode } : {}),
    note: payload.note || "svn command failed",
    ...(!guardCode && payload.stdout_summary ? { stdout: payload.stdout_summary } : {}),
    ...(!guardCode && payload.stderr_summary ? { stderr: payload.stderr_summary } : {}),
    ...(guardCode && submittedPathCount > 1 ? { affectedPathCount: submittedPathCount } : {}),
    ...(conflicts.length > 0 ? { conflicts } : {}),
    ...(payload.conflicts.length > conflicts.length
      ? { conflictCount: payload.conflicts.length, conflictsTruncated: true }
      : {}),
    ...(payload.truncated ? { truncated: true } : {}),
    ...(payload.recovery_tool ? { recoveryTool: payload.recovery_tool } : {}),
    ...(payload.expected_remote_head !== undefined ? { expectedRemoteHead: payload.expected_remote_head } : {}),
    ...(payload.observed_remote_head !== undefined ? { observedRemoteHead: payload.observed_remote_head } : {}),
    ...(riskSignals.length > 0 ? { riskSignals } : {})
  };
}

function classifyGuardCode(note: string): string | null {
  if (/never-commit|policy-error:/i.test(note)) return "NEVER_COMMIT";
  if (/path (?:resolves )?outside working copy|not inside a working copy/i.test(note)) return "PATH_CONTAINMENT";
  if (/READONLY instance/i.test(note)) return "READONLY";
  if (/explicit (?:path|paths|src and dest)|cwd or absolute path required/i.test(note)) return "EXPLICIT_SCOPE";
  if (/riskAck required/i.test(note)) return "RISK_ACK";
  if (/working-copy root.*requires|refusing to .*working-copy root/i.test(note)) return "ROOT_SCOPE";
  if (/directory .*requires allow/i.test(note)) return "DIRECTORY_SCOPE";
  if (/unresolved conflicts?|non-committable status/i.test(note)) return "CONFLICT";
  return null;
}

function compactDiagnose(payload: ToolEnvelope, request: Record<string, unknown>): Record<string, unknown> {
  const checks = recordArray(payload.checks);
  const includePassing = request.includePassing === true;
  const selected = includePassing ? checks : checks.filter((check) => check.ok !== true);
  const offset = cursorOffset(request.cursor);
  const maxItems = boundedInteger(request.maxItems, 100, 1, 500);
  const page = selected.slice(offset, offset + maxItems);
  const failed = page.filter((check) => check.ok !== true)
    .map((check) => ({ name: check.name, ...(check.note ? { note: check.note } : {}) }));
  const passing = page.filter((check) => check.ok === true).map((check) => ({ name: check.name }));
  const nextOffset = offset + page.length;
  const truncated = nextOffset < selected.length;
  const suggestions = stringArray(payload.suggestions);
  return {
    ok: payload.ok,
    health: payload.health,
    svnAvailable: payload.svn_available,
    workingCopyValid: payload.working_copy_valid,
    remoteAccessible: payload.remote_accessible,
    checks: {
      passed: checks.filter((check) => check.ok === true).length,
      failed,
      ...(includePassing ? { passing } : {})
    },
    ...(payload.note ? { note: payload.note } : {}),
    ...(suggestions.length > 0 ? { suggestions } : {}),
    ...(truncated ? { truncated: true, nextCursor: String(nextOffset) } : {})
  };
}

function compactInfo(payload: ToolEnvelope, request: Record<string, unknown>): Record<string, unknown> {
  const available: Record<string, unknown> = {
    root: ".",
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

function compactSnapshot(payload: ToolEnvelope, request: Record<string, unknown>): Record<string, unknown> {
  const info = compactInfo(payload, {});
  const status = compactStatus(payload, {
    ...request,
    cwd: request.cwd ?? payload.cwd,
    suppressSnapshotToken: true,
    afterCursor: undefined
  });
  const { ok: _infoOk, ...infoFields } = info;
  const { ok: _statusOk, truncated, ...statusFields } = status;
  const result = {
    ok: true,
    ...infoFields,
    ...statusFields,
    ...(payload.baseline_token ? { baselineToken: payload.baseline_token } : {}),
    ...(payload.baseline_expires_at ? { baselineExpiresAt: payload.baseline_expires_at } : {}),
    ...(payload.baseline_path_count !== undefined ? { baselinePathCount: payload.baseline_path_count } : {}),
    ...(truncated === true ? { truncated: true } : {})
  };
  return withSnapshotToken("svn_snapshot", payload, request, result, {
    revision: payload.revision,
    revisionRange: payload.revision_range,
    remoteHeadRevision: payload.remote_head_revision,
    mixedRevision: payload.mixed_revision,
    changed: canonicalStatusItems(payload, request, payload.cwd, stringValue(payload.wc_root) || payload.cwd),
    conflicts: payload.conflicts
  });
}

function compactCat(payload: ToolEnvelope, request: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: true,
    path: payload.path ?? request.path,
    content: payload.content,
    ...(payload.binary === true ? { binary: true } : {}),
    hasMore: payload.has_more === true,
    ...(payload.next_cursor ? { nextCursor: payload.next_cursor } : {})
  };
}

function compactBlame(payload: ToolEnvelope, request: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: true,
    path: payload.path ?? request.path,
    lines: recordArray(payload.lines).slice(0, 500),
    hasMore: payload.has_more === true,
    ...(payload.ignore_eol === false ? { eolChangesIncluded: true } : {}),
    ...(payload.next_cursor ? { nextCursor: payload.next_cursor } : {})
  };
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
    return {
      ok: payload.ok,
      version: payload.server_version,
      packageVersion: payload.package_version,
      available: payload.toolchain_ok === true && payload.runtime_layout_ok === true,
      runtimeLayout: payload.runtime_layout,
      runtimeLayoutOk: payload.runtime_layout_ok,
      currentPointerApplicable: payload.current_pointer_applicable,
      currentRelease: payload.current_release,
      currentMatchesPackage: payload.current_matches_package,
      binFileCount: payload.bin_file_count,
      distFileCount: payload.dist_file_count,
      releasePrepareAvailable: payload.release_prepare_available,
      cleanUsesNode: payload.clean_uses_node,
      toolchainOk: payload.toolchain_ok,
      startupProbe: payload.startup_probe,
      ...(payload.tool_profile ? { toolProfile: payload.tool_profile } : {}),
      ...(payload.advertised_tool_count !== undefined ? { advertisedToolCount: payload.advertised_tool_count } : {}),
      ...(payload.note ? { diagnostics: payload.note } : {})
    };
  }
  return {
    ok: payload.ok,
    version: payload.server_version,
    available: payload.toolchain_ok === true && payload.runtime_layout_ok === true,
    ...(payload.tool_profile ? { toolProfile: payload.tool_profile } : {}),
    ...(payload.advertised_tool_count !== undefined ? { advertisedToolCount: payload.advertised_tool_count } : {}),
    ...(payload.note ? { diagnostics: payload.note } : {})
  };
}

function redactStructuredValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactStructuredValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactStructuredValue(item)])
  );
}

function compactLog(payload: ToolEnvelope, request: Record<string, unknown>): Record<string, unknown> {
  const sourceEntries = recordArray(payload.entries);
  const limit = boundedInteger(request.limit, 10, 1, 100);
  const includeFullMessage = request.fullMessage === true;
  const includeChangedPathsSummary = request.changedPathsSummary === true;
  const includeChangedPaths = !includeChangedPathsSummary && (request.changedPaths === true || request.verbose === true);
  const maxMessageChars = boundedInteger(request.maxMessageChars, includeFullMessage ? 2000 : 240, 32, 8000);
  const maxChangedPaths = boundedInteger(request.maxChangedPaths, 100, 1, 500);
  const maxTopLevelDirectories = boundedInteger(request.maxTopLevelDirectories, 10, 1, 50);
  const entryCount = numberValue(payload.entry_count) || sourceEntries.length;
  const revisionRange = payload.revision_range ?? revisionRangeFromLogEntries(sourceEntries);
  const continuationFloor = logContinuationFloor(request);
  const sourceNextCursor = stringValue(payload.next_cursor);
  const requestedEntries = sourceEntries.slice(0, limit);
  const shapeEntries = (entryLimit: number, changedPathLimit: number) => requestedEntries.slice(0, entryLimit).map((entry) => {
    const rawMessage = redactText(includeFullMessage ? stringValue(entry.msg) : firstLine(stringValue(entry.msg)));
    const message = rawMessage.slice(0, maxMessageChars);
    const allChangedPaths = recordArray(entry.changed_paths);
    const changedPaths = allChangedPaths.slice(0, changedPathLimit).map((item) => ({
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
        : {}),
      ...(includeChangedPathsSummary
        ? { changedPathsSummary: summarizeLogChangedPaths(allChangedPaths, maxTopLevelDirectories) }
        : {})
    };
  });
  const buildResult = (entries: Array<Record<string, unknown>>) => {
    const entryTruncated = payload.has_more === true || sourceEntries.length > entries.length;
    const pathTruncated = entries.some((entry) => entry.changedPathsTruncated === true);
    const lastRevision = entries.at(-1)?.revision;
    const nextRevision = typeof lastRevision === "number" ? lastRevision - 1 : null;
    const nextCursor = sourceNextCursor || (entryTruncated && nextRevision !== null
        && continuationFloor !== null && nextRevision >= continuationFloor
      ? continuationFloor > 0
        ? `${nextRevision}:${continuationFloor}`
        : String(Math.max(0, nextRevision))
      : null);
    return {
      ok: true,
      ...(entryCount > 1 ? { revision: null, revisionRange, entryCount } : {}),
      entries,
      ...(request.messageContains !== undefined
        ? {
            scannedCount: numberValue(payload.scanned_count),
            matchedCount: numberValue(payload.matched_count),
            scanTruncated: payload.scan_truncated === true,
            ...(entries.length === 0 ? { noMatches: true } : {})
          }
        : {}),
      ...(payload.target_mode === "working-copy-path" ? { targetMode: payload.target_mode } : {}),
      truncated: entryTruncated || pathTruncated,
      ...(nextCursor !== null ? { nextCursor } : {})
    };
  };

  const entryLimit = requestedEntries.length === 0
    ? 0
    : largestFittingInteger(1, requestedEntries.length, (candidate) =>
        serializedByteLength(buildResult(shapeEntries(candidate, 0))) <= COMPACT_LOG_RESULT_BUDGET_BYTES);
  const entries = shapeEntries(entryLimit, 0);
  if (includeChangedPaths) {
    let saturated = false;
    for (let entryIndex = 0; entryIndex < entries.length && !saturated; entryIndex += 1) {
      const entry = entries[entryIndex];
      const source = requestedEntries[entryIndex];
      if (!entry || !source) continue;
      const allChangedPaths = recordArray(source.changed_paths);
      const changedPaths = entry.changedPaths as Array<Record<string, unknown>>;
      const pathLimit = Math.min(maxChangedPaths, allChangedPaths.length);
      for (let pathIndex = 0; pathIndex < pathLimit; pathIndex += 1) {
        const item = allChangedPaths[pathIndex];
        if (!item) continue;
        changedPaths.push({
          status: redactText(stringValue(item.status)).slice(0, 16),
          path: redactText(stringValue(item.path)).slice(0, 4096)
        });
        if (changedPaths.length >= allChangedPaths.length) delete entry.changedPathsTruncated;
        if (serializedByteLength(buildResult(entries)) > COMPACT_LOG_RESULT_BUDGET_BYTES) {
          changedPaths.pop();
          if (changedPaths.length < allChangedPaths.length) entry.changedPathsTruncated = true;
          saturated = true;
          break;
        }
      }
    }
  }
  return buildResult(entries);
}

function summarizeLogChangedPaths(
  changedPaths: Array<Record<string, unknown>>,
  maxTopLevelDirectories: number
): Record<string, unknown> {
  const actions: Record<string, number> = {};
  const directories = new Map<string, number>();
  for (const item of changedPaths) {
    const action = logActionName(stringValue(item.status));
    actions[action] = (actions[action] ?? 0) + 1;
    const normalized = stringValue(item.path).replace(/\\/g, "/").replace(/^\/+/, "");
    const rawTop = normalized.includes("/") ? normalized.split("/", 1)[0] ?? "." : ".";
    const top = redactText(rawTop).slice(0, 256);
    directories.set(top, (directories.get(top) ?? 0) + 1);
  }
  const allDirectories = [...directories.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const topLevelDirectories = allDirectories.slice(0, maxTopLevelDirectories)
    .map(([path, count]) => ({ path, count }));
  return {
    total: changedPaths.length,
    actions,
    topLevelDirectories,
    ...(topLevelDirectories.length < allDirectories.length
      ? { topLevelDirectoriesTruncated: true, topLevelDirectoryCount: allDirectories.length }
      : {})
  };
}

function logActionName(value: string): string {
  return ({ M: "modified", A: "added", D: "deleted", R: "replaced" } as Record<string, string>)[value]
    ?? (value ? value.toLowerCase() : "unknown");
}

function revisionRangeFromLogEntries(entries: Array<Record<string, unknown>>): { min: number; max: number } | null {
  const revisions = entries
    .map((entry) => entry.rev)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return revisions.length > 1 ? { min: Math.min(...revisions), max: Math.max(...revisions) } : null;
}

// Lower bound a paginated svn_log continuation must not cross. Null means no
// safe numeric continuation exists (single, symbolic, date, or ascending
// selectors), so no cursor is offered and callers must narrow the range.
function logContinuationFloor(request: Record<string, unknown>): number | null {
  const cursor = typeof request.cursor === "string" ? request.cursor : "";
  const cursorRange = cursor.match(/^\d+:(\d+)$/);
  if (cursorRange) {
    return Number.parseInt(cursorRange[1] ?? "0", 10);
  }
  if (/^\d+$/.test(cursor)) {
    return 0;
  }
  const revision = typeof request.revision === "string" ? request.revision : "";
  if (!revision) {
    return 0;
  }
  const range = revision.match(/^(\d+):(\d+)$/);
  if (!range) {
    return null;
  }
  const upper = Number.parseInt(range[1] ?? "0", 10);
  const lower = Number.parseInt(range[2] ?? "0", 10);
  return upper >= lower ? lower : null;
}

function compactDiff(payload: ToolEnvelope, request: Record<string, unknown>): Record<string, unknown> {
  const requestedMode = stringValue(request.diffMode);
  const mode = requestedMode === "summary" || requestedMode === "counts"
    ? "counts"
    : requestedMode === "hunk-headings" || requestedMode === "full"
      ? requestedMode
      : "compact";
  const sourceFiles = recordArray(payload.per_file);
  const fileSummaryTruncated = payload.per_file_truncated === true;
  const fileOffset = cursorOffset(request.fileCursor);
  const requestedFileCount = boundedInteger(request.maxFiles, 100, 1, 500);
  const diffRoot = stringValue(payload.wc_root) || payload.cwd;
  const requestedFiles = sourceFiles.slice(fileOffset, fileOffset + requestedFileCount).map((file) => {
    const firstHunk = boundedPreview(stringValue(file.first_hunk), COMPACT_DIFF_PREVIEW_CHAR_LIMIT);
    const firstMeaningfulLine = boundedPreview(stringValue(file.first_meaningful_line), COMPACT_DIFF_PREVIEW_CHAR_LIMIT);
    return {
      path: redactText(workingCopyRelativePath(stringValue(file.path), payload.cwd, diffRoot)).slice(0, 4096),
      added: file.added,
      removed: file.removed,
      binary: file.binary,
      ...(file.property_changed === true ? { propertyChanged: true } : {}),
      ...(file.hunks !== undefined ? { hunks: numberValue(file.hunks) } : {}),
      ...(firstHunk.text ? { firstHunk: firstHunk.text } : {}),
      ...(firstMeaningfulLine.text ? { firstMeaningfulLine: firstMeaningfulLine.text } : {}),
      ...(file.preview_truncated === true || firstHunk.truncated || firstMeaningfulLine.truncated
        ? { previewTruncated: true }
        : {})
    };
  });
  const excerpt = stringValue(payload.diff_excerpt);
  const offset = numberValue(payload.page_offset);
  const requestedExcerptCharLimit = Math.min(
    boundedInteger(request.maxChars, mode === "full" ? COMPACT_DIFF_EXCERPT_CHAR_LIMIT : 3000, 256, 64000),
    COMPACT_DIFF_EXCERPT_CHAR_LIMIT
  );
  const maxHunksPerFile = mode === "full"
    ? Number.MAX_SAFE_INTEGER
    : boundedInteger(request.maxHunksPerFile, 1, 1, 20);
  const totalFiles = numberValue(payload.total_files) || sourceFiles.length;
  const totalLines = numberValue(payload.total_lines);
  const totalChars = numberValue(payload.total_chars);
  const totalHunks = numberValue(payload.total_hunks);
  const totalAdded = payload.total_added === undefined
    ? sourceFiles.reduce((sum, file) => sum + numberValue(file.added), 0)
    : numberValue(payload.total_added);
  const totalRemoved = payload.total_removed === undefined
    ? sourceFiles.reduce((sum, file) => sum + numberValue(file.removed), 0)
    : numberValue(payload.total_removed);
  const binaryFiles = numberValue(payload.binary_files);
  const propertyFiles = numberValue(payload.property_files);
  const evidenceTerminalTruncation = payload.evidence_terminal_truncation === true;

  const buildResult = (fileCount: number, excerptCharLimit: number): Record<string, unknown> => {
    const files = requestedFiles.slice(0, fileCount);
    const nextFileOffset = fileOffset + files.length;
    const filesTruncated = nextFileOffset < sourceFiles.length;
    const pagedFiles = fileOffset > 0 || filesTruncated;
    const base = {
      ok: true,
      files,
      totalFiles,
      totalLines,
      totalChars,
      totalHunks,
      added: totalAdded,
      removed: totalRemoved,
      ...(payload.totals_complete === false ? { totalsComplete: false } : {}),
      ...(binaryFiles > 0 ? { binaryFiles } : {}),
      ...(propertyFiles > 0 ? { propertyFiles } : {}),
      ...(payload.operation_id ? { operationId: payload.operation_id } : {}),
      ...(payload.evidence_expires_at ? { evidenceExpiresAt: payload.evidence_expires_at } : {}),
      ...(payload.evidence_truncated === true ? { evidenceTruncated: true } : {}),
      ...(evidenceTerminalTruncation ? { evidenceTerminalTruncation: true } : {}),
      ...(payload.eol_only === true ? { eolOnly: true, note: "EOL-only, no content change" } : {}),
      ...(fileSummaryTruncated ? { fileSummaryTruncated: true } : {}),
      ...(pagedFiles
        ? {
            filesTruncated,
            ...(filesTruncated ? { nextFileCursor: String(nextFileOffset) } : {})
          }
        : {}),
      ...(payload.ignore_eol === false ? { ignoreEol: false, eolChangesIncluded: true } : {})
    };

    if (mode === "counts") {
      return {
        ...base,
        truncated: fileSummaryTruncated || filesTruncated || evidenceTerminalTruncation
      };
    }

    if (mode === "hunk-headings") {
      const headingFiles = files.map((file) => ({
        ...file,
        omittedHunks: Math.max(0, numberValue(file.hunks) - (file.firstHunk ? 1 : 0))
      }));
      const omittedHunks = headingFiles.reduce((sum, file) => sum + numberValue(file.omittedHunks), 0)
        + Math.max(0, totalHunks - files.reduce((sum, file) => sum + numberValue(file.hunks), 0));
      return {
        ...base,
        files: headingFiles,
        omittedHunks,
        omittedLines: totalLines,
        truncated: omittedHunks > 0 || fileSummaryTruncated || filesTruncated || payload.truncated === true,
        ...(payload.operation_id && totalLines > 0 && !evidenceTerminalTruncation ? { nextCursor: "0" } : {})
      };
    }

    const page = boundedDiffExcerpt(excerpt, 0, excerptCharLimit, maxHunksPerFile);
    const hasContinuation = page.nextOffset < lineCount(excerpt)
      || (Boolean(payload.truncated) && !evidenceTerminalTruncation);
    const pageHunks = page.text.split("\n").filter((line) => line.startsWith("@@")).length;
    return {
      ...base,
      excerpt: page.text,
      omittedHunks: Math.max(0, totalHunks - pageHunks),
      omittedLines: Math.max(0, totalLines - lineCount(page.text)),
      truncated: hasContinuation || page.lineTruncated || fileSummaryTruncated || filesTruncated
        || evidenceTerminalTruncation,
      ...(page.lineTruncated ? { lineTruncated: true } : {}),
      ...(hasContinuation ? { nextCursor: stringValue(payload.next_cursor) || String(offset + page.nextOffset) } : {})
    };
  };

  const minimumFileCount = requestedFiles.length > 0 ? 1 : 0;
  const excerptCharLimit = mode === "counts"
    ? requestedExcerptCharLimit
    : largestFittingInteger(1, requestedExcerptCharLimit, (candidateLimit) =>
        serializedByteLength(buildResult(minimumFileCount, candidateLimit)) <= COMPACT_DIFF_RESULT_BUDGET_BYTES);
  const fileCount = largestFittingInteger(minimumFileCount, requestedFiles.length, (candidateCount) =>
    serializedByteLength(buildResult(candidateCount, excerptCharLimit)) <= COMPACT_DIFF_RESULT_BUDGET_BYTES);
  return buildResult(fileCount, excerptCharLimit);
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
    path: workingCopyRelativePath(
      stringValue(file.path),
      payload.cwd,
      stringValue(payload.wc_root) || payload.cwd
    ),
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
  const expandedPaths = stringArray(payload.expanded_paths);
  const verdict = stringValue(payload.verdict);
  if (!payload.ok && files.length === 0) {
    return {
      ...compactError(payload, request),
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
  const guardFailures = allGuardFailures.slice(0, 1);
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
    ...(payload.eol_check_complete === true ? { eolCheckComplete: true } : {}),
    ...(payload.eol_policy_identity ? { eolPolicyIdentity: payload.eol_policy_identity } : {}),
    ...(payload.precommit_token ? { precommitToken: payload.precommit_token } : {}),
    ...(payload.precommit_expires_at ? { precommitExpiresAt: payload.precommit_expires_at } : {}),
    ...(payload.remote_head_revision !== undefined ? { remoteHeadRevision: payload.remote_head_revision } : {}),
    ...(payload.baseline_token ? { baselineToken: payload.baseline_token } : {}),
    ...(payload.baseline_path_changes
      ? { baselinePathChanges: stringArray(payload.baseline_path_changes).slice(0, 100) }
      : {}),
    ...(payload.remote_head_changed_since_baseline === true ? { remoteHeadChangedSinceBaseline: true } : {}),
    mixedRevision,
    ...(mixedRevision && payload.revision_range ? { revisionRange: payload.revision_range } : {}),
    ...(payload.remediation ? { remediation: payload.remediation } : {}),
    ...(guardFailures.length > 0 ? { guardFailures } : {}),
    ...(guardFailures.length > 0 ? { guardCode: classifyGuardCode(guardFailures[0] ?? "") ?? "GUARD_BLOCKED" } : {}),
    ...(allGuardFailures.length > guardFailures.length
      ? { guardFailureCount: allGuardFailures.length, guardFailuresTruncated: true }
      : {}),
    ...(riskSignals.length > 0 ? { riskSignals } : {}),
    ...(payload.scope_expanded === true
      ? {
          scopeExpanded: true,
          expandedPaths: expandedPaths.slice(0, COMPACT_PREPARE_PATH_LIMIT),
          expandedPathCount: expandedPaths.length,
          ...(expandedPaths.length > COMPACT_PREPARE_PATH_LIMIT ? { expandedPathsTruncated: true } : {})
        }
      : {}),
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

function compactPrepareCommit(payload: ToolEnvelope, request: Record<string, unknown>): Record<string, unknown> {
  const verdict = stringValue(payload.verdict);
  const root = stringValue(payload.wc_root) || payload.cwd;
  const allFinalScope = stringArray(payload.final_commit_scope);
  const allUpdatedPaths = stringArray(payload.updated_paths);
  const allUnexpected = stringArray(payload.unexpected_touched_paths);
  const finalScope = allFinalScope.slice(0, COMPACT_PREPARE_PATH_LIMIT);
  const updatedPaths = allUpdatedPaths.slice(0, COMPACT_PREPARE_PATH_LIMIT);
  const unexpected = allUnexpected.slice(0, COMPACT_PREPARE_PATH_LIMIT);
  const conflicts = payload.conflicts.slice(0, COMPACT_CONFLICT_PAGE_SIZE).map((conflict) => ({
    path: workingCopyRelativePath(conflict.path, payload.cwd, root),
    type: conflict.type
  }));
  const precommit = payload.precommit && typeof payload.precommit === "object"
    ? compactPrecommit(payload.precommit as ToolEnvelope, request)
    : null;
  return {
    ok: payload.ok,
    ready: verdict === "READY",
    verdict,
    requestedRevision: payload.requested_revision,
    resultingRevision: payload.resulting_revision,
    revisionRange: payload.revision_range,
    mixedRevision: payload.mixed_revision === true,
    ...(payload.expected_remote_head !== undefined ? { expectedRemoteHead: payload.expected_remote_head } : {}),
    ...(payload.observed_remote_head !== undefined ? { observedRemoteHead: payload.observed_remote_head } : {}),
    finalCommitScope: finalScope,
    updatedPaths,
    unexpectedTouchedPaths: unexpected,
    ...(payload.operation_id ? { operationId: payload.operation_id } : {}),
    ...(payload.idempotent_replay === true ? { idempotentReplay: true } : {}),
    ...(payload.operation_recovered === true ? { operationRecovered: true } : {}),
    ...(allFinalScope.length > finalScope.length
      ? { finalCommitScopeTruncated: true, finalCommitScopeCount: allFinalScope.length }
      : {}),
    ...(allUpdatedPaths.length > updatedPaths.length
      ? { updatedPathsTruncated: true, updatedPathCount: allUpdatedPaths.length }
      : {}),
    ...(allUnexpected.length > unexpected.length
      ? { unexpectedTouchedPathsTruncated: true, unexpectedTouchedPathCount: allUnexpected.length }
      : {}),
    conflicts,
    ...(precommit ? { precommit } : {}),
    ...(!payload.ok && payload.note ? { note: payload.note } : {})
  };
}

function compactPrepareReceipt(payload: ToolEnvelope): Record<string, unknown> {
  const allScope = stringArray(payload.final_commit_scope);
  const allUnexpected = stringArray(payload.unexpected_touched_paths);
  const scope = allScope.slice(0, COMPACT_PREPARE_PATH_LIMIT);
  const unexpected = allUnexpected.slice(0, COMPACT_PREPARE_PATH_LIMIT);
  return {
    ok: payload.ok,
    verdict: payload.verdict,
    requestedRevision: payload.requested_revision,
    resultingRevision: payload.resulting_revision,
    ...(payload.observed_remote_head !== undefined ? { remoteHeadRevision: payload.observed_remote_head } : {}),
    conflictCount: payload.conflicts.length,
    ...(payload.operation_id ? { operationId: payload.operation_id } : {}),
    ...(payload.idempotent_replay === true ? { idempotentReplay: true } : {}),
    ...(payload.operation_recovered === true ? { operationRecovered: true } : {}),
    finalCommitScope: scope,
    ...(allScope.length > scope.length ? { finalCommitScopeTruncated: true, pathCount: allScope.length } : {}),
    ...(unexpected.length > 0 ? { unexpectedTouchedPaths: unexpected } : {}),
    ...(allUnexpected.length > unexpected.length
      ? { unexpectedTouchedPathsTruncated: true, unexpectedTouchedPathCount: allUnexpected.length }
      : {}),
    ...(!payload.ok && payload.note ? { note: payload.note } : {})
  };
}

function compactSafeCommit(payload: ToolEnvelope): Record<string, unknown> {
  if (payload.operation === "safe_commit_detail") {
    return {
      ok: payload.ok,
      operation: "safe_commit_detail",
      detailOperationId: payload.detail_operation_id,
      detail: payload.detail,
      truncated: payload.truncated === true,
      ...(payload.next_cursor ? { nextCursor: payload.next_cursor } : {}),
      ...(!payload.ok && payload.note ? { note: payload.note } : {})
    };
  }
  return {
    ok: payload.ok,
    operation: "safe_commit",
    verdict: payload.verdict,
    ...(payload.operation_id ? { operationId: payload.operation_id } : {}),
    ...(payload.idempotent_replay === true ? { idempotentReplay: true } : {}),
    ...(payload.operation_recovered === true ? { operationRecovered: true } : {}),
    ...(payload.committed_revision !== undefined ? { committedRevision: payload.committed_revision } : {}),
    ...(payload.committed_paths !== undefined
      ? {
          committedPaths: stringArray(payload.committed_paths).slice(0, 100),
          committedCount: payload.committed_count ?? stringArray(payload.committed_paths).length
        }
      : {}),
    ...(payload.remote_head_revision !== undefined ? { remoteHeadRevision: payload.remote_head_revision } : {}),
    ...(payload.final_scope_clean !== undefined ? { finalScopeClean: payload.final_scope_clean } : {}),
    ...(payload.scope_uniform !== undefined ? { scopeUniform: payload.scope_uniform } : {}),
    ...(payload.baseline_captured_automatically === true ? { baselineCapturedAutomatically: true } : {}),
    ...(payload.final_revision_range !== undefined ? { finalRevisionRange: payload.final_revision_range } : {}),
    ...(payload.detail_operation_id ? { detailOperationId: payload.detail_operation_id } : {}),
    ...(payload.detail_expires_at ? { detailExpiresAt: payload.detail_expires_at } : {}),
    ...(payload.detail_cursor ? { detailCursor: payload.detail_cursor } : {}),
    ...(!payload.ok && payload.note ? { note: payload.note } : {})
  };
}

function compactMutation(tool: string, payload: ToolEnvelope, request: Record<string, unknown>): Record<string, unknown> {
  if (tool === "svn_revert" && request.dryRun !== false) {
    return {
      ok: true,
      action: "revert",
      dryRun: true,
      counts: countByStatus(payload.changed_paths.map((item) => ({ status: normalizeStatus(item.status) })))
    };
  }
  if (tool === "svn_delete" && request.dryRun !== false) {
    return {
      ok: true,
      action: "delete",
      dryRun: true,
      pathCount: stringArray(request.paths).length
    };
  }

  const result = tool === "svn_path_change"
    ? request.action === "copy" ? "copied" : "renamed"
    : MUTATION_STATUS[tool];
  const receiptRoot = typeof payload.wc_root === "string" ? payload.wc_root : payload.cwd;
  const verified = (tool === "svn_move" || tool === "svn_rename" || tool === "svn_copy" || tool === "svn_path_change")
    ? payload.changed_paths.length > 0
    : tool === "svn_delete"
      ? payload.post_status_verified === true
    : tool === "svn_commit"
      ? payload.revision !== null
      : tool === "eol_fix_verified"
        ? payload.after !== undefined
        : false;
  const source = receiptPathValue(request.src, payload.cwd, receiptRoot);
  const target = request.url !== undefined
    ? receiptValue(request.url)
    : receiptPathValue(request.dest, payload.cwd, receiptRoot);
  const targetPath = receiptPathValue(request.path, payload.cwd, receiptRoot);
  const receipt: Record<string, unknown> = {
    ok: true,
    action: tool === "svn_path_change" ? request.action : tool.replace(/^svn_/, ""),
    ...(payload.operation_id ? { operationId: payload.operation_id } : {}),
    ...(payload.idempotent_replay === true ? { idempotentReplay: true } : {}),
    ...(payload.operation_recovered === true ? { operationRecovered: true } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(targetPath !== undefined ? { path: targetPath } : {}),
    ...(tool !== "svn_update" && payload.revision !== null ? { revision: payload.revision } : {}),
    ...(verified ? { verifiedStatus: result } : { status: result })
  };

  if (payload.conflicts.length > 0) {
    if (tool === "svn_update") {
      Object.assign(receipt, compactConflictPage(payload, request, payload.cwd, receiptRoot));
    } else {
      const conflicts = payload.conflicts.slice(0, COMPACT_CONFLICT_PAGE_SIZE).map((conflict) => ({
        path: workingCopyRelativePath(conflict.path, payload.cwd, receiptRoot),
        type: conflict.type
      }));
      receipt.conflicts = conflicts;
      if (payload.conflicts.length > conflicts.length) {
        receipt.conflictCount = payload.conflicts.length;
        receipt.conflictsTruncated = true;
      }
    }
  }
  if (payload.post_status_clean !== undefined) {
    receipt.postStatusClean = payload.post_status_clean;
  }
  if (tool === "svn_add" && payload.eol_normalization && typeof payload.eol_normalization === "object") {
    receipt.eolNormalization = payload.eol_normalization;
  }
  if (tool === "svn_commit") {
    const committedPaths = stringArray(payload.committed_paths);
    const expandedPaths = stringArray(payload.expanded_paths);
    const hasPostStatus = Array.isArray(payload.post_status);
    const postStatus = hasPostStatus ? changedPathArray(payload.post_status) : payload.changed_paths;
    if (payload.committed_revision !== undefined) {
      receipt.committedRevision = payload.committed_revision;
    }
    if (payload.committed_paths !== undefined) {
      receipt.committedPaths = committedPaths.slice(0, 100);
      receipt.committedCount = payload.committed_count ?? committedPaths.length;
      receipt.pathCount = payload.path_count ?? committedPaths.length;
    }
    assignDefined(receipt, "baseRevision", payload.base_revision);
    assignDefined(receipt, "baseRevisionRange", payload.base_revision_range);
    assignDefined(receipt, "remoteHeadRevision", payload.remote_head_revision);
    assignDefined(receipt, "eolVerdict", payload.eol_verdict);
    assignDefined(receipt, "workingCopyMixed", payload.working_copy_mixed);
    assignDefined(receipt, "precommitToken", payload.precommit_token);
    if (payload.content_hashes !== undefined) {
      receipt.contentHashes = recordArray(payload.content_hashes).slice(0, 100);
    }
    if (committedPaths.length > 100) {
      receipt.committedPathsTruncated = true;
    }
    if (payload.scope_expanded === true) {
      receipt.scopeExpanded = true;
      receipt.expandedPaths = expandedPaths.slice(0, COMPACT_PREPARE_PATH_LIMIT);
      receipt.expandedPathCount = expandedPaths.length;
      if (expandedPaths.length > COMPACT_PREPARE_PATH_LIMIT) {
        receipt.expandedPathsTruncated = true;
      }
    }
    if (payload.post_status_clean === false && postStatus.length > 0) {
      receipt.residue = postStatus.slice(0, 100).map((item) => compactStatusItem(item, payload.cwd, receiptRoot));
    }
  }
  if (tool === "svn_update" && payload.changed_paths.length > 0) {
    const allChangedPaths = payload.changed_paths.map((item) => compactStatusItem(item, payload.cwd, receiptRoot));
    const taskPaths = uniqueStrings(stringArray(request.taskPaths)
      .map((item) => receiptPathValue(item, payload.cwd, receiptRoot))
      .filter((item): item is string => item !== undefined));
    const taskPathChanges = taskPaths.length > 0
      ? allChangedPaths.filter((item) => taskPaths.some((taskPath) => pathsOverlap(item.path, taskPath)))
      : [];
    const selectedChanges = request.targetOverlapOnly === true ? taskPathChanges : allChangedPaths;
    const offset = cursorOffset(request.cursor);
    const maxItems = boundedInteger(request.maxItems, 100, 1, 500);
    const page = selectedChanges.slice(offset, offset + maxItems);
    const nextOffset = offset + page.length;
    const changedPathsTruncated = nextOffset < selectedChanges.length;
    receipt.counts = countByStatus(payload.changed_paths.map((item) => ({ status: normalizeStatus(item.status) })));
    receipt.changedPaths = page;
    const includePageContext = offset > 0 || changedPathsTruncated || request.targetOverlapOnly === true;
    if (includePageContext) {
      receipt.changedCount = allChangedPaths.length;
      receipt.changedPathCount = allChangedPaths.length;
      if (offset > 0) {
        receipt.pageOffset = offset;
      }
      if (offset >= selectedChanges.length && selectedChanges.length > 0) {
        receipt.cursorPastEnd = true;
      }
      const topFolders = summarizeTopFolders(allChangedPaths.map((item) => item.path));
      receipt.changedByTopFolder = topFolders.slice(0, COMPACT_TOP_FOLDER_LIMIT);
      if (topFolders.length > COMPACT_TOP_FOLDER_LIMIT) {
        receipt.changedByTopFolderTruncated = true;
        receipt.changedTopFolderCount = topFolders.length;
      }
    }
    if (taskPathChanges.length > 0) {
      receipt.taskPathChanges = taskPathChanges.slice(0, maxItems);
      if (taskPathChanges.length > maxItems) {
        receipt.taskPathChangesTruncated = true;
      }
    }
    if (request.targetOverlapOnly === true) {
      receipt.unrelatedChangedCount = allChangedPaths.length - taskPathChanges.length;
    }
    if (changedPathsTruncated) {
      receipt.changedPathsTruncated = true;
      receipt.nextCursor = String(nextOffset);
    }
  }
  if (tool === "svn_update") {
    receipt.requestedRevision = payload.requested_revision;
    receipt.resultingRevision = payload.resulting_revision;
    receipt.revisionRange = payload.revision_range;
    receipt.mixedRevision = payload.mixed_revision === true;
    if (payload.expected_remote_head !== undefined) {
      receipt.expectedRemoteHead = payload.expected_remote_head;
      receipt.observedRemoteHead = payload.observed_remote_head;
    }
    if (payload.baseline_token) {
      receipt.baselineToken = payload.baseline_token;
      receipt.collision = payload.collision === true;
      const collisionPaths = stringArray(payload.collision_paths);
      if (collisionPaths.length > 0) receipt.collisionPaths = collisionPaths.slice(0, 100);
      const pathStates = recordArray(payload.path_states).slice(0, 100);
      if (pathStates.length > 0) receipt.pathStates = pathStates;
      if (payload.recommended_action) receipt.recommendedAction = payload.recommended_action;
    }
  }
  return receipt;
}

function compactEolFix(payload: ToolEnvelope, request: Record<string, unknown>): Record<string, unknown> {
  if (payload.batch === true) {
    const files = recordArray(payload.files);
    const root = stringValue(payload.wc_root) || payload.cwd;
    const failures = files.filter((file) => file.ok !== true).slice(0, 100).map((file) => ({
      path: typeof file.path === "string"
        ? workingCopyRelativePath(file.path, payload.cwd, root)
        : file.path,
      before: file.before,
      after: file.after,
      failure: file.failure
    }));
    return {
      ok: payload.ok,
      action: "eol_fix_verified",
      ...(payload.operation_id ? { operationId: payload.operation_id } : {}),
      ...(payload.idempotent_replay === true ? { idempotentReplay: true } : {}),
      counts: payload.counts,
      ...(failures.length > 0 ? { failures } : {}),
      ...(files.length > failures.length && failures.length >= 100 ? { failuresTruncated: true } : {}),
      ...(!payload.ok ? { note: payload.note } : {})
    };
  }
  const before = compactEolState(payload.before);
  const after = compactEolState(payload.after);
  if (!payload.ok) {
    return {
      ...compactError(payload, request),
      action: "eol_fix_verified",
      ...(request.path
        ? { path: receiptPathValue(request.path, payload.cwd, stringValue(payload.wc_root) || payload.cwd) }
        : {}),
      ...(before ? { before } : {})
    };
  }

  const dryRun = request.dryRun === true;
  return {
    ok: true,
    action: "eol_fix_verified",
    ...(payload.operation_id ? { operationId: payload.operation_id } : {}),
    ...(payload.idempotent_replay === true ? { idempotentReplay: true } : {}),
    ...(request.path
      ? { path: receiptPathValue(request.path, payload.cwd, stringValue(payload.wc_root) || payload.cwd) }
      : {}),
    target: payload.target,
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    pureEolChurn: payload.pure_eol_churn === true,
    ...(dryRun ? { dryRun: true } : { verified: after !== null })
  };
}

function compactStatus(payload: ToolEnvelope, request: Record<string, unknown>): Record<string, unknown> {
  const cwd = payload.cwd;
  const root = typeof payload.wc_root === "string" ? payload.wc_root : cwd;
  const changed = canonicalStatusItems(payload, request, cwd, root);
  const counts = countByStatus(changed);
  const offset = cursorOffset(request.cursor);
  const countOnly = request.countOnly === true;
  const maxItems = countOnly ? 0 : boundedInteger(request.maxItems, 100, 1, 500);
  const items = maxItems === 0 ? [] : changed.slice(offset, offset + maxItems);
  const nextOffset = offset + items.length;
  const truncated = !countOnly && nextOffset < changed.length;
  const conflictPage = compactConflictPage(payload, request, cwd, root);

  const result = {
    ok: true,
    counts,
    items,
    ...conflictPage,
    ...(payload.note ? { note: payload.note } : {}),
    truncated,
    ...(truncated ? { nextCursor: String(nextOffset) } : {})
  };
  if (request.suppressSnapshotToken === true) {
    return result;
  }
  return withSnapshotToken("svn_status", payload, request, result, {
    revision: payload.revision,
    revisionRange: payload.revision_range,
    mixedRevision: payload.mixed_revision,
    remoteHeadRevision: payload.remote_head_revision,
    changed,
    conflicts: payload.conflicts
  });
}

function canonicalStatusItems(
  payload: ToolEnvelope,
  request: Record<string, unknown>,
  cwd: string,
  root: string
): Array<{ path: string; status: string }> {
  const includeUnversioned = request.includeUnversioned !== false;
  const requestedStatuses = stringArray(request.statuses);
  const allowedStatuses = requestedStatuses.length > 0
    ? new Set(requestedStatuses.map((value) => normalizeStatus(value)))
    : null;
  return payload.changed_paths
    .map((item) => compactStatusItem(item, cwd, root))
    .filter((item) => includeUnversioned || item.status !== "unversioned")
    .filter((item) => !allowedStatuses || allowedStatuses.has(item.status));
}

function withSnapshotToken(
  tool: "svn_status" | "svn_snapshot",
  payload: ToolEnvelope,
  request: Record<string, unknown>,
  result: Record<string, unknown>,
  state: unknown
): Record<string, unknown> {
  const root = stringValue(payload.wc_root) || payload.cwd;
  const options = {
    tool,
    paths: stringArray(request.paths).map((item) => receiptPathValue(item, payload.cwd, root)),
    includeIgnored: request.includeIgnored === true,
    hideNoise: request.hideNoise === true,
    includeUnversioned: request.includeUnversioned !== false,
    statuses: stringArray(request.statuses).map(normalizeStatus).sort()
  };
  const afterCursor = stringValue(request.afterCursor);
  if (afterCursor) {
    const verification = processSnapshotTokens.verify(afterCursor, root, options, state);
    if (!verification.ok) {
      return { ok: false, code: verification.code, note: verification.note };
    }
    if (verification.unchanged) {
      return {
        ok: true,
        verdict: "NO_CHANGE",
        unchangedSinceCursor: true,
        conflictCount: payload.conflicts.length,
        snapshotToken: processSnapshotTokens.issue(root, options, state)
      };
    }
  }
  return {
    ...result,
    ...(afterCursor ? { changedSinceCursor: true } : {}),
    snapshotToken: processSnapshotTokens.issue(root, options, state)
  };
}

function compactStatusItem(item: ChangedPath, cwd: string, wcRoot = cwd): {
  path: string;
  status: string;
  coveredByIgnoredAncestor?: true;
  ignoredAncestor?: string;
} {
  return {
    path: workingCopyRelativePath(item.path, cwd, wcRoot),
    status: normalizeStatus(item.status),
    ...(item.covered_by_ignored_ancestor === true ? { coveredByIgnoredAncestor: true } : {}),
    ...(item.ignored_ancestor ? { ignoredAncestor: item.ignored_ancestor } : {})
  };
}

function compactConflictPage(
  payload: ToolEnvelope,
  request: Record<string, unknown>,
  cwd: string,
  wcRoot: string
): Record<string, unknown> {
  if (payload.conflicts.length === 0) {
    return {};
  }
  const offset = cursorOffset(request.conflictCursor);
  const conflicts = payload.conflicts.slice(offset, offset + COMPACT_CONFLICT_PAGE_SIZE).map((conflict) => ({
    path: workingCopyRelativePath(conflict.path, cwd, wcRoot),
    type: conflict.type
  }));
  const nextOffset = offset + conflicts.length;
  const truncated = nextOffset < payload.conflicts.length;
  return {
    conflicts,
    conflictCount: payload.conflicts.length,
    ...(truncated ? { conflictsTruncated: true, nextConflictCursor: String(nextOffset) } : {})
  };
}

function workingCopyRelativePath(value: string, cwd: string, wcRoot: string): string {
  const pathApi = pathImplementationFor(cwd, wcRoot);
  const absolute = pathApi.isAbsolute(value) ? value : pathApi.resolve(cwd, value);
  return relativePath(wcRoot, absolute);
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

function assignDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function changedPathArray(value: unknown): ChangedPath[] {
  return Array.isArray(value)
    ? value.filter((item): item is ChangedPath => Boolean(item)
        && typeof item === "object"
        && typeof (item as Record<string, unknown>).path === "string"
        && typeof (item as Record<string, unknown>).status === "string")
    : [];
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
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

function serializedByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function largestFittingInteger(minimum: number, maximum: number, fits: (candidate: number) => boolean): number {
  let low = minimum;
  let high = maximum;
  let best = Math.max(0, minimum - 1);
  while (low <= high) {
    const candidate = Math.floor((low + high) / 2);
    if (fits(candidate)) {
      best = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }
  return best;
}

function boundedPreview(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  let end = maxChars;
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1] ?? "")) end -= 1;
  return { text: `${value.slice(0, end)}...`, truncated: true };
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
  if (!candidate) {
    return candidate;
  }
  const pathApi = pathImplementationFor(root, candidate);
  const relative = pathApi.isAbsolute(root) && pathApi.isAbsolute(candidate)
    ? pathApi.relative(root, candidate)
    : candidate;
  return (relative || ".").replace(/\\/g, "/");
}

function pathImplementationFor(...values: string[]): typeof path.win32 {
  const hasWindowsAbsolutePath = values.some(
    (value) => path.win32.isAbsolute(value) && !path.posix.isAbsolute(value)
  );
  return hasWindowsAbsolutePath ? path.win32 : path.posix;
}

function firstLine(value: string): string {
  return (value.split(/\r?\n/, 1)[0] ?? "").slice(0, 240);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function receiptValue(value: unknown): string | undefined {
  return typeof value === "string" ? redactText(value).slice(0, 4096) : undefined;
}

function receiptPathValue(value: unknown, cwd: string, wcRoot: string): string | undefined {
  return typeof value === "string"
    ? redactText(workingCopyPathIfInside(value, cwd, wcRoot)).slice(0, 4096)
    : undefined;
}

function pathsOverlap(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "").toLowerCase();
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function summarizeTopFolders(paths: string[]): Array<{ path: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of paths) {
    const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
    const top = normalized.includes("/") ? normalized.split("/", 1)[0] ?? "." : ".";
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([path, count]) => ({ path, count }));
}

function sanitizeNonFullStructuredValue(value: unknown, cwd: string, wcRoot: string): unknown {
  if (typeof value === "string") {
    return sanitizeNonFullText(value, cwd, wcRoot);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeNonFullStructuredValue(item, cwd, wcRoot));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    sanitizeNonFullStructuredValue(item, cwd, wcRoot)
  ]));
}

function sanitizeNonFullText(value: string, cwd: string, wcRoot: string): string {
  let sanitized = value;
  const roots = uniqueStrings([wcRoot, cwd].filter(Boolean)).sort((left, right) => right.length - left.length);
  for (const root of roots) {
    const pattern = root
      .split(/[\\/]/)
      .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[\\\\/]");
    sanitized = sanitized.replace(new RegExp(pattern, "gi"), ".");
  }
  return sanitized;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function lineCount(value: string): number {
  return value ? value.split("\n").length : 0;
}
