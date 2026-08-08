export type SvnStatusCode = "M" | "A" | "D" | "R" | "C" | "?" | "!" | "~" | "G" | "U" | "E";

export interface ChangedPath {
  status: string;
  path: string;
  covered_by_ignored_ancestor?: boolean;
  ignored_ancestor?: string;
}

export interface Conflict {
  path: string;
  type: "text" | "tree" | "prop";
}

export interface Envelope {
  [key: string]: unknown;
  ok: boolean;
  command: string;
  cwd: string;
  revision: number | null;
  changed_paths: ChangedPath[];
  conflicts: Conflict[];
  stdout_summary: string;
  stderr_summary: string;
  truncated: boolean;
  note: string;
}

export type ToolEnvelope = Envelope;

export interface WcInfo {
  kind?: "file" | "dir" | null;
  path?: string | null;
  url: string | null;
  repo_root: string | null;
  wc_root: string | null;
  revision: number | null;
  lock?: SvnLockInfo | null;
}

/** Metadata returned by `svn info --xml` for a repository lock.
 *
 * The token is retained only for internal comparison. Public lock responses
 * must never copy it into an envelope or receipt.
 */
export interface SvnLockInfo {
  token: string | null;
  owner: string | null;
  comment: string | null;
  created: string | null;
  expires: string | null;
}

export interface RunResult {
  command: string;
  cwd: string;
  executable: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled?: boolean | undefined;
  timeoutMs?: number | undefined;
  errorCode?: string | undefined;
  truncated?: boolean | undefined;
  callbackTruncated?: boolean | undefined;
}

export interface DiffFileSummary {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
  property_changed?: boolean;
  hunks: number;
  first_hunk?: string;
  first_meaningful_line?: string;
  preview_truncated?: boolean;
}

export interface DiffSummary {
  per_file: DiffFileSummary[];
  per_file_truncated: boolean;
  diff_excerpt: string;
  truncated: boolean;
  total_files: number;
  total_lines: number;
  total_chars: number;
  total_hunks: number;
  total_added: number;
  total_removed: number;
  binary_files: number;
  property_files: number;
}

export type EolKind = "crlf" | "lf" | "mixed" | "none" | "binary" | "skipped-too-large" | "not-a-file";

export interface EolSniff {
  path: string;
  kind: EolKind;
  has_bom: boolean;
  size: number;
  sniff: "ok" | "skipped-too-large" | "not-a-file";
}

export interface EolCheckResult extends EolSniff {
  eol_style: string | null;
  mismatch: boolean;
}
