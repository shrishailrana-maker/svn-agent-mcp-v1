import { describe, expect, it } from "@jest/globals";
import { createEnvelope } from "../src/envelope.js";
import { defaultResponseMode, toToolResult } from "../src/response.js";

describe("public MCP response shaping", () => {
  it("returns a bounded compact status without duplicating the structured payload", () => {
    const root = "E:\\dev\\example";
    const changedPaths = Array.from({ length: 1000 }, (_, index) => ({
      status: index % 5 === 0 ? "A" : "M",
      path: `${root}\\src\\file-${String(index).padStart(4, "0")}.ts`
    }));
    const payload = {
      ...createEnvelope({
        ok: true,
        command: "svn status --xml",
        cwd: root,
        changed_paths: changedPaths,
        stdout: "<status>raw XML that duplicates changed_paths</status>"
      }),
      filtered_paths: []
    };

    const result = toToolResult("svn_status", payload, {
      responseMode: "compact",
      request: { cwd: root, maxItems: 25 }
    });
    const structured = result.structuredContent as Record<string, unknown>;
    const items = structured.items as Array<Record<string, unknown>>;

    expect(structured.counts).toEqual({ added: 200, modified: 800 });
    expect(items).toHaveLength(25);
    expect(items[0]).toEqual({ path: "src/file-0000.ts", status: "added" });
    expect(structured.truncated).toBe(true);
    expect(structured.nextCursor).toBe("25");
    expect(structured).not.toHaveProperty("stdout_summary");
    expect(result.content).toEqual([]);
    const humanText = toToolResult("svn_status", payload, {
      responseMode: "compact",
      request: { cwd: root, maxItems: 25, humanText: true }
    });
    expect(humanText.content[0]?.text).toBe("OK svn_status: 1000 changes; 25 returned; more available");
    expect(humanText.content[0]?.text).not.toContain("file-0000.ts");

    const legacyChars = JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload
    }).length;
    expect(JSON.stringify(result).length).toBeLessThan(legacyChars * 0.4);
    expect(structured).not.toHaveProperty("root");

    const countOnly = toToolResult("svn_status", payload, {
      responseMode: "compact",
      request: { countOnly: true }
    }).structuredContent;
    expect(countOnly.items).toEqual([]);
    expect(countOnly.truncated).toBe(false);
    expect(countOnly).not.toHaveProperty("nextCursor");

    const uncommonStatuses = toToolResult("svn_status", {
      ...payload,
      changed_paths: [
        { status: "_M", path: "src/props.txt" },
        { status: "I", path: "scratch/ignored.txt" }
      ]
    }, { responseMode: "compact" }).structuredContent;
    expect(uncommonStatuses.counts).toEqual({ "property-modified": 1, ignored: 1 });

    const ignoredDescendant = toToolResult("svn_status", {
      ...payload,
      note: "svn: warning: W155010: node was not found",
      stderr_summary: "svn: warning: W155010: node was not found",
      changed_paths: [{
        status: "I",
        path: `${root}\\waste space\\nested\\report.txt`,
        covered_by_ignored_ancestor: true,
        ignored_ancestor: "waste space"
      }]
    }, { responseMode: "compact", request: { cwd: root } });
    expect(ignoredDescendant.structuredContent.items).toEqual([{
      path: "waste space/nested/report.txt",
      status: "ignored",
      coveredByIgnoredAncestor: true,
      ignoredAncestor: "waste space"
    }]);
    expect(JSON.stringify(ignoredDescendant).match(/W155010/g)).toHaveLength(1);

    const subdirectoryStatus = toToolResult("svn_status", {
      ...createEnvelope({
        ok: true,
        command: "svn status --xml",
        cwd: `${root}\\src`,
        changed_paths: [{ status: "M", path: "nested\\file.ts" }]
      }),
      wc_root: root
    }, { responseMode: "compact", request: { cwd: `${root}\\src` } }).structuredContent;
    expect(subdirectoryStatus.items).toEqual([{ path: "src/nested/file.ts", status: "modified" }]);
  });

  it("keeps bounded diagnostics without the empty legacy envelope on compact failures", () => {
    const payload = createEnvelope({
      ok: false,
      command: "svn status --xml",
      cwd: "E:\\dev\\example",
      stdout: "partial status",
      stderr: "svn: E170001: authorization failed",
      note: "authentication failed"
    });

    const result = toToolResult("svn_status", payload, { responseMode: "compact" });
    const structured = result.structuredContent as Record<string, unknown>;

    expect(structured).toEqual({
      ok: false,
      note: "authentication failed",
      stdout: "partial status",
      stderr: "svn: E170001: authorization failed"
    });
    expect(structured).not.toHaveProperty("command");
    expect(structured).not.toHaveProperty("cwd");
    expect(structured).not.toHaveProperty("changed_paths");
    expect(result.content).toEqual([]);
    const humanText = toToolResult("svn_status", payload, {
      responseMode: "compact",
      request: { humanText: true }
    });
    expect(humanText.content[0]?.text).toBe("ERROR svn_status: authentication failed");
  });

  it("returns typed compact guard refusals without echoing submitted path lists", () => {
    const root = "E:\\dev\\example";
    const submitted = Array.from({ length: 500 }, (_, index) => `${root}\\src\\file-${index}.key`);
    const payload = createEnvelope({
      ok: false,
      command: `svn add -- ${submitted.join(" ")}`,
      cwd: root,
      stdout: submitted.join("\n"),
      stderr: submitted.join("\n"),
      note: "never-commit path matches **/*.key: src/file-0.key"
    });

    const compact = toToolResult("svn_add", payload, {
      responseMode: "compact",
      request: { paths: submitted }
    }).structuredContent;
    expect(compact).toEqual({
      ok: false,
      guardCode: "NEVER_COMMIT",
      note: "never-commit path matches **/*.key: src/file-0.key",
      affectedPathCount: 500,
      truncated: true
    });
    expect(JSON.stringify(compact)).not.toContain("file-499.key");
  });

  it("bounds secondary compact collections and reports omitted counts", () => {
    const root = "E:\\dev\\example";
    const conflicts = Array.from({ length: 150 }, (_, index) => ({
      path: `${root}\\src\\file-${index}.ts`,
      type: "text"
    }));
    const status = toToolResult("svn_status", createEnvelope({
      ok: true,
      command: "svn status --xml",
      cwd: root,
      changed_paths: conflicts.map((item) => ({ status: "C", path: item.path })),
      conflicts
    }), {
      responseMode: "compact",
      request: { cwd: root, maxItems: 1 }
    }).structuredContent;
    expect(status.conflicts as unknown[]).toHaveLength(100);
    expect(status.conflictCount).toBe(150);
    expect(status.conflictsTruncated).toBe(true);

    const precommit = toToolResult("svn_precommit", {
      ...createEnvelope({ ok: false, command: "svn_precommit", cwd: root, note: "GUARD_BLOCKED" }),
      verdict: "GUARD_BLOCKED",
      per_file: Array.from({ length: 150 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        status: "?",
        added: 0,
        removed: 0,
        guard: `src/file-${index}.ts: blocked`
      }))
    }, {
      responseMode: "compact",
      request: { paths: Array.from({ length: 150 }, (_, index) => `src/file-${index}.ts`) }
    }).structuredContent;
    expect(precommit.guardFailures).toEqual(["src/file-0.ts: blocked"]);
    expect(precommit.guardFailureCount).toBe(150);
    expect(precommit.guardFailuresTruncated).toBe(true);

    const updateCwd = `${root}\\src`;
    const update = toToolResult("svn_update", {
      ...createEnvelope({
        ok: true,
        command: "svn update",
        cwd: updateCwd,
        revision: 42,
        changed_paths: Array.from({ length: 150 }, (_, index) => ({
          status: "U",
          path: `updated-${index}.ts`
        })),
        conflicts
      }),
      wc_root: root,
      requested_revision: "42",
      resulting_revision: 42,
      revision_range: { min: 42, max: 42 },
      mixed_revision: false,
      expected_remote_head: 42,
      observed_remote_head: 42
    }, { responseMode: "compact" }).structuredContent;
    expect(update.conflicts as unknown[]).toHaveLength(100);
    expect(update.conflictCount).toBe(150);
    expect(update.conflictsTruncated).toBe(true);
    expect(update.changedPaths as unknown[]).toHaveLength(100);
    expect((update.changedPaths as Array<Record<string, unknown>>)[0]).toEqual({
      path: "src/updated-0.ts",
      status: "updated"
    });
    expect(update.changedPathCount).toBe(150);
    expect(update.changedPathsTruncated).toBe(true);
    expect(update).toMatchObject({
      requestedRevision: "42",
      resultingRevision: 42,
      revisionRange: { min: 42, max: 42 },
      mixedRevision: false,
      expectedRemoteHead: 42,
      observedRemoteHead: 42
    });

    const staleUpdate = toToolResult("svn_update", {
      ...createEnvelope({ ok: false, command: "svn update", cwd: root, note: "remote HEAD changed" }),
      expected_remote_head: 42,
      observed_remote_head: 43
    }, { responseMode: "compact" }).structuredContent;
    expect(staleUpdate).toMatchObject({ ok: false, expectedRemoteHead: 42, observedRemoteHead: 43 });
  });

  it("preserves the legacy full response only when full mode is requested", () => {
    const payload = createEnvelope({
      ok: true,
      command: "svn log --xml -l 1",
      cwd: "E:\\dev\\example",
      stdout: "<log>raw</log>"
    });

    const compact = toToolResult("svn_log", payload, { responseMode: "standard" });
    const full = toToolResult("svn_log", payload, { responseMode: "full" });

    expect(compact.structuredContent.stdout_summary).toBe("");
    expect(compact.content).toEqual([]);
    expect(full.structuredContent.stdout_summary).toBe("<log>raw</log>");
    expect(full.content).toEqual([]);
    expect(toToolResult("svn_log", payload, {
      responseMode: "full",
      request: { humanText: true }
    }).content[0]?.text).toBe(JSON.stringify(payload, null, 2));
  });

  it("redacts parsed fields in standard and full responses", () => {
    const payload = {
      ...createEnvelope({ ok: true, command: "svn log --xml", cwd: "E:\\dev\\example" }),
      entries: [{
        rev: 42,
        author: "user",
        date: "2026-07-20T00:00:00Z",
        msg: "See https://user:secret@example.com/repo?token=abc123",
        changed_paths: [{ status: "M", path: "/trunk/file.txt?apikey=def456" }]
      }]
    };

    for (const responseMode of ["standard", "full"] as const) {
      const serialized = JSON.stringify(toToolResult("svn_log", payload, { responseMode }));
      expect(serialized).not.toContain("secret");
      expect(serialized).not.toContain("abc123");
      expect(serialized).not.toContain("def456");
    }
  });

  it("keeps an SVN warning once without restoring successful raw stdout", () => {
    const result = toToolResult("svn_status", createEnvelope({
      ok: true,
      command: "svn status --xml",
      cwd: "E:\\dev\\example",
      stdout: "<status />",
      stderr: "svn: warning: repository redirected"
    }), { responseMode: "compact", request: { cwd: "E:\\dev\\example" } });

    expect(result.structuredContent.warning).toBe("svn: warning: repository redirected");
    expect(result.structuredContent).not.toHaveProperty("stdout_summary");
    expect(JSON.stringify(result).match(/repository redirected/g)).toHaveLength(1);
  });

  it("uses the server response-mode override and otherwise defaults to compact", () => {
    expect(defaultResponseMode({})).toBe("compact");
    expect(defaultResponseMode({ SVN_MCP_RESPONSE_MODE: "standard" })).toBe("standard");
    expect(defaultResponseMode({ SVN_MCP_RESPONSE_MODE: "full" })).toBe("full");
    expect(defaultResponseMode({ SVN_MCP_RESPONSE_MODE: "receipt" })).toBe("receipt");
    expect(defaultResponseMode({ SVN_MCP_RESPONSE_MODE: "structured-only" })).toBe("structured-only");
    expect(defaultResponseMode({ SVN_MCP_RESPONSE_MODE: "invalid" })).toBe("compact");
  });

  it("returns explicit structured-only and minimal receipt contracts", () => {
    const root = "E:\\dev\\example";
    const payload = {
      ...createEnvelope({
        ok: true,
        command: "svn status --xml",
        cwd: root,
        revision: 42,
        changed_paths: [
          { status: "M", path: `${root}\\src\\a.ts` },
          { status: "A", path: `${root}\\src\\b.ts` }
        ],
        conflicts: [{ path: `${root}\\src\\a.ts`, type: "text" }]
      }),
      wc_root: root,
      remote_head_revision: 43,
      operation_id: "op-123"
    };

    const structuredOnly = toToolResult("svn_status", payload, {
      responseMode: "structured-only",
      request: { cwd: root }
    });
    expect(structuredOnly.content).toEqual([]);
    expect(structuredOnly.structuredContent).toMatchObject({
      ok: true,
      counts: { modified: 1, added: 1 },
      items: [
        { path: "src/a.ts", status: "modified" },
        { path: "src/b.ts", status: "added" }
      ]
    });

    const receipt = toToolResult("svn_status", payload, {
      responseMode: "receipt",
      request: { cwd: root }
    });
    expect(receipt.content).toEqual([]);
    expect(receipt.structuredContent).toEqual({
      ok: true,
      baseRevision: 42,
      remoteHeadRevision: 43,
      changedPaths: ["src/a.ts", "src/b.ts"],
      conflictCount: 1,
      operationId: "op-123"
    });
    expect(JSON.stringify(receipt)).not.toContain(root);
  });

  it("continues receipt path pages from the requested cursor", () => {
    const root = "E:\\dev\\example";
    const payload = {
      ...createEnvelope({
        ok: true,
        command: "svn status --xml",
        cwd: root,
        revision: 42,
        changed_paths: Array.from({ length: 30 }, (_, index) => ({
          status: "M",
          path: `${root}\\src\\file-${index}.ts`
        }))
      }),
      wc_root: root
    };

    const first = toToolResult("svn_status", payload, {
      responseMode: "receipt",
      request: { maxItems: 25 }
    }).structuredContent;
    const second = toToolResult("svn_status", payload, {
      responseMode: "receipt",
      request: { maxItems: 25, cursor: "25" }
    }).structuredContent;

    expect(first.changedPaths).toHaveLength(25);
    expect(first.nextCursor).toBe("25");
    expect(second.changedPaths).toEqual([
      "src/file-25.ts", "src/file-26.ts", "src/file-27.ts", "src/file-28.ts", "src/file-29.ts"
    ]);
    expect(second).not.toHaveProperty("nextCursor");
  });

  it("returns bounded receipts for snapshot, precommit, update, and commit", () => {
    const root = "E:\\dev\\example";
    const changed = [{ status: "M", path: `${root}\\src\\a.ts` }];
    const snapshot = toToolResult("svn_snapshot", {
      ...createEnvelope({ ok: true, command: "snapshot", cwd: root, revision: 40, changed_paths: changed }),
      wc_root: root,
      remote_head_revision: 43
    }, { responseMode: "receipt" }).structuredContent;
    expect(snapshot).toEqual({
      ok: true,
      baseRevision: 40,
      remoteHeadRevision: 43,
      changedPaths: ["src/a.ts"],
      conflictCount: 0
    });

    const precommit = toToolResult("svn_precommit", {
      ...createEnvelope({ ok: true, command: "precommit", cwd: root, revision: 40, changed_paths: changed }),
      wc_root: root,
      verdict: "READY",
      remote_head_revision: 43,
      per_file: [{ path: "src/a.ts", added: 4, removed: 2 }]
    }, { responseMode: "receipt" }).structuredContent;
    expect(precommit).toEqual({
      ok: true,
      verdict: "READY",
      baseRevision: 40,
      remoteHeadRevision: 43,
      changedPaths: ["src/a.ts"],
      conflictCount: 0,
      added: 4,
      removed: 2
    });

    const update = toToolResult("svn_update", {
      ...createEnvelope({ ok: true, command: "update", cwd: root, revision: 44, changed_paths: changed }),
      wc_root: root,
      resulting_revision: 44,
      observed_remote_head: 44
    }, { responseMode: "receipt" }).structuredContent;
    expect(update).toEqual({
      ok: true,
      resultingRevision: 44,
      remoteHeadRevision: 44,
      changedPaths: ["src/a.ts"],
      conflictCount: 0
    });

    const commit = toToolResult("svn_commit", {
      ...createEnvelope({ ok: true, command: "commit", cwd: root, revision: 45 }),
      wc_root: root,
      committed_revision: 45,
      committed_paths: ["src/a.ts"],
      base_revision: 44,
      remote_head_revision: 45,
      operation_id: "commit-45"
    }, { responseMode: "receipt" }).structuredContent;
    expect(commit).toEqual({
      ok: true,
      baseRevision: 44,
      committedRevision: 45,
      remoteHeadRevision: 45,
      changedPaths: ["src/a.ts"],
      conflictCount: 0,
      operationId: "commit-45"
    });
    for (const result of [snapshot, precommit, update, commit]) {
      expect(JSON.stringify(result).length).toBeLessThan(400);
      expect(JSON.stringify(result)).not.toContain(root);
    }
  });

  it("uses relative paths and validated projections outside full diagnostics", () => {
    const root = "E:\\dev\\example";
    const payload = {
      ...createEnvelope({
        ok: true,
        command: `svn status --xml -- ${root}\\src\\a.ts`,
        cwd: root,
        revision: 42,
        changed_paths: [{ status: "M", path: `${root}\\src\\a.ts` }],
        conflicts: [{ path: `${root}\\src\\a.ts`, type: "text" }]
      }),
      wc_root: root,
      remote_head_revision: 43
    };

    const standard = toToolResult("svn_status", payload, {
      responseMode: "standard",
      request: { fields: ["revision", "changedPaths", "conflicts"] }
    }).structuredContent;
    expect(standard).toEqual({
      ok: true,
      revision: 42,
      changedPaths: [{ status: "M", path: "src/a.ts" }],
      conflicts: [{ path: "src/a.ts", type: "text" }]
    });
    expect(JSON.stringify(standard)).not.toContain(root);
  });

  it("reserves absolute machine paths for full diagnostics", () => {
    const root = "E:\\dev\\example with spaces";
    const payload = {
      ...createEnvelope({
        ok: true,
        command: `svn status --xml -- ${root}\\src\\a.ts`,
        cwd: root,
        revision: 42,
        stderr: `svn: warning: ${root}\\src\\a.ts was skipped`,
        changed_paths: [{ status: "M", path: `${root}\\src\\a.ts` }]
      }),
      wc_root: root
    };

    for (const responseMode of ["compact", "receipt", "structured-only", "standard"] as const) {
      const result = toToolResult("svn_status", payload, { responseMode }).structuredContent;
      expect(JSON.stringify(result)).not.toContain(root);
    }
    expect(toToolResult("svn_status", payload, {
      responseMode: "full"
    }).structuredContent.cwd).toBe(root);

    const batchFix = toToolResult("eol_fix_verified", {
      ...createEnvelope({ ok: false, command: "unix2dos", cwd: root, note: "one file failed" }),
      wc_root: root,
      batch: true,
      counts: { requested: 1, fixed: 0, failed: 1 },
      files: [{ ok: false, path: `${root}\\src\\a.ts`, failure: "conversion failed" }]
    }, { responseMode: "compact" }).structuredContent;
    expect(batchFix.failures).toEqual([{
      path: "src/a.ts",
      before: undefined,
      after: undefined,
      failure: "conversion failed"
    }]);
    expect(JSON.stringify(batchFix)).not.toContain(root);
  });

  it("keeps compact log entries bounded and omits verbose fields by default", () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({
      rev: 200 - index,
      author: "developer",
      date: "2026-07-20T00:00:00.000Z",
      msg: `Change ${index}\nLong message body ${"x".repeat(200)}`,
      changed_paths: Array.from({ length: 20 }, (__, pathIndex) => ({ status: "M", path: `/src/file-${pathIndex}.ts` }))
    }));
    const payload = {
      ...createEnvelope({ ok: true, command: "svn log --xml -l 100 -v", cwd: "E:\\dev\\example" }),
      entries,
      target_mode: "repository-url"
    };

    const result = toToolResult("svn_log", payload, {
      responseMode: "compact",
      request: { limit: 10 }
    });
    const structured = result.structuredContent as Record<string, unknown>;
    const compactEntries = structured.entries as Array<Record<string, unknown>>;

    expect(compactEntries).toHaveLength(10);
    expect(compactEntries[0]).toEqual({
      revision: 200,
      author: "developer",
      date: "2026-07-20T00:00:00.000Z",
      message: "Change 0"
    });
    expect(structured.truncated).toBe(true);
    expect(structured.nextCursor).toBe("190");
    expect(JSON.stringify(result)).not.toContain("Long message body");
    expect(JSON.stringify(result)).not.toContain("changed_paths");
    expect(structured).not.toHaveProperty("targetMode");

    const ranged = toToolResult("svn_log", {
      ...payload,
      revision: null,
      revision_range: { min: 191, max: 200 },
      entry_count: 10,
      entries: entries.slice(0, 10),
      has_more: false
    }, { responseMode: "compact", request: { limit: 10, revision: "200:191" } }).structuredContent;
    expect(ranged).toMatchObject({ revision: null, revisionRange: { min: 191, max: 200 }, entryCount: 10 });

    const exactPage = toToolResult("svn_log", { ...payload, entries: entries.slice(0, 10), has_more: false }, {
      responseMode: "compact",
      request: { limit: 10 }
    }).structuredContent;
    expect(exactPage.truncated).toBe(false);
    expect(exactPage).not.toHaveProperty("nextCursor");

    const boundedDetails = toToolResult("svn_log", payload, {
      responseMode: "compact",
      request: {
        limit: 1,
        fullMessage: true,
        changedPaths: true,
        maxMessageChars: 64,
        maxChangedPaths: 2
      }
    }).structuredContent as Record<string, unknown>;
    const boundedEntry = (boundedDetails.entries as Array<Record<string, unknown>>)[0];
    expect(String(boundedEntry?.message).length).toBe(64);
    expect(boundedEntry?.messageTruncated).toBe(true);
    expect(boundedEntry?.changedPaths as unknown[]).toHaveLength(2);
    expect(boundedEntry?.changedPathsTruncated).toBe(true);
  });

  it("keeps the requested revision-range floor when paginating svn_log", () => {
    const entries = Array.from({ length: 11 }, (_, index) => ({
      rev: 200 - index,
      author: "developer",
      date: "2026-07-22T00:00:00.000Z",
      msg: `Change ${index}`,
      changed_paths: []
    }));
    const payload = {
      ...createEnvelope({ ok: true, command: "svn log --xml", cwd: "E:\\dev\\example" }),
      entries,
      has_more: true,
      target_mode: "repository-url"
    };

    const ranged = toToolResult("svn_log", payload, {
      responseMode: "compact",
      request: { limit: 10, revision: "200:150" }
    }).structuredContent as Record<string, unknown>;
    expect(ranged.truncated).toBe(true);
    expect(ranged.nextCursor).toBe("190:150");

    const cursorContinued = toToolResult("svn_log", payload, {
      responseMode: "compact",
      request: { limit: 10, cursor: "200:150" }
    }).structuredContent as Record<string, unknown>;
    expect(cursorContinued.nextCursor).toBe("190:150");

    const singleRevision = toToolResult("svn_log", payload, {
      responseMode: "compact",
      request: { limit: 10, revision: "HEAD" }
    }).structuredContent as Record<string, unknown>;
    expect(singleRevision.truncated).toBe(true);
    expect(singleRevision).not.toHaveProperty("nextCursor");

    const ascendingRange = toToolResult("svn_log", payload, {
      responseMode: "compact",
      request: { limit: 10, revision: "150:200" }
    }).structuredContent as Record<string, unknown>;
    expect(ascendingRange).not.toHaveProperty("nextCursor");

    const exhaustedRange = toToolResult("svn_log", {
      ...payload,
      entries: [{ rev: 150, author: "developer", date: "2026-07-22T00:00:00.000Z", msg: "Floor", changed_paths: [] }]
    }, {
      responseMode: "compact",
      request: { limit: 10, revision: "200:150" }
    }).structuredContent as Record<string, unknown>;
    expect(exhaustedRange).not.toHaveProperty("nextCursor");
  });

  it("returns summary-only or bounded diff output and always marks continuation", () => {
    const excerpt = [
      "Index: src/example.ts",
      "===================================================================",
      "--- src/example.ts",
      "+++ src/example.ts",
      "@@ -1,2 +1,2 @@",
      `-${"a".repeat(180)}`,
      `+${"b".repeat(180)}`,
      "@@ -10,2 +10,2 @@",
      `-${"c".repeat(180)}`,
      `+${"d".repeat(180)}`
    ].join("\n");
    const payload = {
      ...createEnvelope({ ok: true, command: "svn diff", cwd: "E:\\dev\\example", truncated: true }),
      per_file: [{ path: "src/example.ts", added: 2, removed: 2, binary: false }],
      diff_excerpt: excerpt,
      ignore_eol: true
    };

    const summary = toToolResult("svn_diff", payload, {
      responseMode: "compact",
      request: { diffMode: "summary" }
    }).structuredContent as Record<string, unknown>;
    expect(summary).not.toHaveProperty("excerpt");
    expect(summary.files).toEqual(payload.per_file);
    expect(summary.truncated).toBe(false);
    expect(summary).not.toHaveProperty("nextCursor");

    const cappedSummary = toToolResult("svn_diff", { ...payload, per_file_truncated: true }, {
      responseMode: "compact",
      request: { diffMode: "summary" }
    }).structuredContent;
    expect(cappedSummary.fileSummaryTruncated).toBe(true);
    expect(cappedSummary.truncated).toBe(true);
    expect(cappedSummary).not.toHaveProperty("nextFileCursor");

    const compact = toToolResult("svn_diff", payload, {
      responseMode: "compact",
      request: { diffMode: "compact", maxChars: 400, maxHunksPerFile: 1 }
    }).structuredContent as Record<string, unknown>;
    expect(String(compact.excerpt).length).toBeLessThanOrEqual(400);
    expect(compact.truncated).toBe(true);
    expect(compact.nextCursor).toMatch(/^\d+$/);
    expect(String(compact.excerpt)).toContain("@@ -1,2 +1,2 @@");
    expect(String(compact.excerpt)).not.toContain("@@ -10,2 +10,2 @@");

    const longLinePayload = { ...payload, diff_excerpt: `+${"x".repeat(1000)}`, truncated: false };
    const longLine = toToolResult("svn_diff", longLinePayload, {
      responseMode: "compact",
      request: { maxChars: 256 }
    }).structuredContent;
    expect(String(longLine.excerpt).length).toBe(256);
    expect(longLine.lineTruncated).toBe(true);
    expect(longLine.truncated).toBe(true);
    expect(longLine).not.toHaveProperty("nextCursor");

    const manyFiles = toToolResult("svn_diff", {
      ...payload,
      per_file: Array.from({ length: 600 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        added: 1,
        removed: 0,
        binary: false
      })),
      truncated: false
    }, {
      responseMode: "compact",
      request: { diffMode: "summary", maxFiles: 10, fileCursor: "10" }
    }).structuredContent;
    expect(manyFiles.files as unknown[]).toHaveLength(10);
    expect((manyFiles.files as Array<Record<string, unknown>>)[0]?.path).toBe("src/file-10.ts");
    expect(manyFiles.totalFiles).toBe(600);
    expect(manyFiles.filesTruncated).toBe(true);
    expect(manyFiles.nextFileCursor).toBe("20");
  });

  it("keeps compact full-diff JSON-RPC records within the transport budget", () => {
    const longDirectory = "nested/".repeat(40);
    const payload = {
      ...createEnvelope({
        ok: true,
        command: "svn diff",
        cwd: "E:\\dev\\example"
      }),
      per_file: Array.from({ length: 500 }, (_, index) => ({
        path: `src/${longDirectory}file-${index}.ts`,
        added: 1,
        removed: 1,
        binary: false
      })),
      per_file_truncated: false,
      diff_excerpt: Array.from(
        { length: 4_000 },
        (_, index) => `@@ -${index + 1},1 +${index + 1},1 @@\n+${"x".repeat(400)}`
      ).join("\n"),
      truncated: false,
      page_offset: 0,
      ignore_eol: true
    };

    const result = toToolResult("svn_diff", payload, {
      responseMode: "compact",
      request: {
        diffMode: "full",
        maxChars: 64_000,
        maxFiles: 500
      }
    });
    const structured = result.structuredContent as Record<string, unknown>;
    const jsonRpcRecord = `${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n`;

    expect(Buffer.byteLength(jsonRpcRecord, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(jsonRpcRecord.slice(0, -1)).not.toContain("\n");
    expect(structured.truncated).toBe(true);
    expect(structured.nextCursor).toMatch(/^\d+$/);
    expect(structured.filesTruncated).toBe(true);
    expect(structured.nextFileCursor).toMatch(/^\d+$/);

    const escapedPayload = {
      ...payload,
      per_file: [{
        path: `src/${"\u0001".repeat(4_000)}`,
        added: 1,
        removed: 1,
        binary: false
      }],
      diff_excerpt: `+${"\u0002".repeat(64_000)}`
    };
    const escapedResult = toToolResult("svn_diff", escapedPayload, {
      responseMode: "compact",
      request: {
        diffMode: "full",
        maxChars: 64_000,
        maxFiles: 500
      }
    });
    const escapedRecord = `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: escapedResult })}\n`;
    expect(Buffer.byteLength(escapedRecord, "utf8")).toBeLessThanOrEqual(32 * 1024);
  });

  it("returns only EOL failures unless passing files are requested", () => {
    const payload = {
      ...createEnvelope({ ok: true, command: "eol_check", cwd: "E:\\dev\\example" }),
      files: [
        { path: "E:\\dev\\example\\good.ts", kind: "crlf", eol_style: "native", has_bom: false, size: 10, sniff: "ok", mismatch: false },
        { path: "E:\\dev\\example\\bad.ts", kind: "lf", eol_style: "CRLF", has_bom: false, size: 10, sniff: "ok", mismatch: true },
        { path: "E:\\dev\\example\\large.ts", kind: "skipped-too-large", eol_style: "native", has_bom: false, size: 6000000, sniff: "skipped-too-large", mismatch: false }
      ]
    };

    const compact = toToolResult("eol_check", payload, { responseMode: "compact" }).structuredContent as Record<string, unknown>;
    const failures = compact.files as Array<Record<string, unknown>>;

    expect(compact.counts).toEqual({ passed: 1, failed: 1, skipped: 1 });
    expect(failures).toEqual([
      { path: "bad.ts", expected: "CRLF", detected: "lf", remediation: "run eol_fix_verified" },
      { path: "large.ts", expected: "native", detected: "skipped-too-large", remediation: "inspect file manually" }
    ]);

    const manyFilesPayload = {
      ...payload,
      files: Array.from({ length: 300 }, (_, index) => ({
        path: `E:\\dev\\example\\file-${index}.ts`,
        kind: "crlf",
        eol_style: "native",
        sniff: "ok",
        mismatch: false
      }))
    };
    const page = toToolResult("eol_check", manyFilesPayload, {
      responseMode: "compact",
      request: { includePassing: true, maxItems: 10, cursor: "10" }
    }).structuredContent;
    expect(page.files as unknown[]).toHaveLength(10);
    expect(page.truncated).toBe(true);
    expect(page.nextCursor).toBe("20");
  });

  it("makes precommit and mutation success receipts authoritative without raw command echoes", () => {
    const precommitPayload = {
      ...createEnvelope({
        ok: true,
        command: "svn_precommit",
        cwd: "E:\\dev\\example",
        changed_paths: [{ status: "M", path: "E:\\dev\\example\\src\\a.ts" }],
        note: "READY"
      }),
      verdict: "READY",
      per_file: [{
        path: "src/a.ts",
        status: "M",
        added: 3,
        removed: 1,
        eol: "crlf",
        eol_style: "native",
        eol_mismatch: false,
        bom: false,
        pure_eol_churn: false,
        guard: null
      }],
      risk_signals: ["build-system file touched"],
      mixed_revision: false,
      diff_excerpt: "+large source line that should not be in compact precommit"
    };
    const precommit = toToolResult("svn_precommit", precommitPayload, {
      responseMode: "compact",
      request: { paths: ["src/a.ts"] }
    }).structuredContent as Record<string, unknown>;

    expect(precommit.ready).toBe(true);
    expect(precommit.pathCount).toBe(1);
    expect(precommit).not.toHaveProperty("intendedPaths");
    expect(precommit.statusCounts).toEqual({ modified: 1 });
    expect(precommit.diff).toEqual({ files: 1, added: 3, removed: 1, truncated: false });
    expect(precommit.eol).toEqual({ ok: true });
    expect(precommit).not.toHaveProperty("properties");
    expect(precommit.mixedRevision).toBe(false);
    expect(precommit).not.toHaveProperty("guardFailures");
    expect(precommit.riskSignals).toEqual(["build-system file touched"]);
    expect(precommit).not.toHaveProperty("diff_excerpt");

    const blocked = toToolResult("svn_precommit", {
      ...createEnvelope({
        ok: false,
        command: "svn_precommit",
        cwd: "E:\\dev\\example",
        stderr: "blocked by policy",
        note: "BLOCKED"
      }),
      verdict: "BLOCKED",
      per_file: [{
        path: "src/private.key",
        status: "?",
        added: 0,
        removed: 0,
        eol_mismatch: false,
        pure_eol_churn: false,
        guard: "src/private.key: blocked by never-commit rule"
      }]
    }, {
      responseMode: "compact",
      request: { paths: ["src/private.key"] }
    }).structuredContent;
    expect(blocked).toEqual({
      ok: false,
      ready: false,
      verdict: "BLOCKED",
      pathCount: 1,
      statusCounts: { unversioned: 1 },
      diff: { files: 0, added: 0, removed: 0, truncated: false },
      eol: { ok: true },
      mixedRevision: false,
      guardCode: "NEVER_COMMIT",
      guardFailures: ["src/private.key: blocked by never-commit rule"],
      note: "BLOCKED"
    });

    const unavailable = toToolResult("svn_precommit", {
      ...createEnvelope({
        ok: false,
        command: "svn_precommit",
        cwd: "E:\\dev\\example",
        stderr: "svn executable unavailable",
        note: "MCP svn runtime unavailable"
      }),
      verdict: "GUARD_BLOCKED",
      per_file: [],
      risk_signals: [],
      diff_excerpt: ""
    }, {
      responseMode: "compact",
      request: { paths: ["src/a.ts"] }
    }).structuredContent;
    expect(unavailable).toEqual({
      ok: false,
      ready: false,
      verdict: "GUARD_BLOCKED",
      pathCount: 1,
      note: "MCP svn runtime unavailable",
      stderr: "svn executable unavailable"
    });

    const precommitWithDiff = toToolResult("svn_precommit", {
      ...precommitPayload,
      diff_excerpt: "+".repeat(1000)
    }, {
      responseMode: "compact",
      request: { paths: ["src/a.ts"], includeDiff: true, maxChars: 256 }
    }).structuredContent;
    expect(String(precommitWithDiff.diffExcerpt).length).toBe(256);
    expect(precommitWithDiff.diffExcerptTruncated).toBe(true);

    const movePayload = createEnvelope({
      ok: true,
      command: "svn move --parents E:\\dev\\example\\docs\\old.md E:\\dev\\example\\docs\\new.md",
      cwd: "E:\\dev\\example",
      changed_paths: [
        { status: "D", path: "docs/old.md" },
        { status: "A", path: "docs/new.md" }
      ],
      stdout: "A         docs/new.md\nD         docs/old.md"
    });
    const move = toToolResult("svn_move", movePayload, {
      responseMode: "compact",
      request: { src: "docs/old.md", dest: "docs/new.md" }
    }).structuredContent;

    expect(move).toEqual({
      ok: true,
      action: "move",
      source: "docs/old.md",
      target: "docs/new.md",
      verifiedStatus: "renamed"
    });

    const pathChange = toToolResult("svn_path_change", movePayload, {
      responseMode: "compact",
      request: { action: "copy", src: "docs/old.md", dest: "docs/copy.md" }
    }).structuredContent;
    expect(pathChange).toEqual({
      ok: true,
      action: "copy",
      source: "docs/old.md",
      target: "docs/copy.md",
      verifiedStatus: "copied"
    });

    const imported = toToolResult("svn_import", createEnvelope({
      ok: true,
      command: "svn import",
      cwd: "E:\\dev\\example",
      revision: 43
    }), {
      responseMode: "compact",
      request: {
        src: "source",
        url: "https://user:secret@example.com/repo?token=abc123"
      }
    }).structuredContent;
    expect(imported).toEqual({
      ok: true,
      action: "import",
      source: "source",
      target: "https://***:***@example.com/repo?token=***",
      revision: 43,
      status: "imported"
    });
    expect(JSON.stringify(imported)).not.toContain("secret");
    expect(JSON.stringify(imported)).not.toContain("abc123");

    const add = toToolResult("svn_add", createEnvelope({ ok: true, command: "svn add", cwd: "E:\\dev\\example" }), {
      responseMode: "compact",
      request: { paths: ["src/new.ts"] }
    }).structuredContent;
    expect(add).toEqual({ ok: true, action: "add", status: "added" });

    const eolFix = toToolResult("eol_fix_verified", {
      ...createEnvelope({ ok: true, command: "unix2dos", cwd: "E:\\dev\\example" }),
      before: { kind: "lf", has_bom: true },
      after: { kind: "crlf", has_bom: false },
      target: "crlf",
      pure_eol_churn: true
    }, {
      responseMode: "compact",
      request: { path: "src/a.ts" }
    }).structuredContent;
    expect(eolFix).toEqual({
      ok: true,
      action: "eol_fix_verified",
      path: "src/a.ts",
      target: "crlf",
      before: { kind: "lf", hasBom: true },
      after: { kind: "crlf", hasBom: false },
      pureEolChurn: true,
      verified: true
    });

    const revertPreview = toToolResult("svn_revert", createEnvelope({
      ok: true,
      command: "svn_revert",
      cwd: "E:\\dev\\example",
      changed_paths: [{ status: "M", path: "src/a.ts" }]
    }), {
      responseMode: "compact",
      request: { paths: ["src/a.ts"], dryRun: true }
    }).structuredContent;
    expect(revertPreview).toEqual({ ok: true, action: "revert", dryRun: true, counts: { modified: 1 } });

    const defaultRevertPreview = toToolResult("svn_revert", createEnvelope({
      ok: true,
      command: "svn revert --dry-run",
      cwd: "E:\\dev\\example",
      changed_paths: [{ status: "M", path: "src/a.ts" }]
    }), {
      responseMode: "compact",
      request: { paths: ["src/a.ts"] }
    }).structuredContent;
    expect(defaultRevertPreview).toEqual({ ok: true, action: "revert", dryRun: true, counts: { modified: 1 } });

    const defaultDeletePreview = toToolResult("svn_delete", createEnvelope({
      ok: true,
      command: "svn delete --dry-run",
      cwd: "E:\\dev\\example"
    }), {
      responseMode: "compact",
      request: { paths: ["src/a.ts"] }
    }).structuredContent;
    expect(defaultDeletePreview).toEqual({ ok: true, action: "delete", dryRun: true, pathCount: 1 });

    const commitWithResidue = toToolResult("svn_commit", {
      ...createEnvelope({
        ok: true,
        command: "svn commit",
        cwd: "E:\\dev\\example",
        revision: 44,
        changed_paths: [{ status: "M", path: "src/leftover.ts" }]
      }),
      post_status_clean: false
    }, { responseMode: "compact", request: { paths: ["src/a.ts"], message: "message" } }).structuredContent;
    expect(commitWithResidue).toEqual({
      ok: true,
      action: "commit",
      revision: 44,
      verifiedStatus: "committed",
      postStatusClean: false,
      residue: [{ path: "src/leftover.ts", status: "modified" }]
    });
  });

  it("projects compact info and property results onto requested fields", () => {
    const infoPayload = {
      ...createEnvelope({ ok: true, command: "svn info --xml", cwd: "E:\\dev\\example", revision: 42 }),
      url: "https://example.com/svn/project/trunk",
      repo_root: "https://example.com/svn/project",
      wc_root: "E:\\dev\\example",
      entries: [{ path: "example", revision: 42 }],
      mixed_revision: true,
      revision_range: { min: 40, max: 42 },
      local_modifications: false,
      switched: false,
      partial: false,
      remote_head_revision: 43,
      stale_base: true
    };
    const info = toToolResult("svn_info", infoPayload, {
      responseMode: "compact",
      request: { fields: ["revision", "mixedRevision", "staleBase"] }
    }).structuredContent;
    expect(info).toEqual({ ok: true, revision: 42, mixedRevision: true, staleBase: true });

    const defaultInfo = toToolResult("svn_info", infoPayload, { responseMode: "compact" }).structuredContent;
    expect(defaultInfo).toEqual({
      ok: true,
      revision: 42,
      mixedRevision: true,
      revisionRange: { min: 40, max: 42 },
      localModifications: false,
      remoteHeadRevision: 43,
      staleBase: true
    });
    expect(defaultInfo).not.toHaveProperty("root");
    expect(defaultInfo).not.toHaveProperty("url");

    const redactedInfo = toToolResult("svn_info", {
      ...infoPayload,
      url: "https://user:secret@example.com/svn/project?token=abc123",
      repo_root: "https://user:secret@example.com/svn/project"
    }, {
      responseMode: "compact",
      request: { fields: ["url", "repositoryRoot"] }
    }).structuredContent;
    expect(redactedInfo).toEqual({
      ok: true,
      url: "https://***:***@example.com/svn/project?token=***",
      repositoryRoot: "https://***:***@example.com/svn/project"
    });

    const propertyPayload = {
      ...createEnvelope({ ok: true, command: "svn propget", cwd: "E:\\dev\\example" }),
      properties: [{ path: "src/a.ts", name: "svn:eol-style", value: "native" }],
      missing_paths: ["src/b.ts"]
    };
    const properties = toToolResult("svn_propget", propertyPayload, {
      responseMode: "compact",
      request: { name: "svn:eol-style", fields: ["path", "value"] }
    }).structuredContent;
    expect(properties).toEqual({
      ok: true,
      name: "svn:eol-style",
      properties: [{ path: "src/a.ts", value: "native" }],
      missingPaths: ["src/b.ts"]
    });

    const longProperty = toToolResult("svn_propget", {
      ...propertyPayload,
      properties: [{ path: "src/a.ts", name: "custom:large", value: "x".repeat(1000) }]
    }, {
      responseMode: "compact",
      request: { name: "custom:large", maxValueChars: 256 }
    }).structuredContent;
    const firstProperty = (longProperty.properties as Array<Record<string, unknown>>)[0];
    expect(String(firstProperty?.value).length).toBe(256);
    expect(firstProperty?.valueTruncated).toBe(true);
    expect(firstProperty).not.toHaveProperty("name");

    const secretProperty = toToolResult("svn_propget", {
      ...propertyPayload,
      properties: [{
        path: "src/a.ts",
        name: "custom:url",
        value: "https://user:secret@example.com/repo?token=abc123"
      }],
      missing_paths: []
    }, {
      responseMode: "compact",
      request: { name: "custom:url" }
    }).structuredContent;
    expect(JSON.stringify(secretProperty)).not.toContain("secret");
    expect(JSON.stringify(secretProperty)).not.toContain("abc123");

    const manyPropertiesPayload = {
      ...propertyPayload,
      properties: Array.from({ length: 300 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        name: "custom:value",
        value: String(index)
      })),
      missing_paths: []
    };
    const propertyPage = toToolResult("svn_propget", manyPropertiesPayload, {
      responseMode: "compact",
      request: { name: "custom:value", maxItems: 10, cursor: "10" }
    }).structuredContent;
    expect(propertyPage.properties as unknown[]).toHaveLength(10);
    expect((propertyPage.properties as Array<Record<string, unknown>>)[0]?.path).toBe("src/file-10.ts");
    expect(propertyPage.counts).toEqual({ found: 300, missing: 0 });
    expect(propertyPage.truncated).toBe(true);
    expect(propertyPage.nextCursor).toBe("20");
  });

  it("returns compact snapshot, cat, and blame payloads", () => {
    const snapshot = toToolResult("svn_snapshot", {
      ...createEnvelope({
        ok: true,
        command: "svn snapshot",
        cwd: "E:\\dev\\example",
        revision: 42,
        changed_paths: [{ status: "M", path: "E:\\dev\\example\\src\\a.ts" }]
      }),
      mixed_revision: false,
      local_modifications: true,
      remote_head_revision: 43,
      stale_base: true
    }, { responseMode: "compact", request: {} }).structuredContent;
    expect(snapshot).toEqual({
      ok: true,
      revision: 42,
      mixedRevision: false,
      localModifications: true,
      remoteHeadRevision: 43,
      staleBase: true,
      counts: { modified: 1 },
      items: [{ path: "src/a.ts", status: "modified" }]
    });

    const cat = toToolResult("svn_cat", {
      ...createEnvelope({ ok: true, command: "svn cat", cwd: "E:\\dev\\example" }),
      content: "one\ntwo\n",
      page_offset: 0,
      has_more: true,
      next_cursor: "8"
    }, { responseMode: "compact", request: { path: "src/a.ts" } }).structuredContent;
    expect(cat).toEqual({
      ok: true,
      path: "src/a.ts",
      content: "one\ntwo\n",
      hasMore: true,
      nextCursor: "8"
    });

    const blame = toToolResult("svn_blame", {
      ...createEnvelope({ ok: true, command: "svn blame", cwd: "E:\\dev\\example" }),
      lines: [{ line: 1, revision: 40, author: "dev", text: "one" }],
      has_more: false
    }, { responseMode: "compact", request: { path: "src/a.ts" } }).structuredContent;
    expect(blame).toEqual({
      ok: true,
      path: "src/a.ts",
      lines: [{ line: 1, revision: 40, author: "dev", text: "one" }],
      hasMore: false
    });
  });

  it("compacts healthy and failed diagnostics without command echoes", () => {
    const healthy = {
      ...createEnvelope({ ok: true, command: "svn_diagnose", cwd: "E:\\dev\\example" }),
      health: "healthy",
      svn_available: true,
      working_copy_valid: true,
      remote_accessible: true,
      checks: Array.from({ length: 5 }, (_, index) => ({
        name: `check_${index}`,
        ok: true,
        command: `long command ${index}`,
        note: ""
      })),
      suggestions: []
    };
    const compactHealthy = toToolResult("svn_diagnose", healthy, { responseMode: "compact" }).structuredContent;
    expect(compactHealthy).toEqual({
      ok: true,
      health: "healthy",
      svnAvailable: true,
      workingCopyValid: true,
      remoteAccessible: true,
      checks: { passed: 5, failed: [] }
    });
    expect(JSON.stringify(compactHealthy)).not.toContain("long command");
    const withPassing = toToolResult("svn_diagnose", healthy, {
      responseMode: "compact",
      request: { includePassing: true, maxItems: 2 }
    }).structuredContent;
    expect(withPassing.checks).toEqual({
      passed: 5,
      failed: [],
      passing: [{ name: "check_0" }, { name: "check_1" }]
    });
    expect(withPassing).toMatchObject({ truncated: true, nextCursor: "2" });

    const failed = {
      ...healthy,
      ...createEnvelope({ ok: false, command: "svn_diagnose", cwd: "E:\\dev\\example", note: "network failed" }),
      health: "error",
      remote_accessible: false,
      checks: [{ name: "remote_status", ok: false, command: "secretly long command", note: "network failed" }],
      suggestions: ["Check network access."]
    };
    const compactFailed = toToolResult("svn_diagnose", failed, { responseMode: "compact" }).structuredContent;
    expect(compactFailed).toEqual({
      ok: false,
      health: "error",
      svnAvailable: true,
      workingCopyValid: true,
      remoteAccessible: false,
      checks: { passed: 0, failed: [{ name: "remote_status", note: "network failed" }] },
      note: "network failed",
      suggestions: ["Check network access."]
    });
  });

  it("keeps self-check compact unless detailed output is requested", () => {
    const payload = {
      ...createEnvelope({ ok: true, command: "svn_self_check", cwd: "E:\\dev\\example" }),
      server_version: "1.0.0",
      package_version: "1.0.0",
      current_path: "E:\\dev\\example\\current",
      current_target: "E:\\dev\\example\\releases\\v1.0.0",
      current_matches_package: true,
      runtime_layout_ok: true,
      toolchain_ok: true,
      startup_probe: { svn: { ok: true }, dos2unix: { ok: true }, unix2dos: { ok: true } }
    };

    const compact = toToolResult("svn_self_check", payload, { responseMode: "compact" }).structuredContent;
    expect(compact).toEqual({ ok: true, version: "1.0.0", available: true });
    expect(JSON.stringify(compact)).not.toContain("current_path");

    const npmCompact = toToolResult("svn_self_check", {
      ...payload,
      current_matches_package: false,
      runtime_layout: "npm-package",
      runtime_layout_ok: true
    }, { responseMode: "compact" }).structuredContent;
    expect(npmCompact).toEqual({ ok: true, version: "1.0.0", available: true });

    const detailed = toToolResult("svn_self_check", payload, {
      responseMode: "compact",
      request: { detailed: true }
    }).structuredContent;
    expect(detailed).toMatchObject({
      ok: true,
      version: "1.0.0",
      packageVersion: "1.0.0",
      runtimeLayoutOk: true,
      currentPointerApplicable: undefined,
      currentMatchesPackage: true,
      toolchainOk: true
    });
    expect(JSON.stringify(detailed)).not.toContain("E:\\dev\\example");
    expect(detailed).not.toHaveProperty("current_path");
    expect(detailed).not.toHaveProperty("runtime_root");
  });

  it("does not call an incomplete matching release available", () => {
    const payload = {
      ...createEnvelope({
        ok: false,
        command: "svn_self_check",
        cwd: "E:\\dev\\example",
        note: "release payload is incomplete"
      }),
      server_version: "1.1.2",
      toolchain_ok: true,
      runtime_layout_ok: false,
      current_matches_package: true
    };

    const result = toToolResult("svn_self_check", payload, {
      responseMode: "compact",
      request: {}
    }).structuredContent;

    expect(result.ok).toBe(false);
    expect(result.available).toBe(false);
  });
});
