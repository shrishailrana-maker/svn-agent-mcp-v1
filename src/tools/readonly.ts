import fs from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { createEnvelope, envelopeFromRun, failEnvelope, noteFromRun, redactText } from "../envelope.js";
import { makeEolCheck } from "../eol.js";
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
import { createDiffAccumulator } from "../parse/diffText.js";
import { parseInfoXml } from "../parse/infoXml.js";
import { parseLogXml } from "../parse/logXml.js";
import { parseStatusXml } from "../parse/statusXml.js";
import { runSvn, runSvnStreamingLines, runSvnVersion } from "../runner.js";
import type { DiffSummary, EolCheckResult, Envelope, ToolEnvelope, WcInfo } from "../types.js";

export interface ToolInputWithCwd {
  cwd?: string;
}

const propgetParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "text"
});

export async function getWcContext(cwdInput?: string, pathHints: string[] = []): Promise<{ ok: true; cwd: string; info: WcInfo; wcRoot: string } | { ok: false; envelope: Envelope }> {
  if (!cwdInput && !pathHints.some((hint) => path.isAbsolute(hint))) {
    return {
      ok: false,
      envelope: failEnvelope("svn info --xml", process.cwd(), "cwd or absolute path required")
    };
  }

  let lastRun: Awaited<ReturnType<typeof runSvn>> | null = null;

  for (const probe of wcProbeCandidates(cwdInput, pathHints)) {
    const run = await runSvn(["info", "--xml", "--", probe.target], probe.execCwd);
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

export async function svnStatus(input: { cwd?: string; paths?: string[]; includeIgnored?: boolean; hideNoise?: boolean }): Promise<ToolEnvelope> {
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
    ...(targets.length > 0 ? ["--", ...resolved.paths] : [])
  ];
  const run = await runSvn(args, context.cwd);
  const parsed = run.exitCode === 0 ? parseStatusXml(run.stdout) : { changed_paths: [], conflicts: [] };
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
      note: run.exitCode === 0 ? "" : noteFromRun(run)
    }),
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

  const run = await runSvn(["info", "--xml", "--", ...resolved.paths], context.cwd);
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
  const remoteHeadRevision = await remoteHeadForTargets(context.cwd, resolved.paths);
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
    stale_base: remoteHeadRevision !== null && revisionRange !== null ? remoteHeadRevision > revisionRange.max : false
  };
}

export async function svnDiff(input: {
  cwd?: string;
  paths: string[];
  ignoreEol?: boolean;
  lineLimit?: number;
  cursor?: string;
}): Promise<ToolEnvelope & DiffSummary> {
  const explicitError = requireExplicitPaths(input.paths);
  const cwd = resolveCwd(input.cwd);
  if (explicitError) {
    return {
      ...failEnvelope("svn diff", cwd, explicitError),
      per_file: [],
      per_file_truncated: false,
      diff_excerpt: "",
      truncated: false
    };
  }

  const context = await getWcContext(input.cwd, input.paths);
  if (!context.ok) {
    return {
      ...context.envelope,
      per_file: [],
      per_file_truncated: false,
      diff_excerpt: "",
      truncated: context.envelope.truncated
    };
  }

  const resolved = resolveTargetsInsideWc(context.cwd, context.wcRoot, input.paths);
  if (!resolved.ok) {
    return {
      ...failEnvelope("svn diff", context.cwd, resolved.note),
      per_file: [],
      per_file_truncated: false,
      diff_excerpt: "",
      truncated: false
    };
  }

  const lineLimit = input.lineLimit ?? defaultDiffLineLimit();
  const lineOffset = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
  const ignoreEol = input.ignoreEol ?? true;
  const args = ignoreEol
    ? ["diff", "--internal-diff", "-x", "--ignore-eol-style", "--", ...resolved.paths]
    : ["diff", "--internal-diff", "--", ...resolved.paths];
  const diffAccumulator = createDiffAccumulator(lineLimit, lineOffset);
  const run = await runSvnStreamingLines(args, context.cwd, diffAccumulator.pushLine, { stdoutLineLimit: lineLimit });
  const rawDiff = run.exitCode === 0
    ? diffAccumulator.summary()
    : { per_file: [], per_file_truncated: false, diff_excerpt: "", truncated: false };
  const diff = {
    ...rawDiff,
    diff_excerpt: redactText(rawDiff.diff_excerpt),
    truncated: rawDiff.truncated || Boolean(run.truncated)
  };
  const eolDiagnostic = run.exitCode !== 0 && isInconsistentEolRun(run)
    ? await eolCheck({ cwd: context.cwd, paths: resolved.paths })
    : null;
  return {
    ...envelopeFromRun({
      run,
      ok: run.exitCode === 0,
      note: run.exitCode === 0 ? "" : noteFromRun(run),
      truncated: diff.truncated
    }),
    ...diff,
    page_offset: lineOffset,
    ...(diff.truncated ? { next_cursor: String(lineOffset + lineLimit) } : {}),
    ignore_eol: ignoreEol,
    ...(eolDiagnostic
      ? {
          recovery_tool: "eol_fix_verified",
          eol_files: eolDiagnostic.files ?? []
        }
      : {})
  };
}

