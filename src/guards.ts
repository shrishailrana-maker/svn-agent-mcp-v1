import fs from "node:fs";
import path from "node:path";
import type { ChangedPath, WcInfo } from "./types.js";

const overridableNeverCommitGlobs = [
  "**/bin/**",
  "**/dist/**",
  "**/node_modules/**",
  "**/coverage/**",
  "**/obj/**",
  "**/.vs/**",
  "**/.cache/**",
  "**/*.db",
  "**/*.tsbuildinfo",
  "scratch/**",
  "packages/**",
  "tags/**",
  ".graphify/**",
  "graphify-out/**"
];

export const sensitiveNeverCommitGlobs = [
  "**/*.pfx",
  "**/*.key",
  "**/*.pem",
  "**/*.p12",
  "**/*.snk",
  "**/.env*",
  "**/.npmrc"
];

export const neverCommitGlobs = [...overridableNeverCommitGlobs, ...sensitiveNeverCommitGlobs];

type NeverCommitPolicy = {
  neverCommit?: {
    allow?: string[];
    deny?: string[];
  };
};

type LoadedNeverCommitPolicy = {
  allow: string[];
  deny: string[];
  invalid?: string;
  exists: boolean;
  mtimeMs: number;
  size: number;
};

const MAX_POLICY_GLOBS = 128;
const MAX_POLICY_GLOB_LENGTH = 256;
const MAX_POLICY_DOUBLESTAR_SEGMENTS = 4;
const MAX_POLICY_GLOB_WILDCARDS = 8;
const policyCache = new Map<string, LoadedNeverCommitPolicy>();

const buildSystemNames = new Set([
  "directory.build.props",
  "directory.build.targets",
  "packages.config"
]);

export function readonlyMode(): boolean {
  return process.env.SVN_AGENT_READONLY === "1" || process.argv.includes("--readonly");
}

export function resolveCwd(cwd?: string): string {
  return realPathOfNearestExisting(cwd ?? process.cwd());
}

export function requireExplicitPaths(paths: string[] | undefined): string | null {
  if (!paths || paths.length === 0) {
    return "explicit paths required";
  }
  return null;
}

export function validatePropertyName(name: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(name)) {
    return "invalid property name";
  }
  return null;
}

export function resolveTargetsInsideWc(cwd: string, wcRoot: string, paths: string[]): { ok: true; paths: string[] } | { ok: false; note: string } {
  const resolved = paths.map((target) => path.resolve(cwd, target));
  const realRoot = realPathOfNearestExisting(wcRoot);
  const canonical = resolved.map((target) => realPathOfNearestExisting(target));
  for (const [index, target] of resolved.entries()) {
    const realTarget = canonical[index];
    if (!realTarget) {
      return { ok: false, note: `path outside working copy: ${target}` };
    }
    if (!isInsideOrEqual(target, wcRoot) && !isInsideOrEqual(realTarget, realRoot)) {
      return { ok: false, note: `path outside working copy: ${target}` };
    }
    // A short-name, case-shifted, junction, or symlink path can lexically pass
    // or fail differently from SVN's canonical spelling; use the physical path
    // both for containment and for the command arguments returned to callers.
    if (!isInsideOrEqual(realTarget, realRoot)) {
      return { ok: false, note: `path resolves outside working copy: ${target}` };
    }
  }
  return { ok: true, paths: canonical };
}

export function realPathOfNearestExisting(target: string): string {
  let current = path.resolve(target);
  const suffix: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(target);
    }
    suffix.unshift(path.basename(current));
    current = parent;
  }
  try {
    return path.join(fs.realpathSync.native(current), ...suffix);
  } catch {
    return path.resolve(target);
  }
}

export function assertExistingTargets(paths: string[]): string | null {
  for (const target of paths) {
    if (!fs.existsSync(target)) {
      return `path does not exist: ${target}`;
    }
  }
  return null;
}

export function isInsideOrEqual(candidate: string, root: string): boolean {
  const normalizedRoot = pathIdentityKey(root);
  const normalizedCandidate = pathIdentityKey(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot + path.sep);
}

export function pathIdentityKey(value: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = path.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function repoRelativePath(absPath: string, wcRoot: string): string {
  const relative = path.relative(wcRoot, absPath);
  return relative ? slash(relative) : ".";
}

export function slash(value: string): string {
  return value.replace(/\\/g, "/");
}

export function neverCommitHit(absPath: string, wcRoot: string): string | null {
  const relative = repoRelativePath(absPath, wcRoot).toLowerCase();
  const policy = loadNeverCommitPolicy(wcRoot);
  if (policy.invalid) {
    return policy.invalid;
  }

  for (const glob of policy.deny) {
    if (matchesGlob(relative, glob)) {
      return glob;
    }
  }

  for (const glob of sensitiveNeverCommitGlobs) {
    if (matchesGlob(relative, glob)) {
      return glob;
    }
  }

  for (const glob of policy.allow) {
    if (matchesGlob(relative, glob)) {
      return null;
    }
  }

  for (const glob of overridableNeverCommitGlobs) {
    if (matchesGlob(relative, glob)) {
      return glob;
    }
  }
  return null;
}

export function neverCommitNote(hit: string, absPath: string, wcRoot: string): string {
  return hit.startsWith("policy-error:")
    ? hit
    : `never-commit path matches ${hit}: ${repoRelativePath(absPath, wcRoot)}`;
}

export function riskySignals(absPaths: string[], wcRoot: string, statusByPath?: Map<string, string>): string[] {
  const signals = new Set<string>();

  if (absPaths.length > 8) {
    signals.add("more than 8 paths");
  }

  for (const absPath of absPaths) {
    const relative = repoRelativePath(absPath, wcRoot).toLowerCase();
    const basename = path.basename(relative).toLowerCase();
    const status = statusByPath?.get(pathIdentityKey(absPath));

    if (status === "D") {
      signals.add("delete-scheduled path");
    }
    if (basename === "version.ver") {
      signals.add("version file touched");
    }
    if (isBuildSystemFile(relative)) {
      signals.add("build-system file touched");
    }
  }

  return [...signals];
}

export function isBuildSystemFile(relativePath: string): boolean {
  const lower = slash(relativePath).toLowerCase();
  const basename = path.posix.basename(lower);
  return (
    buildSystemNames.has(basename) ||
    lower.endsWith(".sln") ||
    lower.endsWith(".csproj") ||
    lower.endsWith(".props") ||
    lower.endsWith(".targets")
  );
}

export function statusMap(changedPaths: ChangedPath[], cwd: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const changedPath of changedPaths) {
    map.set(pathIdentityKey(path.resolve(cwd, changedPath.path)), changedPath.status);
  }
  return map;
}

