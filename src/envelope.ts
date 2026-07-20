import type { ChangedPath, Conflict, Envelope, RunResult } from "./types.js";

const DEFAULT_SUMMARY_LINES = 200;
const DEFAULT_SUMMARY_CHARS = 16000;

export function redactArgv(executable: string, args: string[]): string {
  const redacted = [executable, ...args];
  for (let index = 0; index < redacted.length; index += 1) {
    const value = redacted[index] ?? "";
    const arg = value.toLowerCase();
    if ((arg === "--password" || arg === "--username") && index + 1 < redacted.length) {
      redacted[index + 1] = "***";
      continue;
    }
    if (arg.startsWith("--password=") || arg.startsWith("--username=")) {
      const equalsIndex = value.indexOf("=");
      redacted[index] = `${value.slice(0, equalsIndex)}=***`;
      continue;
    }
    redacted[index] = redactText(redacted[index] ?? "");
  }

  return redacted.map(quoteArgForDisplay).join(" ");
}
export function quoteArgForDisplay(arg: string): string {
  if (arg.length === 0) {
    return '""';
  }

  if (/[\s"]/.test(arg)) {
    return `"${arg.replace(/"/g, '\\"')}"`;
  }

  return arg;
}

export function redactText(value: string): string {
  const withSafeUrl = redactUrlUserinfo(value);
  return withSafeUrl.replace(
    /([?&](?:access_token|api[_-]?key|auth|client[_-]?id|email|key|login|pass(?:word)?|secret|token|user(?:name)?)=)[^&#\s]*/gi,
    "$1***"
  );
}

function redactUrlUserinfo(value: string): string {
  return value.replace(/([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/?#]*@)+/gi, "$1***:***@");
}

export function summarizeText(text: string, maxLines = DEFAULT_SUMMARY_LINES): { text: string; truncated: boolean } {
  if (!text) {
    return { text: "", truncated: false };
  }

  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length <= maxLines && normalized.length <= DEFAULT_SUMMARY_CHARS) {
    return { text: normalized, truncated: false };
  }

  const lineLimited = lines.slice(0, maxLines).join("\n");
  return {
    text: lineLimited.slice(0, DEFAULT_SUMMARY_CHARS),
    truncated: true
  };
}

export function createEnvelope(input: {
  ok: boolean;
  command: string;
  cwd: string;
  revision?: number | null | undefined;
  changed_paths?: ChangedPath[] | undefined;
  conflicts?: Conflict[] | undefined;
  stdout?: string | undefined;
  stderr?: string | undefined;
  truncated?: boolean | undefined;
  note?: string | undefined;
}): Envelope {
  const stdout = summarizeText(redactText(input.stdout ?? ""));
  const stderr = summarizeText(redactText(input.stderr ?? ""));

  return {
    ok: input.ok,
    command: input.command,
    cwd: input.cwd,
    revision: input.revision ?? null,
    changed_paths: input.changed_paths ?? [],
    conflicts: input.conflicts ?? [],
    stdout_summary: stdout.text,
    stderr_summary: stderr.text,
    truncated: Boolean(input.truncated || stdout.truncated || stderr.truncated),
    note: input.note ?? ""
  };
}

export function envelopeFromRun(input: {
  ok?: boolean | undefined;
  run: RunResult;
  revision?: number | null | undefined;
  changed_paths?: ChangedPath[] | undefined;
  conflicts?: Conflict[] | undefined;
  note?: string | undefined;
  truncated?: boolean | undefined;
}): Envelope {
  return createEnvelope({
    ok: input.ok ?? input.run.exitCode === 0,
    command: input.run.command,
    cwd: input.run.cwd,
    revision: input.revision ?? null,
    changed_paths: input.changed_paths,
    conflicts: input.conflicts,
    stdout: input.run.stdout,
    stderr: input.run.stderr,
    truncated: input.truncated ?? input.run.truncated,
    note: input.note ?? noteFromRun(input.run)
  });
}

export function failEnvelope(command: string, cwd: string, note: string, extra?: Partial<Envelope>): Envelope {
  return {
    ...createEnvelope({
      ok: false,
      command,
      cwd,
      note
    }),
    ...extra,
    ok: false,
    command,
    cwd,
    note
  };
}

export function noteFromRun(run: RunResult): string {
  if (run.timedOut) {
    return run.timeoutMs ? `svn timed out after ${run.timeoutMs} ms` : "svn timed out";
  }

  if (run.errorCode === "ENOENT" || run.errorCode === "EACCES" || run.errorCode === "EPERM") {
    return "MCP svn runtime unavailable (executable failed to launch) - failsafe: use scoped raw svn CLI for this session per svnrules; guard refusals are not failures and must never be bypassed via CLI";
  }

  if (run.errorCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return "svn output exceeded the 20 MB safety limit - scope paths more narrowly";
  }

  const text = `${run.stderr}\n${run.stdout}`;
  if (/E155004|E155036/.test(text)) {
    return "working copy locked - run svn_cleanup";
  }
  if (/E215004|No more credentials|we tried too many times|E170001|authorization failed|Authentication failed/i.test(text)) {
    return "authentication failed - fix svn cached auth outside the MCP";
  }
  if (/E175002|Unable to connect|Connection refused|Network is unreachable|Could not resolve hostname/i.test(text)) {
    return "network or repository connection failed";
  }
  if (/E155007/.test(text)) {
    return "path is not inside a working copy";
  }
  if (/E135000|inconsistent newlines|inconsistent line ending style/i.test(text)) {
    return "inconsistent line endings - run eol_fix_verified on affected files";
  }
  if (/E200009|is not a working copy|unversioned/i.test(text)) {
    return "target not versioned";
  }
  if (/E200030|sqlite|database is locked|database disk image is malformed/i.test(text)) {
    return "working copy database problem - run svn_cleanup";
  }

  return run.exitCode === 0 ? "" : "svn command failed";
}
