import { execFile, spawn } from "node:child_process";
import { isUtf8 } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactArgv } from "./envelope.js";
import { readonlyMode } from "./guards.js";
import type { RunResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_BUFFER = 20 * 1024 * 1024;

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

function siblingExecutable(svnPath: string, name: string): string {
  const directory = path.dirname(svnPath);
  const executable = platformExecutableName(name);
  return directory === "." ? executable : path.join(directory, executable);
}

export async function runExecutable(
  executable: string,
  args: string[],
  options: { cwd: string; timeout?: number; maxBuffer?: number }
): Promise<RunResult> {
  const cwd = path.resolve(options.cwd);
  const command = redactArgv(executable, args);

  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      {
        cwd,
        env: stableToolEnv(),
        timeout: options.timeout ?? timeoutMs(),
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        windowsHide: true,
        encoding: "buffer"
      },
      (error, stdoutBuffer, stderrBuffer) => {
        const stdout = decodeOutput(stdoutBuffer);
        const stderr = decodeOutput(stderrBuffer);
        const execError = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals }) | null;
        const killedByTimeout =
          Boolean(execError?.killed) && (execError?.signal === "SIGTERM" || execError?.code === "ETIMEDOUT");

        const result: RunResult = {
          command,
          cwd,
          executable,
          args,
          exitCode: typeof execError?.code === "number" ? execError.code : execError ? 1 : 0,
          signal: (execError?.signal as NodeJS.Signals | null | undefined) ?? null,
          stdout,
          stderr,
          timedOut: killedByTimeout
        };
        if (typeof execError?.code === "string") {
          result.errorCode = execError.code;
        }
        resolve(result);
      }
    );
  });
}

export async function runSvn(args: string[], cwd: string): Promise<RunResult> {
  return runExecutable(svnExecutable(), nonInteractiveSvnArgs(args), { cwd });
}

export async function runSvnStreamingLines(
  args: string[],
  cwd: string,
  onStdoutLine: (line: string) => void,
  options: { stdoutLineLimit?: number; timeout?: number } = {}
): Promise<RunResult> {
  return runExecutableStreamingLines(svnExecutable(), nonInteractiveSvnArgs(args), { cwd, ...options }, onStdoutLine);
}

export async function runExecutableStreamingLines(
  executable: string,
  args: string[],
  options: { cwd: string; stdoutLineLimit?: number; timeout?: number; stderrMaxBuffer?: number },
  onStdoutLine: (line: string) => void
): Promise<RunResult> {
  const cwd = path.resolve(options.cwd);
  const command = redactArgv(executable, args);
  const stdoutLineLimit = options.stdoutLineLimit ?? 200;

  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      env: stableToolEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutLines: string[] = [];
    const stderrBuffers: Buffer[] = [];
    const stderrMaxBuffer = options.stderrMaxBuffer ?? DEFAULT_MAX_BUFFER;
    let stdoutCarry: Buffer = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    let stderrBytes = 0;
    let stderrTruncated = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      settle({
        exitCode: null,
        signal: "SIGTERM",
        timedOut: true
      });
    }, options.timeout ?? timeoutMs());

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
      settle({
        exitCode: 1,
        signal: null,
        stderrOverride: error.message,
        timedOut,
        errorCode: error.code
      });
    });

    child.on("close", (code, signal) => {
      settle({ exitCode: code, signal, timedOut });
    });

    function settle(input: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      timedOut: boolean;
      stderrOverride?: string | undefined;
      errorCode?: string | undefined;
    }): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      consumeStdout(Buffer.alloc(0), true);
      const stderrText =
        decodeOutput(Buffer.concat(stderrBuffers)) + (stderrTruncated ? "\n[stderr truncated]" : "");
      resolve({
        command,
        cwd,
        executable,
        args,
        exitCode: input.exitCode,
        signal: input.signal,
        stdout: stdoutLines.join("\n"),
        stderr: input.stderrOverride ?? stderrText,
        timedOut: input.timedOut,
        errorCode: input.errorCode,
        truncated: stderrTruncated
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

      stdoutCarry = stdoutCarry.length === 0 ? chunk : Buffer.concat([stdoutCarry, chunk]);
      let newlineIndex: number;
      while ((newlineIndex = stdoutCarry.indexOf(0x0a)) !== -1) {
        emitStdoutLine(stdoutCarry.subarray(0, newlineIndex));
        stdoutCarry = stdoutCarry.subarray(newlineIndex + 1);
      }
      if (flush && stdoutCarry.length > 0) {
        emitStdoutLine(stdoutCarry);
        stdoutCarry = Buffer.alloc(0);
      }
    }

    function emitStdoutLine(lineBytes: Buffer): void {
      const trimmed = lineBytes.length > 0 && lineBytes[lineBytes.length - 1] === 0x0d
        ? lineBytes.subarray(0, lineBytes.length - 1)
        : lineBytes;
      const line = decodeOutput(trimmed);
      onStdoutLine(line);
      if (stdoutLines.length < stdoutLineLimit) {
        stdoutLines.push(line);
      }
    }
  });
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
  const svn = await runExecutable(svnExecutable(), ["--version", "--quiet"], { cwd, timeout: 10000 });
  const svnversion = await runExecutable(svnVersionExecutable(), ["--version", "--quiet"], { cwd, timeout: 10000 });
  const svnadmin = await runExecutable(svnAdminExecutable(), ["--version", "--quiet"], { cwd, timeout: 10000 });
  const dos2unix = await runExecutable(dos2UnixExecutable("dos2unix"), ["--version"], { cwd, timeout: 10000 });
  const unix2dos = await runExecutable(dos2UnixExecutable("unix2dos"), ["--version"], { cwd, timeout: 10000 });
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
  return args.includes("--non-interactive") ? args : ["--non-interactive", ...args];
}

function stableToolEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LC_ALL: "C",
    LANG: "C",
    LANGUAGE: "C"
  };
}
