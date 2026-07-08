import { describe, expect, it } from "@jest/globals";
import { createEnvelope, noteFromRun, redactArgv, redactText } from "../src/envelope.js";
import { createDiffAccumulator, parseDiffText } from "../src/parse/diffText.js";
import type { RunResult } from "../src/types.js";

describe("diff parsing and command redaction", () => {
  it("keeps complete per-file counts even when the excerpt is truncated", () => {
    const diff = parseDiffText([
      "Index: big.txt",
      "===================================================================",
      "--- big.txt",
      "+++ big.txt",
      "+one",
      "+two",
      "-old",
      " context",
      "+three"
    ].join("\n"), 4);

    expect(diff.truncated).toBe(true);
    expect(diff.diff_excerpt.split("\n")).toHaveLength(4);
    expect(diff.per_file).toEqual([{ path: "big.txt", added: 3, removed: 1, binary: false }]);
  });

  it("counts streamed diff lines after the excerpt cap", () => {
    const diff = createDiffAccumulator(2);
    for (const line of ["Index: streamed.txt", "+one", "+two", "-old", "+three"]) {
      diff.pushLine(line);
    }

    expect(diff.summary()).toEqual({
      per_file: [{ path: "streamed.txt", added: 3, removed: 1, binary: false }],
      diff_excerpt: "Index: streamed.txt\n+one",
      truncated: true
    });
  });

  it("redacts URL userinfo and sensitive query parameters", () => {
    const command = redactArgv("svn", [
      "import",
      "src",
      "https://user:secret@example.com/repo?token=abc123&apikey=def456&x=ok"
    ]);

    expect(command).toContain("https://***:***@example.com/repo?token=***&apikey=***&x=ok");
    expect(command).not.toContain("secret");
    expect(command).not.toContain("abc123");
    expect(command).not.toContain("def456");
  });

  it("redacts inline credential flags and malformed URL userinfo fragments", () => {
    const command = redactArgv("svn", [
      "--password=secret",
      "--username=bob",
      "info",
      "https://user:p@ss@example.com/repo?token=abc123"
    ]);

    expect(command).toContain("--password=***");
    expect(command).toContain("--username=***");
    expect(command).toContain("https://***:***@example.com/repo?token=***");
    expect(command).not.toContain("secret");
    expect(command).not.toContain("bob");
    expect(command).not.toContain("p@ss");
    expect(command).not.toContain("abc123");
  });

  it("redacts URL secrets from stdout and stderr summaries", () => {
    const envelope = createEnvelope({
      ok: false,
      command: "svn info",
      cwd: process.cwd(),
      stdout: "checking https://user:secret@example.com/repo?token=abc123",
      stderr: "failed https://user:secret@example.com/repo?apikey=def456"
    });

    expect(envelope.stdout_summary).toContain("https://***:***@example.com/repo?token=***");
    expect(envelope.stderr_summary).toContain("https://***:***@example.com/repo?apikey=***");
    expect(envelope.stdout_summary).not.toContain("secret");
    expect(envelope.stdout_summary).not.toContain("abc123");
    expect(envelope.stderr_summary).not.toContain("secret");
    expect(envelope.stderr_summary).not.toContain("def456");
  });

  it("redacts reusable text fields such as diff excerpts", () => {
    const redacted = redactText("+https://user:secret@example.com/repo?token=abc123&apikey=def456\n");

    expect(redacted).toContain("https://***:***@example.com/repo?token=***&apikey=***");
    expect(redacted).not.toContain("secret");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("def456");
  });

  it("does not treat user source lines containing binary words as SVN binary markers", () => {
    const diff = parseDiffText([
      "Index: src/a.ts",
      "===================================================================",
      "--- src/a.ts",
      "+++ src/a.ts",
      "@@ -1 +1,2 @@",
      "+const isBinary = true;",
      "+console.log(\"Cannot display in UI\");"
    ].join("\n"), 100);

    expect(diff.per_file).toEqual([{ path: "src/a.ts", added: 2, removed: 0, binary: false }]);
  });

  it("marks exact SVN binary diff messages as binary", () => {
    const diff = parseDiffText([
      "Index: image.bin",
      "===================================================================",
      "Cannot display: file marked as a binary type."
    ].join("\n"), 100);

    expect(diff.per_file).toEqual([{ path: "image.bin", added: 0, removed: 0, binary: true }]);
  });

  it("categorizes common SVN auth, network, lock, and database failures", () => {
    expect(noteFromRun(fakeRun("svn: E215004: No more credentials or we tried too many times"))).toContain("authentication failed");
    expect(noteFromRun(fakeRun("svn: E175002: Unable to connect to a repository"))).toContain("network");
    expect(noteFromRun(fakeRun("svn: E155036: working copy locked"))).toContain("svn_cleanup");
    expect(noteFromRun(fakeRun("svn: E200030: sqlite[S5]: database is locked"))).toContain("database problem");
  });

  it("points agents at the CLI failsafe when the svn executable cannot launch", () => {
    const note = noteFromRun({ ...fakeRun(""), errorCode: "ENOENT" });
    expect(note).toContain("MCP svn runtime unavailable");
    expect(note).toContain("failsafe");
    expect(note).toContain("must never be bypassed");
    expect(noteFromRun(fakeRun("svn: E170001: authorization failed"))).not.toContain("failsafe");
  });
});

function fakeRun(stderr: string): RunResult {
  return {
    command: "svn",
    cwd: process.cwd(),
    executable: "svn",
    args: [],
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr,
    timedOut: false
  };
}
