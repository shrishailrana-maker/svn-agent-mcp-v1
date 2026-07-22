import { describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dos2UnixExecutable,
  isSupportedSvnVersion,
  platformExecutableName,
  runExecutable,
  runExecutableStreamingLines,
  runSvn,
  svnAdminExecutable,
  svnExecutable,
  svnVersionExecutable,
  withRequestCancellation
} from "../src/runner.js";

describe("runner executable resolution", () => {
  it("uses the executable naming convention for each supported platform", () => {
    expect(platformExecutableName("svn", "win32")).toBe("svn.exe");
    expect(platformExecutableName("svn", "darwin")).toBe("svn");
    expect(platformExecutableName("svn", "linux")).toBe("svn");
  });

  it("requires SVN 1.14 or newer", () => {
    expect(isSupportedSvnVersion("1.14.0")).toBe(true);
    expect(isSupportedSvnVersion("1.15.2")).toBe(true);
    expect(isSupportedSvnVersion("1.13.9")).toBe(false);
    expect(isSupportedSvnVersion("not-a-version")).toBe(false);
  });

  it("prefers compatible bundled binaries and otherwise falls back to PATH", () => {
    withCleanToolEnv(() => {
      const bin = path.join(process.cwd(), "bin");
      const expected = (name: string) => {
        const bundled = path.join(bin, platformExecutableName(name));
        return fs.existsSync(bundled) ? bundled : name;
      };

      expect(path.normalize(svnExecutable())).toBe(expected("svn"));
      expect(path.normalize(svnVersionExecutable())).toBe(expected("svnversion"));
      expect(path.normalize(svnAdminExecutable())).toBe(expected("svnadmin"));
      expect(path.normalize(dos2UnixExecutable("dos2unix"))).toBe(expected("dos2unix"));
      expect(path.normalize(dos2UnixExecutable("unix2dos"))).toBe(expected("unix2dos"));
    });
  });

  it("keeps explicit environment overrides ahead of the bundled bin", () => {
    withCleanToolEnv(() => {
      const customRoot = process.platform === "win32" ? "C:\\custom" : "/opt/custom";
      const svn = path.join(customRoot, platformExecutableName("svn"));
      const eol = path.join(customRoot, "eol");

      process.env.SVN_AGENT_SVN_PATH = svn;
      process.env.SVN_AGENT_DOS2UNIX_DIR = eol;

      expect(path.normalize(svnExecutable())).toBe(svn);
      expect(path.normalize(svnVersionExecutable())).toBe(path.join(path.dirname(svn), platformExecutableName("svnversion")));
      expect(path.normalize(svnAdminExecutable())).toBe(path.join(path.dirname(svn), platformExecutableName("svnadmin")));
      expect(path.normalize(dos2UnixExecutable("dos2unix"))).toBe(path.join(eol, platformExecutableName("dos2unix")));
      expect(path.normalize(dos2UnixExecutable("unix2dos"))).toBe(path.join(eol, platformExecutableName("unix2dos")));
    });
  });

  it("supports a portable bundled-bin directory override", () => {
    withCleanToolEnv(() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "svn-agent-bin-"));
      try {
        for (const name of ["svn", "svnversion", "svnadmin", "dos2unix", "unix2dos"]) {
          const executable = platformExecutableName(name);
          fs.writeFileSync(path.join(dir, executable), "");
        }

        process.env.SVN_AGENT_BIN_DIR = dir;

        expect(path.normalize(svnExecutable())).toBe(path.join(dir, platformExecutableName("svn")));
        expect(path.normalize(svnVersionExecutable())).toBe(path.join(dir, platformExecutableName("svnversion")));
        expect(path.normalize(svnAdminExecutable())).toBe(path.join(dir, platformExecutableName("svnadmin")));
        expect(path.normalize(dos2UnixExecutable("dos2unix"))).toBe(path.join(dir, platformExecutableName("dos2unix")));
        expect(path.normalize(dos2UnixExecutable("unix2dos"))).toBe(path.join(dir, platformExecutableName("unix2dos")));
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

  it("caps a streaming stdout line and marks the truncation", async () => {
    const lines: string[] = [];
    const run = await runExecutableStreamingLines(
      process.execPath,
      ["-e", "process.stdout.write('+' + 'x'.repeat(1000))"],
      { cwd: process.cwd(), stdoutMaxLineBytes: 16 },
      (line) => lines.push(line)
    );

    expect(run.exitCode).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("+xxxxxxxxxxxxxxx [line truncated]");
    expect(run.stdout).toBe(lines[0]);
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

  it("contains NUL-byte launch failures as failed run results instead of throwing", async () => {
    const buffered = await runExecutable(process.execPath, ["-e", "bad\x00arg"], { cwd: process.cwd() });
    expect(buffered.exitCode).toBe(1);
    expect(buffered.errorCode).toBeDefined();
    expect(buffered.stderr.length).toBeGreaterThan(0);

    const streamed = await runExecutableStreamingLines(
      process.execPath,
      ["-e", "bad\x00arg"],
      { cwd: process.cwd() },
      () => undefined
    );
    expect(streamed.exitCode).toBe(1);
    expect(streamed.errorCode).toBeDefined();
  });

  it("caps total captured stdout while still streaming every line to the callback", async () => {
    const lines: string[] = [];
    const run = await runExecutableStreamingLines(
      process.execPath,
      ["-e", "for (let i = 0; i < 5; i += 1) process.stdout.write('x'.repeat(10) + '\\n')"],
      { cwd: process.cwd(), stdoutMaxCaptureBytes: 25 },
      (line) => lines.push(line)
    );

    expect(run.exitCode).toBe(0);
    expect(lines).toHaveLength(5);
    expect(run.stdout).toBe(`${"x".repeat(10)}\n${"x".repeat(10)}`);
    expect(run.truncated).toBe(true);
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

  it("cancels buffered child processes through an AbortSignal", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = withRequestCancellation(controller.signal, () => runExecutable(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { cwd: process.cwd() }
    ));
    setTimeout(() => controller.abort(), 50);

    const run = await pending;

    expect(Date.now() - started).toBeLessThan(2000);
    expect(run.cancelled).toBe(true);
    expect(run.timedOut).toBe(false);
  });

  it("cancels streaming child processes through an AbortSignal", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runExecutableStreamingLines(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { cwd: process.cwd(), signal: controller.signal },
      () => undefined
    );
    setTimeout(() => controller.abort(), 50);

    const run = await pending;

    expect(Date.now() - started).toBeLessThan(2000);
    expect(run.cancelled).toBe(true);
    expect(run.timedOut).toBe(false);
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
