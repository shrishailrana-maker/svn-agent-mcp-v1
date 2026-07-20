export type SvnStatusCode = "M" | "A" | "D" | "R" | "C" | "?" | "!" | "~" | "G" | "U" | "E";

export interface ChangedPath {
  status: string;
  path: string;
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
  url: string | null;
  repo_root: string | null;
  wc_root: string | null;
  revision: number | null;
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
  errorCode?: string | undefined;
  truncated?: boolean | undefined;
}

export interface DiffFileSummary {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
  property_changed?: boolean;
}

export interface DiffSummary {
  per_file: DiffFileSummary[];
  diff_excerpt: string;
  truncated: boolean;
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