export function wcRootFromInfo(info: WcInfo[]): string | null {
  return info.find((entry) => entry.wc_root)?.wc_root ?? null;
}

export function messageFormatWarning(message: string): string | null {
  const normalized = message.replace(/\r\n/g, "\n").trimEnd();
  const lines = normalized.split("\n");
  const hasSummary = Boolean(lines[0]?.trim());
  const hasBlankSecondLine = lines.length > 1 && lines[1] === "";
  const hasBullet = lines.some((line, index) => index >= 2 && line.startsWith("- "));
  return hasSummary && hasBlankSecondLine && hasBullet ? null : "commit message format warning";
}

function matchesGlob(relative: string, glob: string): boolean {
  const lowerRelative = slash(relative).toLowerCase();
  const lowerGlob = slash(glob).toLowerCase();
  if (lowerGlob.endsWith("/**")) {
    const directory = lowerGlob.slice(0, -3);
    return globToRegExp(directory).test(lowerRelative) || globToRegExp(lowerGlob).test(lowerRelative);
  }
  return globToRegExp(lowerGlob).test(lowerRelative);
}

function loadNeverCommitPolicy(wcRoot: string): LoadedNeverCommitPolicy {
  const policyPath = path.join(wcRoot, ".svn-mcp-policy.json");
  const cacheKey = pathIdentityKey(wcRoot);
  const stat = safePolicyStat(policyPath);
  const cached = policyCache.get(cacheKey);
  if (cached && cached.exists === stat.exists && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached;
  }

  if (!stat.exists) {
    const empty = { allow: [], deny: [], exists: false, mtimeMs: 0, size: 0 };
    policyCache.set(cacheKey, empty);
    return empty;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(policyPath, "utf8")) as NeverCommitPolicy;
    const allow = stringArray(parsed.neverCommit?.allow);
    const deny = stringArray(parsed.neverCommit?.deny);
    const invalid = validatePolicyGlobs([...allow, ...deny]);
    const loaded = {
      allow,
      deny,
      ...(invalid ? { invalid } : {}),
      exists: true,
      mtimeMs: stat.mtimeMs,
      size: stat.size
    };
    policyCache.set(cacheKey, loaded);
    return loaded;
  } catch {
    const invalid = {
      allow: [],
      deny: [],
      invalid: "policy-error: invalid .svn-mcp-policy.json",
      exists: true,
      mtimeMs: stat.mtimeMs,
      size: stat.size
    };
    policyCache.set(cacheKey, invalid);
    return invalid;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim()) : [];
}

function validatePolicyGlobs(globs: string[]): string | undefined {
  if (globs.length > MAX_POLICY_GLOBS) {
    return `policy-error: .svn-mcp-policy.json has too many neverCommit globs (max ${MAX_POLICY_GLOBS})`;
  }

  for (const glob of globs) {
    if (glob.length > MAX_POLICY_GLOB_LENGTH) {
      return `policy-error: .svn-mcp-policy.json glob is too long (max ${MAX_POLICY_GLOB_LENGTH})`;
    }
    const doublestarCount = (glob.match(/\*\*/g) ?? []).length;
    if (doublestarCount > MAX_POLICY_DOUBLESTAR_SEGMENTS) {
      return `policy-error: .svn-mcp-policy.json glob has too many ** segments (max ${MAX_POLICY_DOUBLESTAR_SEGMENTS})`;
    }
    const wildcardCount = (glob.match(/\*/g) ?? []).length;
    if (wildcardCount > MAX_POLICY_GLOB_WILDCARDS) {
      return `policy-error: .svn-mcp-policy.json glob has too many wildcards (max ${MAX_POLICY_GLOB_WILDCARDS})`;
    }
    if (glob.includes("\0")) {
      return "policy-error: .svn-mcp-policy.json glob contains an invalid null byte";
    }
  }

  return undefined;
}

function safePolicyStat(policyPath: string): { exists: boolean; mtimeMs: number; size: number } {
  try {
    const stat = fs.statSync(policyPath);
    return { exists: stat.isFile(), mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { exists: false, mtimeMs: 0, size: 0 };
  }
}

function globToRegExp(glob: string): RegExp {
  let source = "^";

  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];
    const afterNext = glob[index + 2];

    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?";
      index += 2;
      continue;
    }
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExp(char ?? "");
  }

  return new RegExp(`${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
