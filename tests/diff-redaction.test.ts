import { describe, expect, it } from "@jest/globals";
import { createEnvelope, noteFromRun, redactArgv, redactText, summarizeText } from "../src/envelope.js";
import { createDiffAccumulator, parseDiffText } from "../src/parse/diffText.js";
import { defaultDiffLineLimit, isRevisionRange } from "../src/tools/readonly.js";
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
      per_file_truncated: false,
      diff_excerpt: "Index: streamed.txt\n+one",
      truncated: true
    });
  });

  it("pages streamed diff excerpts without losing complete per-file counts", () => {
    const diff = createDiffAccumulator(2, 2);
    for (const line of ["Index: streamed.txt", "+one", "+two", "-old", "+three"]) {
      diff.pushLine(line);
    }

    expect(diff.summary()).toEqual({
      per_file: [{ path: "streamed.txt", added: 3, removed: 1, binary: false }],
      per_file_truncated: false,
      diff_excerpt: "+two\n-old",
      truncated: true
    });
  });

  it("bounds per-file summaries and reports when more files were omitted", () => {
    const diff = createDiffAccumulator(100, 0, 2);
    for (const line of ["Index: a.txt", "+a", "Index: b.txt", "+b", "Index: c.txt", "+c"]) {
      diff.pushLine(line);
    }

    expect(diff.summary().per_file).toHaveLength(2);
    expect(diff.summary().per_file_truncated).toBe(true);
  });

  it("treats colons inside date selectors as part of one revision, not a range", () => {
    expect(isRevisionRange("42")).toBe(false);
    expect(isRevisionRange("HEAD")).toBe(false);
    expect(isRevisionRange("{2026-07-22T12:00:00Z}")).toBe(false);
    expect(isRevisionRange("{2026-07-22 12:00}")).toBe(false);
    expect(isRevisionRange("41:42")).toBe(true);
    expect(isRevisionRange("HEAD:BASE")).toBe(true);
    expect(isRevisionRange("{2026-07-01}:{2026-07-22T12:00:00Z}")).toBe(true);
  });

  it("caps the diff excerpt by total characters while keeping complete per-file counts", () => {
    const diff = createDiffAccumulator(10, 0, 20000, 40);
    for (const line of ["Index: big.txt", `+${"a".repeat(30)}`, "+short", "-old"]) {
      diff.pushLine(line);
    }

    const summary = diff.summary();
    expect(summary.truncated).toBe(true);
    expect(summary.diff_excerpt).toBe("Index: big.txt");
    expect(summary.per_file).toEqual([{ path: "big.txt", added: 2, removed: 1, binary: false }]);
  });

  it("marks property changes without counting property values as source lines", () => {
    const diff = parseDiffText([
      "Index: settings.txt",
      "===================================================================",
      "Property changes on: settings.txt",
      "___________________________________________________________________",
      "Modified: svn:eol-style",
      "## -1 +1 ##",
      "-LF",
      "+CRLF"
    ].join("\n"), 20);

    expect(diff.per_file).toEqual([{
      path: "settings.txt",
      added: 0,
      removed: 0,
      binary: false,
      property_changed: true
    }]);
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

  it("redacts identity-like URL query parameters", () => {
    const redacted = redactText(
      "https://example.com/repo?user=alice&login=bob&email=alice@example.com&client_id=private-app&x=ok"
    );

    expect(redacted).toBe(
      "https://example.com/repo?user=***&login=***&email=***&client_id=***&x=ok"
    );
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

  it("includes the configured duration in timeout diagnostics", () => {
    expect(noteFromRun({ ...fakeRun(""), timedOut: true, timeoutMs: 60000 })).toBe("svn timed out after 60000 ms");
  });

  it("distinguishes request cancellation from a timeout", () => {
    expect(noteFromRun({ ...fakeRun(""), cancelled: true })).toBe("svn request cancelled");
  });

  it("points agents at the CLI failsafe when the svn executable cannot launch", () => {
    const note = noteFromRun({ ...fakeRun(""), errorCode: "ENOENT" });
    expect(note).toContain("MCP svn runtime unavailable");
    expect(note).toContain("failsafe");
    expect(note).toContain("must never be bypassed");
    expect(noteFromRun(fakeRun("svn: E170001: authorization failed"))).not.toContain("failsafe");
  });

  it("explains non-streaming output overflow without returning a raw runtime error", () => {
    const note = noteFromRun({ ...fakeRun(""), errorCode: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    expect(note).toContain("output exceeded");
    expect(note).toContain("scope paths");
  });

  it("uses a token-conscious default diff excerpt cap", () => {
    const previous = process.env.SVN_AGENT_MAX_DIFF_LINES;
    delete process.env.SVN_AGENT_MAX_DIFF_LINES;
    try {
      expect(defaultDiffLineLimit()).toBe(200);
    } finally {
      if (previous === undefined) delete process.env.SVN_AGENT_MAX_DIFF_LINES;
      else process.env.SVN_AGENT_MAX_DIFF_LINES = previous;
    }
  });

  it("clamps the diff environment override to the public hard limit", () => {
    const previous = process.env.SVN_AGENT_MAX_DIFF_LINES;
    process.env.SVN_AGENT_MAX_DIFF_LINES = "999999";
    try {
      expect(defaultDiffLineLimit()).toBe(2000);
    } finally {
      if (previous === undefined) delete process.env.SVN_AGENT_MAX_DIFF_LINES;
      else process.env.SVN_AGENT_MAX_DIFF_LINES = previous;
    }
  });

  it("caps diagnostic summaries by characters as well as lines", () => {
    const summary = summarizeText("x".repeat(50000));
    expect(summary.text.length).toBeLessThanOrEqual(16000);
    expect(summary.truncated).toBe(true);
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
