import { describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dos2UnixExecutable,
  runExecutable,
  runExecutableStreamingLines,
  runSvn,
  svnAdminExecutable,
  svnExecutable,
  svnVersionExecutable
} from "../src/runner.js";

describe("runner executable resolution", () => {
  it("prefers bundled binaries when no explicit environment override is set", () => {
    withCleanToolEnv(() => {
      const bin = path.join(process.cwd(), "bin");

      expect(path.normalize(svnExecutable())).toBe(path.join(bin, "svn.exe"));
      expect(path.normalize(svnVersionExecutable())).toBe(path.join(bin, "svnversion.exe"));
      expect(path.normalize(svnAdminExecutable())).toBe(path.join(bin, "svnadmin.exe"));
      expect(path.normalize(dos2UnixExecutable("dos2unix"))).toBe(path.join(bin, "dos2unix.exe"));
      expect(path.normalize(dos2UnixExecutable("unix2dos"))).toBe(path.join(bin, "unix2dos.exe"));
    });
  });

  it("keeps explicit environment overrides ahead of the bundled bin", () => {
    withCleanToolEnv(() => {
      const svn = path.join("C:", "custom", "svn.exe");
      const eol = path.join("C:", "custom-eol");

      process.env.SVN_AGENT_SVN_PATH = svn;
      process.env.SVN_AGENT_DOS2UNIX_DIR = eol;

      expect(path.normalize(svnExecutable())).toBe(svn);
      expect(path.normalize(svnVersionExecutable())).toBe(path.join(path.dirname(svn), "svnversion.exe"));
      expect(path.normalize(svnAdminExecutable())).toBe(path.join(path.dirname(svn), "svnadmin.exe"));
      expect(path.normalize(dos2UnixExecutable("dos2unix"))).toBe(path.join(eol, "dos2unix.exe"));
      expect(path.normalize(dos2UnixExecutable("unix2dos"))).toBe(path.join(eol, "unix2dos.exe"));
    });
  });

  it("supports a portable bundled-bin directory override", () => {
    withCleanToolEnv(() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "svn-agent-bin-"));
      try {
        for (const executable of ["svn.exe", "svnversion.exe", "svnadmin.exe", "dos2unix.exe", "unix2dos.exe"]) {
          fs.writeFileSync(path.join(dir, executable), "");
        }

        process.env.SVN_AGENT_BIN_DIR = dir;

        expect(path.normalize(svnExecutable())).toBe(path.join(dir, "svn.exe"));
        expect(path.normalize(svnVersionExecutable())).toBe(path.join(dir, "svnversion.exe"));
        expect(path.normalize(svnAdminExecutable())).toBe(path.join(dir, "svnadmin.exe"));
        expect(path.normalize(dos2UnixExecutable("dos2unix"))).toBe(path.join(dir, "dos2unix.exe"));
        expect(path.normalize(dos2UnixExecutable("unix2dos"))).toBe(path.join(dir, "unix2dos.exe"));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("runs SVN commands non-interactively", async () => {
    const run = await runSvn(["--version", "--quiet"], process.cwd());

    expect(run.exitCode).toBe(0);
    expect(run.args[0]).toBe("--non-interactive");
    expect(run.command).toContain("--non-interactive");
  });

  it("forces a stable C locale for child tools", async () => {
    const run = await runExecutable(process.execPath, ["-e", "process.stdout.write(process.env.LC_ALL || '')"], {
      cwd: process.cwd()
    });

    expect(run.stdout).toBe("C");
  });

  it("falls back to latin1 when child output is not valid UTF-8", async () => {
    const run = await runExecutable(process.execPath, ["-e", "process.stdout.write(Buffer.from([0xe9]))"], {
      cwd: process.cwd()
    });

    expect(run.stdout).toBe("é");
  });

  it("caps streaming stderr and marks the run truncated", async () => {
    const run = await runExecutableStreamingLines(
      process.execPath,
      ["-e", "process.stderr.write('x'.repeat(1000))"],
      { cwd: process.cwd(), stderrMaxBuffer: 16 },
      () => undefined
    );

    expect(run.exitCode).toBe(0);
    expect(run.stderr.length).toBeLessThan(1000);
    expect(run.stderr).toContain("[stderr truncated]");
    expect(run.truncated).toBe(true);
  });

  it("falls back to latin1 for streamed stdout lines that are not valid UTF-8", async () => {
    const lines: string[] = [];
    const run = await runExecutableStreamingLines(
      process.execPath,
      ["-e", "process.stdout.write(Buffer.from([0x2b, 0xe9, 0x0a]))"],
      { cwd: process.cwd() },
      (line) => lines.push(line)
    );

    expect(run.exitCode).toBe(0);
    expect(lines).toEqual(["+é"]);
    expect(run.stdout).toBe("+é");
  });

  it("settles streaming calls on timeout", async () => {
    const started = Date.now();
    const run = await runExecutableStreamingLines(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { cwd: process.cwd(), timeout: 50 },
      () => undefined
    );

    expect(Date.now() - started).toBeLessThan(2000);
    expect(run.timedOut).toBe(true);
    expect(run.exitCode).toBeNull();
  });
});

function withCleanToolEnv(fn: () => void): void {
  const saved = {
    SVN_AGENT_BIN_DIR: process.env.SVN_AGENT_BIN_DIR,
    SVN_AGENT_SVN_PATH: process.env.SVN_AGENT_SVN_PATH,
    SVN_AGENT_DOS2UNIX_DIR: process.env.SVN_AGENT_DOS2UNIX_DIR
  };

  delete process.env.SVN_AGENT_BIN_DIR;
  delete process.env.SVN_AGENT_SVN_PATH;
  delete process.env.SVN_AGENT_DOS2UNIX_DIR;

  try {
    fn();
  } finally {
    restoreEnv("SVN_AGENT_BIN_DIR", saved.SVN_AGENT_BIN_DIR);
    restoreEnv("SVN_AGENT_SVN_PATH", saved.SVN_AGENT_SVN_PATH);
    restoreEnv("SVN_AGENT_DOS2UNIX_DIR", saved.SVN_AGENT_DOS2UNIX_DIR);
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