export async function svnLog(input: {
  cwd?: string;
  paths?: string[];
  limit?: number;
  verbose?: boolean;
  changedPaths?: boolean;
  cursor?: string;
}): Promise<ToolEnvelope> {
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
  const args = ["log", "--xml", "-l", String(limit + 1)];
  if (input.changedPaths ?? input.verbose ?? false) {
    args.push("-v");
  }
  if (input.cursor) {
    args.push("-r", `${input.cursor}:0`);
  }
  args.push("--", ...logTargets.targets);

  const run = await runSvn(args, context.cwd);
  const parsedEntries = run.exitCode === 0 ? parseLogXml(run.stdout) : [];
  const entries = parsedEntries.slice(0, limit);
  return {
    ...envelopeFromRun({
      run,
      ok: run.exitCode === 0,
      revision: entries[0]?.rev ?? null,
      note: run.exitCode === 0 ? logTargets.note : noteFromRun(run)
    }),
    entries,
    has_more: parsedEntries.length > entries.length,
    target_mode: logTargets.mode
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
  const eolStyles = await eolStylesForTargets(context.cwd, resolved.paths);
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

  const run = await runSvn(["propget", "--xml", "--", input.name, ...resolved.paths], context.cwd);
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

export function normalizeStatusLookup(statuses: Map<string, string>, target: string): string | undefined {
  return statuses.get(pathIdentityKey(target));
}

function filterNoisePaths(changedPaths: Array<{ status: string; path: string }>, cwd: string, wcRoot: string): {
  changed_paths: Array<{ status: string; path: string }>;
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

function parseSvnVersion(value: string): {
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

async function remoteHeadForTargets(cwd: string, targets: string[]): Promise<number | null> {
  let head: number | null = null;
  const run = await runSvn(["info", "--xml", "-r", "HEAD", "--", ...targets], cwd);
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

async function eolStylesForTargets(cwd: string, targets: string[]): Promise<Map<string, string>> {
  const batched = await runSvn(["propget", "--xml", "--", "svn:eol-style", ...targets], cwd);
  if (batched.exitCode === 0) {
    return parsePropgetEolStyles(batched.stdout, cwd);
  }

  const styles = new Map<string, string>();
  for (const target of targets) {
    const prop = await runSvn(["propget", "--", "svn:eol-style", target], cwd);
    if (prop.exitCode === 0 && prop.stdout.trim()) {
      styles.set(pathIdentityKey(target), prop.stdout.trim());
    }
  }
  return styles;
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
  const info = await runSvn(["info", "--xml", "--", ...paths], cwd);
  if (info.exitCode !== 0) {
    return { targets: paths, mode: "working-copy-path", note: "" };
  }

  const entries = parseInfoXml(info.stdout);
  const urls = entries.map((entry) => entry.url).filter((url): url is string => Boolean(url));
  if (urls.length !== paths.length) {
    return { targets: paths, mode: "working-copy-path", note: "" };
  }

  return {
    targets: urls,
    mode: "repository-url",
    note: "queried repository URL at HEAD to avoid working-copy peg revision log gaps"
  };
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
