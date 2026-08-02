import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { isUtf8 } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { redactArgv } from "./envelope.js";
import { readonlyMode } from "./guards.js";
import type { RunResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_BUFFER = 20 * 1024 * 1024;
const DEFAULT_MAX_STDOUT_LINE_BYTES = 1024 * 1024;
// Total budget for retained streamed stdout; lines beyond it still reach the
// per-line callback (so summaries stay complete) but are not stored.
const DEFAULT_MAX_STDOUT_CAPTURE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STDOUT_CALLBACK_LINES = 100_000;
const DEFAULT_MAX_STDOUT_CALLBACK_BYTES = 64 * 1024 * 1024;
const requestCancellation = new AsyncLocalStorage<AbortSignal>();

export function withRequestCancellation<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  return requestCancellation.run(signal, operation);
}

export function currentRequestCancellationSignal(): AbortSignal | undefined {
  return requestCancellation.getStore();
}

export function timeoutMs(): number {
  const parsed = Number.parseInt(process.env.SVN_AGENT_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

export function svnExecutable(): string {
  return process.env.SVN_AGENT_SVN_PATH || bundledExecutable("svn") || "svn";
}

export function svnVersionExecutable(): string {
  const svnPath = process.env.SVN_AGENT_SVN_PATH;
  if (!svnPath) {
    return bundledExecutable("svnversion") || "svnversion";
  }

  return siblingExecutable(svnPath, "svnversion");
}

export function svnAdminExecutable(): string {
  const svnPath = process.env.SVN_AGENT_SVN_PATH;
  if (!svnPath) {
    return bundledExecutable("svnadmin") || "svnadmin";
  }

  return siblingExecutable(svnPath, "svnadmin");
}

export function dos2UnixExecutable(name: "dos2unix" | "unix2dos"): string {
  const dir = process.env.SVN_AGENT_DOS2UNIX_DIR;
  if (dir) {
    return path.join(dir, platformExecutableName(name));
  }

  return bundledExecutable(name) || name;
}

function bundledExecutable(name: string): string | null {
  for (const dir of bundledBinDirs()) {
    for (const candidate of executableCandidates(dir, name)) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function bundledBinDirs(): string[] {
  const dirs = [
    process.env.SVN_AGENT_BIN_DIR ? path.resolve(process.env.SVN_AGENT_BIN_DIR) : null,
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin")
  ].filter((dir): dir is string => dir !== null);

  return Array.from(new Set(dirs));
}

function executableCandidates(dir: string, name: string): string[] {
  const primary = path.join(dir, platformExecutableName(name));
  const fallback = path.join(dir, name);
  return primary === fallback ? [primary] : [primary, fallback];
}

export function platformExecutableName(name: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${name}.exe` : name;
}

export function escapeSvnTarget(value: string): string {
  return value.includes("@") ? `${value}@` : value;
}

function siblingExecutable(svnPath: string, name: string): string {
  const directory = path.dirname(svnPath);
  const executable = platformExecutableName(name);
  return directory === "." ? executable : path.join(directory, executable);
}

export async function runExecutable(
  executable: string,
  args: string[],
  options: { cwd: string; timeout?: number; maxBuffer?: number; signal?: AbortSignal }
): Promise<RunResult> {
  const cwd = path.resolve(options.cwd);
  const command = redactArgv(executable, args);
  const effectiveTimeoutMs = options.timeout ?? timeoutMs();
  const cancellationSignal = options.signal ?? requestCancellation.getStore();
  if (cancellationSignal?.aborted) {
    return cancelledBeforeLaunchResult(command, cwd, executable, args, effectiveTimeoutMs);
  }

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, args, {
        cwd,
        env: stableToolEnv(),
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      // A synchronous launch failure (for example a NUL byte in an argument)
      // must resolve as a structured failed run, never as a thrown TypeError.
      resolve(launchFailureResult({ command, cwd, executable, args, timeoutMs: effectiveTimeoutMs, error }));
      return;
    }

    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const stdoutBuffers: Buffer[] = [];
    const stderrBuffers: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutOverflowed = false;
    let stderrOverflowed = false;
    let launchError: NodeJS.ErrnoException | null = null;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let escalation: NodeJS.Timeout | null = null;

    const capture = (buffers: Buffer[], chunk: Buffer, currentBytes: number, streamOverflowed: boolean): {
      bytes: number;
      overflowed: boolean;
    } => {
      if (streamOverflowed) return { bytes: currentBytes, overflowed: true };
      if (currentBytes + chunk.length > maxBuffer) {
        const remaining = Math.max(0, maxBuffer - currentBytes);
        if (remaining > 0) buffers.push(chunk.subarray(0, remaining));
        terminateProcessTree(child, true);
        return { bytes: maxBuffer, overflowed: true };
      }
      buffers.push(chunk);
      return { bytes: currentBytes + chunk.length, overflowed: false };
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const captured = capture(stdoutBuffers, chunk, stdoutBytes, stdoutOverflowed);
      stdoutBytes = captured.bytes;
      stdoutOverflowed = captured.overflowed;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const captured = capture(stderrBuffers, chunk, stderrBytes, stderrOverflowed);
      stderrBytes = captured.bytes;
      stderrOverflowed = captured.overflowed;
    });

    const cancelProcessTree = () => {
      cancelled = true;
      terminateProcessTree(child, true);
    };
    cancellationSignal?.addEventListener("abort", cancelProcessTree, { once: true });

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, false);
      escalation = setTimeout(() => {
        if (!settled) terminateProcessTree(child, true);
      }, 1000);
    }, effectiveTimeoutMs);

    const settle = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      cancellationSignal?.removeEventListener("abort", cancelProcessTree);
      const overflowed = stdoutOverflowed || stderrOverflowed;
      const stderrSuffix = overflowed ? "\n[output exceeded maxBuffer]" : "";
      const result: RunResult = {
        command,
        cwd,
        executable,
        args,
        exitCode: timedOut || cancelled ? null : overflowed || launchError ? 1 : exitCode,
        signal,
        stdout: decodeOutput(Buffer.concat(stdoutBuffers)),
        stderr: `${decodeOutput(Buffer.concat(stderrBuffers))}${stderrSuffix}`,
        timedOut,
        cancelled: cancelled && !timedOut,
        timeoutMs: effectiveTimeoutMs,
        truncated: overflowed
      };
      if (overflowed) result.errorCode = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      else if (typeof launchError?.code === "string") result.errorCode = launchError.code;
      resolve(result);
    };

    child.once("error", (error: NodeJS.ErrnoException) => {
      launchError = error;
    });
    child.once("close", (exitCode, signal) => settle(exitCode, signal));
  });
}

function launchFailureResult(input: {
  command: string;
  cwd: string;
  executable: string;
  args: string[];
  timeoutMs: number;
  error: unknown;
}): RunResult {
  const error = input.error as NodeJS.ErrnoException | null;
  return {
    command: input.command,
    cwd: input.cwd,
    executable: input.executable,
    args: input.args,
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: error?.message ?? String(input.error),
    timedOut: false,
    cancelled: false,
    timeoutMs: input.timeoutMs,
    errorCode: typeof error?.code === "string" ? error.code : "ERR_LAUNCH_FAILED"
  };
}

function cancelledBeforeLaunchResult(
  command: string,
  cwd: string,
  executable: string,
  args: string[],
  effectiveTimeoutMs: number
): RunResult {
  return {
    command,
    cwd,
    executable,
    args,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    cancelled: true,
    timeoutMs: effectiveTimeoutMs
  };
}

export async function runSvn(args: string[], cwd: string): Promise<RunResult> {
  return runExecutable(svnExecutable(), nonInteractiveSvnArgs(args), { cwd });
}

export async function runSvnStreamingLines(
  args: string[],
  cwd: string,
  onStdoutLine: (line: string) => void,
  options: {
    stdoutLineLimit?: number;
    stdoutMaxLineBytes?: number;
    stdoutMaxCaptureBytes?: number;
    stdoutCallbackLineLimit?: number;
    stdoutCallbackMaxBytes?: number;
    timeout?: number;
    signal?: AbortSignal;
  } = {}
): Promise<RunResult> {
  return runExecutableStreamingLines(svnExecutable(), nonInteractiveSvnArgs(args), { cwd, ...options }, onStdoutLine);
}

export async function runExecutableStreamingLines(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    stdoutLineLimit?: number;
    stdoutMaxLineBytes?: number;
    stdoutMaxCaptureBytes?: number;
    stdoutCallbackLineLimit?: number;
    stdoutCallbackMaxBytes?: number;
    timeout?: number;
    stderrMaxBuffer?: number;
    signal?: AbortSignal;
  },
  onStdoutLine: (line: string) => void
): Promise<RunResult> {
  const cwd = path.resolve(options.cwd);
  const command = redactArgv(executable, args);
  const stdoutLineLimit = options.stdoutLineLimit ?? 200;
  const effectiveTimeoutMs = options.timeout ?? timeoutMs();
  const cancellationSignal = options.signal ?? requestCancellation.getStore();
  if (cancellationSignal?.aborted) {
    return cancelledBeforeLaunchResult(command, cwd, executable, args, effectiveTimeoutMs);
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, args, {
        cwd,
        env: stableToolEnv(),
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        ...(cancellationSignal ? { signal: cancellationSignal } : {})
      });
    } catch (error) {
      resolve(launchFailureResult({ command, cwd, executable, args, timeoutMs: effectiveTimeoutMs, error }));
      return;
    }
    const stdoutLines: string[] = [];
    const stderrBuffers: Buffer[] = [];
    const stderrMaxBuffer = options.stderrMaxBuffer ?? DEFAULT_MAX_BUFFER;
    const stdoutMaxLineBytes = Math.max(1, options.stdoutMaxLineBytes ?? DEFAULT_MAX_STDOUT_LINE_BYTES);
    const stdoutMaxCaptureBytes = Math.max(1, options.stdoutMaxCaptureBytes ?? DEFAULT_MAX_STDOUT_CAPTURE_BYTES);
    const stdoutCallbackLineLimit = Math.max(1, options.stdoutCallbackLineLimit ?? DEFAULT_MAX_STDOUT_CALLBACK_LINES);
    const stdoutCallbackMaxBytes = Math.max(1, options.stdoutCallbackMaxBytes ?? DEFAULT_MAX_STDOUT_CALLBACK_BYTES);
    let stdoutCapturedBytes = 0;
    let stdoutCallbackBytes = 0;
    let stdoutCallbackLines = 0;
    let stdoutFragments: Buffer[] = [];
    let stdoutLineBytes = 0;
    let stdoutLineTruncated = false;
    let stdoutTruncated = false;
    let stdoutCaptureClosed = false;
    let stdoutCallbackClosed = false;
    let stdoutCallbackTruncated = false;
    let timedOut = false;
    let settled = false;
    let stderrBytes = 0;
    let stderrTruncated = false;
    let launchError: NodeJS.ErrnoException | null = null;

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, false);
      escalation = setTimeout(() => {
        if (!settled) terminateProcessTree(child, true);
      }, 1000);
    }, effectiveTimeoutMs);
    let escalation: NodeJS.Timeout | null = null;
    const cancelProcessTree = () => terminateProcessTree(child, true);
    cancellationSignal?.addEventListener("abort", cancelProcessTree, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      consumeStdout(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      appendStderr(chunk);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      launchError = error;
    });

    child.on("close", (code, signal) => {
      settle({
        exitCode: launchError ? 1 : code,
        signal,
        ...(launchError ? { stderrOverride: launchError.message, errorCode: launchError.code } : {}),
        timedOut,
        cancelled: cancellationSignal?.aborted === true && !timedOut
      });
    });

    function settle(input: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      timedOut: boolean;
      cancelled: boolean;
      stderrOverride?: string | undefined;
      errorCode?: string | undefined;
    }): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      cancellationSignal?.removeEventListener("abort", cancelProcessTree);
      consumeStdout(Buffer.alloc(0), true);
      const stderrText =
        decodeOutput(Buffer.concat(stderrBuffers)) + (stderrTruncated ? "\n[stderr truncated]" : "");
      resolve({
        command,
        cwd,
        executable,
        args,
        exitCode: input.timedOut || input.cancelled ? null : input.exitCode,
        signal: input.signal,
        stdout: stdoutLines.join("\n"),
        stderr: input.stderrOverride ?? stderrText,
        timedOut: input.timedOut,
        cancelled: input.cancelled,
        timeoutMs: effectiveTimeoutMs,
        errorCode: input.errorCode,
        truncated: stderrTruncated || stdoutTruncated,
        callbackTruncated: stdoutCallbackTruncated
      });
    }

    function appendStderr(chunk: Buffer): void {
      if (stderrTruncated) {
        return;
      }

      const remaining = stderrMaxBuffer - stderrBytes;
      if (remaining <= 0) {
        stderrTruncated = true;
        return;
      }

      if (chunk.length > remaining) {
        stderrBuffers.push(chunk.subarray(0, remaining));
        stderrBytes = stderrMaxBuffer;
        stderrTruncated = true;
        return;
      }

      stderrBuffers.push(chunk);
      stderrBytes += chunk.length;
    }

    // Byte-level line splitting so each line can take the latin1 fallback in
    // decodeOutput; a text StringDecoder would lossily replace non-UTF8 bytes
    // before the fallback could see them.
    function consumeStdout(chunk: Buffer, flush = false): void {
      if (chunk.length === 0 && !flush) {
        return;
      }

      let offset = 0;
      while (offset < chunk.length) {
        const newlineIndex = chunk.indexOf(0x0a, offset);
        const end = newlineIndex === -1 ? chunk.length : newlineIndex;
        appendStdoutFragment(chunk.subarray(offset, end));
        if (newlineIndex === -1) {
          break;
        }
        emitStdoutLine();
        offset = newlineIndex + 1;
      }
      if (flush && (stdoutLineBytes > 0 || stdoutLineTruncated)) {
        emitStdoutLine();
      }
    }

    function appendStdoutFragment(fragment: Buffer): void {
      const remaining = stdoutMaxLineBytes - stdoutLineBytes;
      if (fragment.length > remaining) {
        if (remaining > 0) {
          stdoutFragments.push(fragment.subarray(0, remaining));
          stdoutLineBytes += remaining;
        }
        stdoutLineTruncated = true;
        stdoutTruncated = true;
        return;
      }

      if (fragment.length > 0) {
        stdoutFragments.push(fragment);
        stdoutLineBytes += fragment.length;
      }
    }

    function emitStdoutLine(): void {
      if (stdoutCallbackClosed && stdoutCaptureClosed) {
        stdoutFragments = [];
        stdoutLineBytes = 0;
        stdoutLineTruncated = false;
        return;
      }
      const lineBytes = Buffer.concat(stdoutFragments, stdoutLineBytes);
      const trimmed = lineBytes.length > 0 && lineBytes[lineBytes.length - 1] === 0x0d
        ? lineBytes.subarray(0, lineBytes.length - 1)
        : lineBytes;
      const line = decodeOutput(trimmed) + (stdoutLineTruncated ? " [line truncated]" : "");
      const lineBytesForCapture = Buffer.byteLength(line, "utf8");
      if (!stdoutCallbackClosed
          && stdoutCallbackLines < stdoutCallbackLineLimit
          && stdoutCallbackBytes + lineBytesForCapture <= stdoutCallbackMaxBytes) {
        onStdoutLine(line);
        stdoutCallbackLines += 1;
        stdoutCallbackBytes += lineBytesForCapture;
      } else if (!stdoutCallbackClosed) {
        stdoutCallbackClosed = true;
        stdoutCallbackTruncated = true;
        stdoutTruncated = true;
      }
      if (!stdoutCaptureClosed && stdoutLines.length < stdoutLineLimit) {
        if (stdoutCapturedBytes + lineBytesForCapture <= stdoutMaxCaptureBytes) {
          stdoutLines.push(line);
          stdoutCapturedBytes += lineBytesForCapture;
        } else {
          stdoutTruncated = true;
          stdoutCaptureClosed = true;
        }
      } else if (stdoutLines.length >= stdoutLineLimit) {
        stdoutTruncated = true;
        stdoutCaptureClosed = true;
      }
      stdoutFragments = [];
      stdoutLineBytes = 0;
      stdoutLineTruncated = false;
    }
  });
}

function terminateProcessTree(child: ChildProcess, force: boolean): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    const taskkill = path.join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32", "taskkill.exe");
    execFile(
      taskkill,
      ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
      { windowsHide: true },
      () => undefined
    );
    return;
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    try {
      child.kill(force ? "SIGKILL" : "SIGTERM");
    } catch {
      // The process already exited.
    }
  }
}

export async function runSvnVersion(target: string, cwd: string): Promise<RunResult> {
  return runExecutable(svnVersionExecutable(), [target], { cwd });
}

export async function runDos2Unix(name: "dos2unix" | "unix2dos", args: string[], cwd: string): Promise<RunResult> {
  return runExecutable(dos2UnixExecutable(name), args, { cwd });
}

export async function startupProbe(cwd = process.cwd()): Promise<{
  readonly: boolean;
  svn: { ok: boolean; version: string | null; note: string };
  svnversion: { ok: boolean; note: string };
  svnadmin: { ok: boolean; note: string };
  dos2unix: { ok: boolean; note: string };
  unix2dos: { ok: boolean; note: string };
}> {
  const [svn, svnversion, svnadmin, dos2unix, unix2dos] = await Promise.all([
    runExecutable(svnExecutable(), ["--version", "--quiet"], { cwd, timeout: 10000 }),
    runExecutable(svnVersionExecutable(), ["--version", "--quiet"], { cwd, timeout: 10000 }),
    runExecutable(svnAdminExecutable(), ["--version", "--quiet"], { cwd, timeout: 10000 }),
    runExecutable(dos2UnixExecutable("dos2unix"), ["--version"], { cwd, timeout: 10000 }),
    runExecutable(dos2UnixExecutable("unix2dos"), ["--version"], { cwd, timeout: 10000 })
  ]);
  const svnVersion = svn.exitCode === 0 ? svn.stdout.trim() : null;
  const svnSupported = svnVersion !== null && isSupportedSvnVersion(svnVersion);
  let svnNote = "";
  if (svn.exitCode !== 0) {
    svnNote = "svn unavailable";
  } else if (!svnSupported) {
    svnNote = `SVN 1.14 or newer required; found ${svnVersion}`;
  }

  return {
    readonly: readonlyMode(),
    svn: {
      ok: svnSupported,
      version: svnVersion,
      note: svnNote
    },
    svnversion: {
      ok: svnversion.exitCode === 0,
      note: svnversion.exitCode === 0 ? "" : "svnversion unavailable"
    },
    svnadmin: {
      ok: svnadmin.exitCode === 0,
      note: svnadmin.exitCode === 0 ? "" : "svnadmin unavailable"
    },
    dos2unix: {
      ok: dos2unix.exitCode === 0,
      note: dos2unix.exitCode === 0 ? firstLine(dos2unix.stdout) : "dos2unix unavailable"
    },
    unix2dos: {
      ok: unix2dos.exitCode === 0,
      note: unix2dos.exitCode === 0 ? firstLine(unix2dos.stdout) : "unix2dos unavailable"
    }
  };
}

export function isSupportedSvnVersion(value: string): boolean {
  const match = value.trim().match(/^(\d+)\.(\d+)/);
  if (!match) {
    return false;
  }
  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = Number.parseInt(match[2] ?? "", 10);
  return major > 1 || (major === 1 && minor >= 14);
}

function firstLine(text: string): string {
  return text.replace(/\r\n/g, "\n").split("\n")[0] ?? "";
}

function decodeOutput(buffer: Buffer | string): string {
  if (typeof buffer === "string") {
    return buffer;
  }

  return isUtf8(buffer) ? buffer.toString("utf8") : buffer.toString("latin1");
}

function nonInteractiveSvnArgs(args: string[]): string[] {
  return args.some((arg) => arg === "--non-interactive" || arg.startsWith("--non-interactive="))
    ? args
    : ["--non-interactive", ...args];
}

function stableToolEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LC_ALL: "C",
    LANG: "C",
    LANGUAGE: "C"
  };
}
