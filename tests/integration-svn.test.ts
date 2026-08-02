import { describe, expect, it, jest } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { svnAdminExecutable, svnExecutable } from "../src/runner.js";
import { eolFixVerified, svnCommitWorkflow, svnPrecommit, svnPrepareCommit, svnSnapshot } from "../src/tools/composite.js";
import { svnDiagnose } from "../src/tools/diagnose.js";
import { svnAdd, svnCommit, svnCopy, svnDelete, svnExport, svnImport, svnMove, svnPathChange, svnPropset, svnPropsetEolStyle, svnRename, svnResolve, svnRevert, svnUpdate } from "../src/tools/mutating.js";
import { eolCheck, svnBlame, svnCat, svnDiff, svnInfo, svnLog, svnPropget, svnStatus } from "../src/tools/readonly.js";

jest.setTimeout(30000);

describe("SVN tool integration against a temp repository", () => {
  it("includes revision state when compact status tokens need change detection", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const before = await svnStatus({ cwd: fixture.wc, includeRevisionState: true });
      fs.writeFileSync(path.join(fixture.wc, "revision-state.txt"), "one\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: ["revision-state.txt"] })).ok).toBe(true);
      const committed = await svnCommit({
        cwd: fixture.wc,
        paths: ["revision-state.txt"],
        message: commitMessage("Add revision-state fixture")
      });
      const after = await svnStatus({ cwd: fixture.wc, includeRevisionState: true });

      expect(before.revision_range).toEqual({ min: 0, max: 0 });
      expect(after.revision_range).toMatchObject({ max: committed.revision });
      expect(after.svnversion).toEqual(expect.any(String));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("skips unrequested snapshot components for projected fields", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const revisionOnly = await svnSnapshot({ cwd: fixture.wc, fields: ["revision"] });
      expect(revisionOnly).toMatchObject({ ok: true, components: { status: false, info: true } });

      const statusOnly = await svnSnapshot({ cwd: fixture.wc, fields: ["counts"] });
      expect(statusOnly).toMatchObject({ ok: true, components: { status: true, info: false } });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("captures a bounded pre-edit baseline for explicit paths", async () => {
    const fixture = createTempWorkingCopy();
    try {
      fs.writeFileSync(path.join(fixture.wc, "baseline.txt"), "one\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: ["baseline.txt"] })).ok).toBe(true);
      expect((await svnCommit({
        cwd: fixture.wc,
        paths: ["baseline.txt"],
        message: commitMessage("Add baseline fixture")
      })).ok).toBe(true);

      const baseline = await svnSnapshot({ cwd: fixture.wc, paths: ["baseline.txt"], captureBaseline: true });
      expect(baseline).toMatchObject({
        ok: true,
        baseline_token: expect.stringMatching(/^[0-9a-f-]{36}$/i),
        baseline_expires_at: expect.any(Number),
        baseline_path_count: 1
      });
      expect(await svnSnapshot({ cwd: fixture.wc, captureBaseline: true })).toMatchObject({
        ok: false,
        note: "captureBaseline requires explicit paths"
      });
      expect(await svnSnapshot({ cwd: fixture.wc, paths: ["."], captureBaseline: true })).toMatchObject({
        ok: false,
        code: "BASELINE_FILE_SCOPE_REQUIRED"
      });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("treats at signs in working-copy and export paths as literal characters", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const sourceName = "revision@123";
      const source = path.join(fixture.wc, sourceName);
      const exportPath = path.join(fixture.root, "export@123");
      fs.writeFileSync(source, "one\r\n", "utf8");

      expect((await svnAdd({ cwd: fixture.wc, paths: [sourceName] })).ok).toBe(true);
      expect((await svnPropset({ cwd: fixture.wc, paths: [sourceName], name: "custom:flag", value: "yes" })).ok).toBe(true);
      const atPathCommit = await svnCommit({
        cwd: fixture.wc,
        paths: [sourceName],
        message: "Add literal at-sign path\n\n- Verify SVN target escaping"
      });
      expect(atPathCommit.ok).toBe(true);

      expect((await svnInfo({ cwd: fixture.wc, paths: [sourceName] })).ok).toBe(true);
      expect((await svnLog({ cwd: fixture.wc, paths: [sourceName], limit: 1 })).ok).toBe(true);
      expect((await svnPropget({ cwd: fixture.wc, paths: [sourceName], name: "custom:flag" })).ok).toBe(true);
      expect((await svnExport({
        cwd: fixture.wc,
        src: source,
        dest: exportPath,
        externalDestAck: true
      })).ok).toBe(true);
      expect(fs.existsSync(exportPath)).toBe(true);

      fs.writeFileSync(source, "two\r\n", "utf8");
      expect((await svnStatus({ cwd: fixture.wc, paths: [sourceName] })).ok).toBe(true);
      const literalAtDiff = await svnDiff({ cwd: fixture.wc, paths: [sourceName] });
      expect(literalAtDiff.ok ? null : literalAtDiff).toBeNull();
      const revisionAtDiff = await svnDiff({
        cwd: fixture.wc,
        paths: [sourceName],
        revision: String(atPathCommit.revision)
      });
      expect(revisionAtDiff.ok ? null : revisionAtDiff).toBeNull();
      expect((await eolCheck({ cwd: fixture.wc, paths: [sourceName] })).ok).toBe(true);
      expect((await svnPrecommit({ cwd: fixture.wc, paths: [sourceName] })).ok).toBe(true);

      const movedName = "archive@456";
      expect((await svnMove({ cwd: fixture.wc, src: sourceName, dest: movedName })).ok).toBe(true);
      expect(fs.existsSync(path.join(fixture.wc, movedName))).toBe(true);

      const copiedName = "copy@789";
      const copied = await svnCopy({ cwd: fixture.wc, src: movedName, dest: copiedName });
      expect(copied).toMatchObject({ ok: true });
      expect(fs.existsSync(path.join(fixture.wc, copiedName))).toBe(true);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("detects LF EOL churn, fixes it, and commits via a -F message flow", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const file = path.join(fixture.wc, "app.txt");
      fs.writeFileSync(file, "one\r\ntwo\r\n", "utf8");

      expect((await svnAdd({ cwd: fixture.wc, paths: ["app.txt"] })).ok).toBe(true);
      expect((await svnCommit({ cwd: fixture.wc, paths: ["app.txt"], message: commitMessage("Initial import") })).ok).toBe(true);
      execFileSync(svnExecutable(), ["propset", "svn:eol-style", "CRLF", file], { cwd: fixture.wc });
      execFileSync(svnExecutable(), ["commit", "-m", "set prop", file], { cwd: fixture.wc });

      fs.writeFileSync(file, "one\nTWO\n", "utf8");
      const damaged = await svnPrecommit({ cwd: fixture.wc, paths: ["app.txt"] });
      expect(damaged.verdict).toBe("EOL_FIX_NEEDED");

      const diff = await svnDiff({ cwd: fixture.wc, paths: ["app.txt"] });
      expectSvnArgs(diff.command, "diff --internal-diff -x --ignore-eol-style --");

      const eolOperationId = randomUUID();
      const fixed = await eolFixVerified({ cwd: fixture.wc, path: "app.txt", operationId: eolOperationId });
      expect(fixed.ok).toBe(true);
      expect(fixed.command.toLowerCase()).toContain("unix2dos");
      expect(fixed.command.toLowerCase()).not.toContain("powershell");
      expect(fixed.converter).toBe("unix2dos");
      expectSvnArgs(String(fixed.verification_command), "diff --internal-diff -x --ignore-eol-style --");
      expect(fixed.pure_eol_churn).toBe(false);
      const fixedReplay = await eolFixVerified({ cwd: fixture.wc, path: "app.txt", operationId: eolOperationId });
      expect(fixedReplay).toMatchObject({ ok: true, operation_id: eolOperationId, idempotent_replay: true });

      const ready = await svnPrecommit({ cwd: fixture.wc, paths: ["app.txt"] });
      expect(ready.verdict).toBe("READY");

      const committed = await svnCommit({
        cwd: fixture.wc,
        paths: ["app.txt"],
        message: commitMessage("Update app text")
      });
      expect(committed.ok).toBe(true);
      expect(typeof committed.revision).toBe("number");
      expect(committed.post_status_clean).toBe(true);
      expect((await svnStatus({ cwd: fixture.wc })).changed_paths).toEqual([]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an invalid commit message before creating a repository revision", async () => {
    const fixture = createTempWorkingCopy();
    try {
      fs.writeFileSync(path.join(fixture.wc, "message.txt"), "content\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: ["message.txt"] })).ok).toBe(true);

      const before = await svnInfo({ cwd: fixture.wc });
      const commit = await svnCommit({ cwd: fixture.wc, paths: ["message.txt"], message: "Short only" });
      const after = await svnInfo({ cwd: fixture.wc });

      expect(commit).toMatchObject({
        ok: false,
        warning_code: "COMMIT_MESSAGE_FORMAT",
        failed_rule: "missing blank second line and verification bullet",
        blocking: true
      });
      expect(commit.suggested_message).toBe("Short only\n\n- Describe verification performed");
      expect(after.remote_head_revision).toBe(before.remote_head_revision);
      expect(statusByPath((await svnStatus({ cwd: fixture.wc, paths: ["message.txt"] })).changed_paths, fixture.wc).get("message.txt")).toBe("A");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("returns committed paths and a bounded revision receipt after a clean commit", async () => {
    const fixture = createTempWorkingCopy();
    try {
      fs.writeFileSync(path.join(fixture.wc, "receipt.txt"), "content\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: ["receipt.txt"] })).ok).toBe(true);

      const operationId = randomUUID();
      const commit = await svnCommit({
        cwd: fixture.wc,
        paths: ["receipt.txt"],
        message: commitMessage("Add receipt fixture"),
        operationId
      });

      expect(commit).toMatchObject({
        ok: true,
        committed_revision: commit.revision,
        committed_paths: ["receipt.txt"],
        committed_count: 1,
        path_count: 1,
        post_status_clean: true,
        working_copy_mixed: true,
        remote_head_revision: commit.revision,
        eol_verdict: "not_checked"
      });
      expect(commit.changed_paths).toEqual([{ path: "receipt.txt", status: "A" }]);
      expect(commit.post_status).toEqual([]);
      expect(commit.content_hashes).toEqual([
        expect.objectContaining({ path: "receipt.txt", algorithm: "sha256", hash: expect.stringMatching(/^[a-f0-9]{64}$/) })
      ]);
      const replay = await svnCommit({
        cwd: fixture.wc,
        paths: ["receipt.txt"],
        message: commitMessage("Add receipt fixture"),
        operationId
      });
      expect(replay).toMatchObject({
        ok: true,
        revision: commit.revision,
        operation_id: operationId,
        idempotent_replay: true
      });
      const mismatch = await svnCommit({
        cwd: fixture.wc,
        paths: ["receipt.txt"],
        message: commitMessage("Different receipt fixture"),
        operationId
      });
      expect(mismatch).toMatchObject({ ok: false, code: "OPERATION_ID_CONFLICT", operation_id: operationId });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("preserves Unicode and spaces in SVN path arguments and parsed results", async () => {
    const fixture = createTempWorkingCopy();
    const original = "docs/Δ résumé 文件.txt";
    const moved = "docs/Ω renamed 文件.txt";
    try {
      fs.mkdirSync(path.join(fixture.wc, "docs"));
      fs.writeFileSync(path.join(fixture.wc, original), "unicode\r\n", "utf8");

      const unicodeAdd = await svnAdd({ cwd: fixture.wc, paths: [original] });
      expect(unicodeAdd).toMatchObject({ ok: true });
      const addedStatus = await svnStatus({ cwd: fixture.wc, paths: [original] });
      expect(statusByPath(addedStatus.changed_paths, fixture.wc).get(original)).toBe("A");
      expect((await svnPropset({
        cwd: fixture.wc,
        paths: [original],
        name: "custom:unicode",
        value: "Δ résumé 文件"
      })).ok).toBe(true);
      const property = await svnPropget({ cwd: fixture.wc, paths: [original], name: "custom:unicode" });
      expect(property.ok).toBe(true);
      expect(JSON.stringify(property.properties)).toContain("Δ résumé 文件");

      const first = await svnCommit({ cwd: fixture.wc, paths: [original], message: commitMessage("Add Unicode path") });
      expect(first.ok).toBe(true);
      expect(first.committed_paths).toEqual(expect.arrayContaining([original]));

      fs.writeFileSync(path.join(fixture.wc, original), "UNICODE\r\n", "utf8");
      const diff = await svnDiff({ cwd: fixture.wc, paths: [original] });
      expect(diff.ok).toBe(true);
      expect(diff.per_file).toHaveLength(1);
      expect(normalizeStatusPath(diff.per_file[0].path, fixture.wc)).toBe(original);

      expect((await svnPathChange({ cwd: fixture.wc, action: "move", src: original, dest: moved })).ok).toBe(true);
      const second = await svnCommit({
        cwd: fixture.wc,
        paths: [original, moved],
        message: commitMessage("Move Unicode path"),
        riskAck: true
      });
      expect(second.ok).toBe(true);
      expect(second.committed_paths).toEqual(expect.arrayContaining([original, moved]));
      const pinned = await svnUpdate({ cwd: fixture.wc, paths: [moved], revision: String(second.revision) });
      expect(pinned).toMatchObject({ ok: true, requested_revision: String(second.revision) });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("normalizes new text files during svn_add from repository policy and skips byte-exact inputs", async () => {
    const fixture = createTempWorkingCopy();
    try {
      fs.writeFileSync(path.join(fixture.wc, ".svn-mcp-policy.json"), JSON.stringify({
        normalizeEol: "crlf",
        eolExclude: ["**/*.patch"]
      }), "utf8");
      fs.writeFileSync(path.join(fixture.wc, "new.txt"), "one\ntwo\n", "utf8");
      fs.writeFileSync(path.join(fixture.wc, "exact.patch"), "one\ntwo\n", "utf8");
      fs.writeFileSync(path.join(fixture.wc, "binary.dat"), Buffer.from([0x00, 0x0a, 0xff]));

      const added = await svnAdd({ cwd: fixture.wc, paths: ["new.txt", "exact.patch", "binary.dat"] });

      expect(added).toMatchObject({
        ok: true,
        eol_normalization: {
          target: "crlf",
          converted: 1,
          verified: 1,
          skipped: 2,
          failed: 0
        }
      });
      expect(fs.readFileSync(path.join(fixture.wc, "new.txt"), "utf8")).toBe("one\r\ntwo\r\n");
      expect(fs.readFileSync(path.join(fixture.wc, "exact.patch"), "utf8")).toBe("one\ntwo\n");
      expect(fs.readFileSync(path.join(fixture.wc, "binary.dat"))).toEqual(Buffer.from([0x00, 0x0a, 0xff]));
      expect(added.eol_files).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "new.txt", before: "lf", after: "crlf", verified: true }),
        expect.objectContaining({ path: "exact.patch", skipped: "policy-excluded" }),
        expect.objectContaining({ path: "binary.dat", skipped: "binary" })
      ]));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("repairs explicit EOL batches and reports partial failures without scanning directories", async () => {
    const fixture = createTempWorkingCopy();
    try {
      fs.writeFileSync(path.join(fixture.wc, "lf.txt"), "one\ntwo\n", "utf8");
      fs.writeFileSync(path.join(fixture.wc, "correct.txt"), "one\r\ntwo\r\n", "utf8");
      fs.writeFileSync(path.join(fixture.wc, "binary.dat"), Buffer.from([0x00, 0x0a, 0xff]));
      expect((await svnAdd({ cwd: fixture.wc, paths: ["lf.txt", "correct.txt", "binary.dat"] })).ok).toBe(true);

      const fixed = await eolFixVerified({
        cwd: fixture.wc,
        paths: ["lf.txt", "correct.txt", "binary.dat"],
        target: "crlf"
      });

      expect(fixed).toMatchObject({ ok: false, batch: true, counts: { passed: 2, failed: 1, total: 3 } });
      expect(fs.readFileSync(path.join(fixture.wc, "lf.txt"), "utf8")).toBe("one\r\ntwo\r\n");
      expect(fixed.files).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "lf.txt", ok: true, before: "lf", after: "crlf" }),
        expect.objectContaining({ path: "correct.txt", ok: true, before: "crlf", after: "crlf" }),
        expect.objectContaining({ path: "binary.dat", ok: false, failure: "binary file refused" })
      ]));
      const text = (fixed.files as Array<Record<string, unknown>>).find((file) => file.path === "lf.txt");
      expect(text?.normalized_content_hash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps diffs and blame EOL-blind by default with an explicit diagnostic opt-out", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const relativePath = "eol-history.txt";
      const file = path.join(fixture.wc, relativePath);
      fs.writeFileSync(file, "one\r\ntwo\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: [relativePath] })).ok).toBe(true);
      const committed = await svnCommit({ cwd: fixture.wc, paths: [relativePath], message: commitMessage("Add EOL history") });
      expect(committed.ok).toBe(true);

      fs.writeFileSync(file, "one\ntwo\n", "utf8");
      const defaultDiff = await svnDiff({ cwd: fixture.wc, paths: [relativePath] });
      expect(defaultDiff).toMatchObject({ ok: true, ignore_eol: true, eol_only: true, diff_excerpt: "" });

      const diagnosticDiff = await svnDiff({ cwd: fixture.wc, paths: [relativePath], showEolChanges: true });
      expect(diagnosticDiff).toMatchObject({ ok: true, ignore_eol: false, eol_changes_included: true });
      expect(diagnosticDiff.per_file.length).toBeGreaterThan(0);

      fs.writeFileSync(file, "ONE\ntwo\n", "utf8");
      const contentDefault = await svnDiff({ cwd: fixture.wc, paths: [relativePath] });
      const contentDiagnostic = await svnDiff({ cwd: fixture.wc, paths: [relativePath], showEolChanges: true });
      expect(contentDefault.per_file[0]).toMatchObject({ added: 1, removed: 1 });
      expect(contentDiagnostic.per_file[0]).toMatchObject({ added: 2, removed: 2 });
      expect(contentDefault.diff_excerpt).toContain("+ONE");
      expect(contentDiagnostic.diff_excerpt).toContain("+ONE");

      const defaultBlame = await svnBlame({ cwd: fixture.wc, path: relativePath });
      expect(defaultBlame).toMatchObject({ ok: true, ignore_eol: true });
      expectSvnArgs(defaultBlame.command, "blame --xml -x --ignore-eol-style --");

      const diagnosticBlame = await svnBlame({ cwd: fixture.wc, path: relativePath, showEolChanges: true });
      expect(diagnosticBlame).toMatchObject({ ok: true, ignore_eol: false, eol_changes_included: true });
      expect(diagnosticBlame.command).not.toContain("--ignore-eol-style");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("blocks precommit and commit for conflicted paths", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const file = path.join(fixture.wc, "conflict.txt");
      fs.writeFileSync(file, "base\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: ["conflict.txt"] })).ok).toBe(true);
      const first = await svnCommit({
        cwd: fixture.wc,
        paths: ["conflict.txt"],
        message: commitMessage("Add conflict fixture")
      });
      expect(first.ok).toBe(true);
      const baseRevision = Number(first.revision);

      fs.writeFileSync(file, "theirs\r\n", "utf8");
      execFileSync(svnExecutable(), ["commit", "-m", "conflicting change", file], { cwd: fixture.wc });
      execFileSync(svnExecutable(), ["update", "-r", String(baseRevision), "--accept", "postpone", file], { cwd: fixture.wc });
      fs.writeFileSync(file, "mine\r\n", "utf8");
      execFileSync(svnExecutable(), ["update", "--accept", "postpone", file], { cwd: fixture.wc });

      const status = await svnStatus({ cwd: fixture.wc, paths: ["conflict.txt"] });
      expect(status.conflicts.length).toBeGreaterThan(0);

      const precommit = await svnPrecommit({ cwd: fixture.wc, paths: ["conflict.txt"] });
      expect(precommit.verdict).toBe("GUARD_BLOCKED");
      expect(String(precommit.note)).toMatch(/non-committable status \(C\)|unresolved conflicts/);

      const commit = await svnCommit({
        cwd: fixture.wc,
        paths: ["conflict.txt"],
        message: commitMessage("Attempt conflicted commit")
      });
      expect(commit.ok).toBe(false);
      expect(String(commit.note)).toMatch(/non-committable status \(C\)|unresolved conflicts/);

      const resolveOperationId = randomUUID();
      const resolved = await svnResolve({
        cwd: fixture.wc,
        path: "conflict.txt",
        accept: "working",
        operationId: resolveOperationId
      });
      expect(resolved).toMatchObject({ ok: true, operation_id: resolveOperationId });
      const resolvedReplay = await svnResolve({
        cwd: fixture.wc,
        path: "conflict.txt",
        accept: "working",
        operationId: resolveOperationId
      });
      expect(resolvedReplay).toMatchObject({ ok: true, operation_id: resolveOperationId, idempotent_replay: true });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("reports mixed revision ranges and remote HEAD details without treating them as dirty state", async () => {
    const fixture = createTempWorkingCopy();
    try {
      fs.writeFileSync(path.join(fixture.wc, "info.txt"), "one\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: ["info.txt"] })).ok).toBe(true);
      const committed = await svnCommit({
        cwd: fixture.wc,
        paths: ["info.txt"],
        message: commitMessage("Add info fixture")
      });
      expect(committed.ok).toBe(true);

      const info = await svnInfo({ cwd: fixture.wc });
      expect(info.ok).toBe(true);
      expect(info.mixed_revision).toBe(true);
      expect(info.local_modifications).toBe(false);
      expect(info.revision_range).toEqual({ min: 0, max: committed.revision });
      expect(info.remote_head_revision).toBe(committed.revision);
      expect(info.note).toContain("mixed revision working copy");
      expect(info.note).not.toContain("local modifications present");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("detects mixed working-copy roots from subdirectory commit flows", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const directory = path.join(fixture.wc, "subdir");
      const file = path.join(directory, "nested.txt");
      fs.mkdirSync(directory);
      fs.writeFileSync(file, "one\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: ["subdir/nested.txt"] })).ok).toBe(true);
      expect((await svnCommit({
        cwd: fixture.wc,
        paths: ["subdir/nested.txt"],
        message: commitMessage("Add nested fixture")
      })).ok).toBe(true);

      fs.writeFileSync(file, "two\r\n", "utf8");
      const precommit = await svnPrecommit({ cwd: directory, paths: ["nested.txt"] });
      expect(precommit.note).toContain("mixed revision working copy");

      const committed = await svnCommit({
        cwd: directory,
        paths: ["nested.txt"],
        message: commitMessage("Update nested fixture")
      });
      expect(committed.ok).toBe(true);
      expect(committed.note).toContain("mixed revision working copy");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("diagnoses local and remote SVN health for a working copy", async () => {
    const fixture = createTempWorkingCopy();
    try {
      fs.writeFileSync(path.join(fixture.wc, "diag.txt"), "one\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: ["diag.txt"] })).ok).toBe(true);
      expect((await svnCommit({
        cwd: fixture.wc,
        paths: ["diag.txt"],
        message: commitMessage("Add diagnose fixture")
      })).ok).toBe(true);

      const diagnosed = await svnDiagnose({ cwd: fixture.wc });
      const checks = new Map((diagnosed.checks as Array<{ name: string; ok: boolean }>).map((check) => [check.name, check.ok]));

      expect(diagnosed.ok).toBe(true);
      expect(diagnosed.health).toBe("healthy");
      expect(diagnosed.working_copy_valid).toBe(true);
      expect(diagnosed.remote_accessible).toBe(true);
      expect(checks.get("local_status")).toBe(true);
      expect(checks.get("remote_status")).toBe(true);
      expect(checks.get("remote_info_head")).toBe(true);
      expect(checks.get("log_latest")).toBe(true);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("returns structured diagnosis for non-working-copy paths", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "svn-agent-not-wc-"));
    try {
      const diagnosed = await svnDiagnose({ cwd: root });

      expect(diagnosed.ok).toBe(false);
      expect(diagnosed.health).toBe("error");
      expect(diagnosed.working_copy_valid).toBe(false);
      expect(diagnosed.suggestions).toEqual(expect.arrayContaining([
        expect.stringContaining("SVN working copy")
      ]));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires cwd or an absolute path hint for ambiguous read-only calls", async () => {
    const status = await svnStatus({});

    expect(status.ok).toBe(false);
    expect(status.note).toContain("cwd or absolute path required");
  });

  it("enforces READONLY and update explicit-target guards", async () => {
    const fixture = createTempWorkingCopy();
    const oldReadonly = process.env.SVN_AGENT_READONLY;
    try {
      process.env.SVN_AGENT_READONLY = "1";
      const refused = await svnCommit({
        cwd: fixture.wc,
        paths: ["missing.txt"],
        message: commitMessage("Should refuse")
      });
      expect(refused.ok).toBe(false);
      expect(refused.note).toBe("READONLY instance");
      expect((await svnMove({ cwd: fixture.wc, src: "missing.txt", dest: "other.txt" })).note).toBe("READONLY instance");
      expect((await svnCopy({ cwd: fixture.wc, src: "missing.txt", dest: "other.txt" })).note).toBe("READONLY instance");
    } finally {
      if (oldReadonly === undefined) {
        delete process.env.SVN_AGENT_READONLY;
      } else {
        process.env.SVN_AGENT_READONLY = oldReadonly;
      }
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }

    const updateRefusal = await svnUpdate({ cwd: process.cwd() });
    expect(updateRefusal.ok).toBe(false);
    expect(updateRefusal.note).toContain("explicit paths required");
  });

  it("adds missing parent directories for an explicit new file path without adding siblings", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const nested = path.join(fixture.wc, "src", "feature");
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, "app.ts"), "export const value = 1;\r\n", "utf8");
      fs.writeFileSync(path.join(nested, "scratch.tmp"), "do not add\r\n", "utf8");

      const added = await svnAdd({ cwd: fixture.wc, paths: ["src/feature/app.ts"] });
      expect(added.ok).toBe(true);

      const status = await svnStatus({ cwd: fixture.wc, paths: ["src"] });
      const byPath = new Map(status.changed_paths.map((entry) => [normalizeStatusPath(entry.path, fixture.wc), entry.status]));
      expect(byPath.get("src")).toBe("A");
      expect(byPath.get("src/feature")).toBe("A");
      expect(byPath.get("src/feature/app.ts")).toBe("A");
      expect(byPath.get("src/feature/scratch.tmp")).toBe("?");

      const committed = await svnCommit({
        cwd: fixture.wc,
        paths: ["src/feature/app.ts"],
        message: commitMessage("Add nested app")
      });
      expect(committed.ok).toBe(true);
      expect(committed.post_status_clean).toBe(true);
      expect((await svnStatus({ cwd: fixture.wc, paths: ["src/feature/app.ts"] })).changed_paths).toEqual([]);
      expect((await svnStatus({ cwd: fixture.wc, paths: ["src/feature/scratch.tmp"] })).changed_paths[0]?.status).toBe("?");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("blocks recursive adds when a descendant matches never-commit guards", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const buildOutput = path.join(fixture.wc, "src", "App", "bin", "Debug");
      fs.mkdirSync(buildOutput, { recursive: true });
      fs.writeFileSync(path.join(buildOutput, "app.dll"), "not really binary\r\n", "utf8");

      const added = await svnAdd({ cwd: fixture.wc, paths: ["src"], allowRecursive: true });

      expect(added.ok).toBe(false);
      expect(added.note).toContain("never-commit path matches **/bin/**");
      expect(added.note).toContain("src/App/bin");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("blocks svn import when the source tree contains never-commit descendants", async () => {
    const fixture = createTempWorkingCopy();
    const srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), "svn-agent-import-src-"));
    try {
      fs.mkdirSync(path.join(srcRoot, "node_modules", "pkg"), { recursive: true });
      fs.writeFileSync(path.join(srcRoot, "node_modules", "pkg", "index.js"), "module.exports = 1;\r\n", "utf8");

      const imported = await svnImport({
        cwd: fixture.wc,
        src: srcRoot,
        url: `${pathToFileURL(fixture.repo).href}/imported`,
        message: commitMessage("Import guarded tree")
      });

      expect(imported.ok).toBe(false);
      expect(imported.note).toContain("never-commit path");
      expect(imported.note).toContain("node_modules");
    } finally {
      fs.rmSync(srcRoot, { recursive: true, force: true });
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects malformed svn import messages before creating a revision", async () => {
    const fixture = createTempWorkingCopy();
    const srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), "svn-agent-import-message-"));
    try {
      fs.writeFileSync(path.join(srcRoot, "safe.txt"), "safe\r\n", "utf8");
      const imported = await svnImport({
        cwd: fixture.wc,
        src: srcRoot,
        url: `${pathToFileURL(fixture.repo).href}/invalid-message`,
        message: "missing verification body"
      });

      expect(imported).toMatchObject({ ok: false, code: "COMMIT_MESSAGE_FORMAT" });
      expect(execFileSync(svnExecutable(), ["list", pathToFileURL(fixture.repo).href], {
        cwd: fixture.wc,
        encoding: "utf8"
      })).not.toContain("invalid-message/");
    } finally {
      fs.rmSync(srcRoot, { recursive: true, force: true });
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("skips SVN administrative metadata while scanning an import source", async () => {
    const fixture = createTempWorkingCopy();
    const srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), "svn-agent-import-admin-"));
    try {
      fs.mkdirSync(path.join(srcRoot, ".svn"), { recursive: true });
      fs.writeFileSync(path.join(srcRoot, ".svn", "private.key"), "not imported", "utf8");
      fs.writeFileSync(path.join(srcRoot, "safe.txt"), "safe\r\n", "utf8");

      const imported = await svnImport({
        cwd: fixture.wc,
        src: srcRoot,
        url: `${pathToFileURL(fixture.repo).href}/admin-skip`,
        message: commitMessage("Import tree without admin metadata")
      });

      expect(imported.ok).toBe(true);
    } finally {
      fs.rmSync(srcRoot, { recursive: true, force: true });
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses recursive adds containing directory links", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const source = path.join(fixture.wc, "src");
      const outside = path.join(fixture.root, "outside-add");
      fs.mkdirSync(source);
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, ".env"), "SECRET=fake\r\n", "utf8");
      fs.symlinkSync(outside, path.join(source, "linked"), process.platform === "win32" ? "junction" : "dir");

      const added = await svnAdd({ cwd: fixture.wc, paths: ["src"], allowRecursive: true });

      expect(added.ok).toBe(false);
      expect(added.note).toContain("symbolic link refused during recursive scan");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("treats at signs in import source and repository paths as literal characters", async () => {
    const fixture = createTempWorkingCopy();
    const srcRoot = path.join(fixture.root, "import-source@123");
    try {
      fs.mkdirSync(srcRoot);
      fs.writeFileSync(path.join(srcRoot, "safe.txt"), "safe\r\n", "utf8");
      const targetUrl = `${pathToFileURL(fixture.repo).href}/imported@456`;

      const imported = await svnImport({
        cwd: fixture.wc,
        src: srcRoot,
        url: targetUrl,
        message: commitMessage("Import literal at-sign paths")
      });

      expect(imported).toMatchObject({ ok: true });
      expect(execFileSync(svnExecutable(), ["list", `${targetUrl}@`], { cwd: fixture.wc, encoding: "utf8" })).toContain("safe.txt");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses recursive imports containing directory links", async () => {
    const fixture = createTempWorkingCopy();
    const srcRoot = path.join(fixture.root, "import-source");
    const outside = path.join(fixture.root, "outside");
    try {
      fs.mkdirSync(srcRoot);
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, ".env"), "SECRET=fake\r\n", "utf8");
      fs.symlinkSync(outside, path.join(srcRoot, "linked"), process.platform === "win32" ? "junction" : "dir");

      const imported = await svnImport({
        cwd: fixture.wc,
        src: srcRoot,
        url: `${pathToFileURL(fixture.repo).href}/linked-import`,
        message: commitMessage("Reject linked import tree")
      });

      expect(imported.ok).toBe(false);
      expect(imported.note).toContain("symbolic link refused during recursive scan");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses a symbolic link as the import source", async () => {
    const fixture = createTempWorkingCopy();
    const outside = path.join(fixture.root, "outside-source");
    const sourceLink = path.join(fixture.root, "linked-source");
    try {
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "safe.txt"), "safe\r\n", "utf8");
      fs.symlinkSync(outside, sourceLink, process.platform === "win32" ? "junction" : "dir");

      const imported = await svnImport({
        cwd: fixture.wc,
        src: sourceLink,
        url: `${pathToFileURL(fixture.repo).href}/linked-source`,
        message: commitMessage("Reject linked import source")
      });

      expect(imported.ok).toBe(false);
      expect(imported.note).toContain("symbolic link refused as import source");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("infers the working copy from absolute paths without cwd across multiple repositories", async () => {
    const first = createTempWorkingCopy();
    const second = createTempWorkingCopy();
    try {
      const firstFile = path.join(first.wc, "first.txt");
      const secondFile = path.join(second.wc, "second.txt");
      fs.writeFileSync(firstFile, "one\r\n", "utf8");
      fs.writeFileSync(secondFile, "two\r\n", "utf8");

      const firstAdded = await svnAdd({ paths: [firstFile] });
      const secondAdded = await svnAdd({ paths: [secondFile] });

      expect(firstAdded.ok).toBe(true);
      expect(secondAdded.ok).toBe(true);

      const firstStatus = await svnStatus({ paths: [firstFile] });
      const secondStatus = await svnStatus({ paths: [secondFile] });

      expect(statusByPath(firstStatus.changed_paths, first.wc).get("first.txt")).toBe("A");
      expect(statusByPath(secondStatus.changed_paths, second.wc).get("second.txt")).toBe("A");

      const firstCommitted = await svnCommit({
        paths: [firstFile],
        message: commitMessage("Commit first absolute path")
      });
      const secondCommitted = await svnCommit({
        paths: [secondFile],
        message: commitMessage("Commit second absolute path")
      });

      expect(firstCommitted.ok).toBe(true);
      expect(secondCommitted.ok).toBe(true);
      expect((await svnStatus({ paths: [firstFile] })).changed_paths).toEqual([]);
      expect((await svnStatus({ paths: [secondFile] })).changed_paths).toEqual([]);
    } finally {
      fs.rmSync(first.root, { recursive: true, force: true });
      fs.rmSync(second.root, { recursive: true, force: true });
    }
  });

  it("queries repository URLs for logs so mixed-revision working-copy roots still show latest commits", async () => {
    const fixture = createTempWorkingCopy();
    try {
      fs.writeFileSync(path.join(fixture.wc, "root-log.txt"), "one\r\n", "utf8");

      expect((await svnAdd({ cwd: fixture.wc, paths: ["root-log.txt"] })).ok).toBe(true);
      const committed = await svnCommit({
        cwd: fixture.wc,
        paths: ["root-log.txt"],
        message: commitMessage("Add root log fixture")
      });
      expect(committed.ok).toBe(true);

      const rawWorkingCopyLog = execFileSync(svnExecutable(), ["log", "-l", "1", fixture.wc], {
        cwd: fixture.wc,
        encoding: "utf8"
      });
      expect(rawWorkingCopyLog).not.toContain(`r${committed.revision}`);

      const log = await svnLog({ cwd: fixture.wc, limit: 1 });
      expect(log.ok).toBe(true);
      expect(log.revision).toBe(committed.revision);
      expect(log.target_mode).toBe("repository-url");
      expect(log.note).toContain("repository URL at HEAD");
      expect(log.has_more).toBe(false);
      expect(log.command).toContain("-l 2");
      expect((log.entries as Array<{ changed_paths: unknown[] }>)[0]?.changed_paths).toEqual([]);

      const changedPathLog = await svnLog({ cwd: fixture.wc, limit: 1, changedPaths: true });
      expect((changedPathLog.entries as Array<{ changed_paths: unknown[] }>)[0]?.changed_paths).not.toEqual([]);

      const olderLog = await svnLog({ cwd: fixture.wc, limit: 1, cursor: String(committed.revision! - 1) });
      expect(Number(olderLog.revision)).toBeLessThan(committed.revision!);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("can hide common local runtime noise from status while keeping actionable unversioned files", async () => {
    const fixture = createTempWorkingCopy();
    try {
      fs.mkdirSync(path.join(fixture.wc, "node_modules", "pkg"), { recursive: true });
      fs.mkdirSync(path.join(fixture.wc, "dist"), { recursive: true });
      fs.writeFileSync(path.join(fixture.wc, "node_modules", "pkg", "index.js"), "module.exports = 1;\r\n", "utf8");
      fs.writeFileSync(path.join(fixture.wc, "dist", "bundle.js"), "bundle\r\n", "utf8");
      fs.writeFileSync(path.join(fixture.wc, "todo.txt"), "todo\r\n", "utf8");

      const noisy = await svnStatus({ cwd: fixture.wc });
      expect(statusByPath(noisy.changed_paths, fixture.wc).get("node_modules")).toBe("?");
      expect(statusByPath(noisy.changed_paths, fixture.wc).get("dist")).toBe("?");
      expect(statusByPath(noisy.changed_paths, fixture.wc).get("todo.txt")).toBe("?");

      const filtered = await svnStatus({ cwd: fixture.wc, hideNoise: true });
      const byPath = statusByPath(filtered.changed_paths, fixture.wc);
      expect(byPath.get("node_modules")).toBeUndefined();
      expect(byPath.get("dist")).toBeUndefined();
      expect(byPath.get("todo.txt")).toBe("?");
      expect(filtered.filtered_paths).toEqual(expect.arrayContaining(["node_modules", "dist"]));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("surfaces property-only status changes and property conflicts", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const file = path.join(fixture.wc, "props.txt");
      fs.writeFileSync(file, "one\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: ["props.txt"] })).ok).toBe(true);
      expect((await svnCommit({ cwd: fixture.wc, paths: ["props.txt"], message: commitMessage("Add props fixture") })).ok).toBe(true);

      execFileSync(svnExecutable(), ["propset", "custom:flag", "yes", file], { cwd: fixture.wc });
      const status = await svnStatus({ cwd: fixture.wc, paths: ["props.txt"] });

      expect(statusByPath(status.changed_paths, fixture.wc).get("props.txt")).toBe("_M");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("gets and sets explicit working-copy properties without raw svn commands", async () => {
    const fixture = createTempWorkingCopy();
    try {
      fs.writeFileSync(path.join(fixture.wc, "props.txt"), "one\r\n", "utf8");
      fs.writeFileSync(path.join(fixture.wc, "props-missing.txt"), "two\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: ["props.txt", "props-missing.txt"] })).ok).toBe(true);
      expect((await svnCommit({ cwd: fixture.wc, paths: ["props.txt", "props-missing.txt"], message: commitMessage("Add prop targets") })).ok).toBe(true);
      const multiPathLog = await svnLog({
        cwd: fixture.wc,
        paths: ["props.txt", "props-missing.txt"],
        changedPaths: true,
        limit: 1
      });
      expect(multiPathLog.ok).toBe(true);
      expect(multiPathLog.entries).toHaveLength(1);

      const missing = await svnPropget({ cwd: fixture.wc, paths: ["props.txt"], name: "custom:review-note" });
      expect(missing.ok).toBe(true);
      expect(missing.properties).toEqual([]);
      expect(missing.missing_paths).toEqual(["props.txt"]);

      const set = await svnPropset({
        cwd: fixture.wc,
        paths: ["props.txt"],
        name: "custom:review-note",
        value: "checked by MCP"
      });
      expect(set.ok).toBe(true);
      expect(set.command).toContain("-F");
      expect(set.command).not.toContain("checked by MCP");

      const got = await svnPropget({ cwd: fixture.wc, paths: ["props.txt"], name: "custom:review-note" });
      expect(got.ok).toBe(true);
      expect(got.properties).toEqual([
        { path: "props.txt", name: "custom:review-note", value: "checked by MCP" }
      ]);

      expect((await svnPropset({
        cwd: fixture.wc,
        paths: ["props.txt"],
        name: "custom:numeric",
        value: "00123"
      })).ok).toBe(true);
      expect((await svnPropget({ cwd: fixture.wc, paths: ["props.txt"], name: "custom:numeric" })).properties)
        .toEqual([{ path: "props.txt", name: "custom:numeric", value: "00123" }]);

      expect((await svnPropset({
        cwd: fixture.wc,
        paths: ["props.txt"],
        name: "custom:padded",
        value: "  keep both sides  "
      })).ok).toBe(true);
      expect((await svnPropget({ cwd: fixture.wc, paths: ["props.txt"], name: "custom:padded" })).properties)
        .toEqual([{ path: "props.txt", name: "custom:padded", value: "  keep both sides  " }]);

      const mixed = await svnPropget({ cwd: fixture.wc, paths: ["props.txt", "props-missing.txt"], name: "custom:review-note" });
      expect(mixed.ok).toBe(true);
      expect(mixed.note).toBe("property not set on some paths");
      expect(mixed.properties).toEqual([
        { path: "props.txt", name: "custom:review-note", value: "checked by MCP" }
      ]);
      expect(mixed.missing_paths).toEqual(["props-missing.txt"]);
      expect(statusByPath((await svnStatus({ cwd: fixture.wc, paths: ["props.txt"] })).changed_paths, fixture.wc).get("props.txt")).toBe("_M");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses generic propset in readonly mode while allowing propget", async () => {
    const fixture = createTempWorkingCopy();
    const oldReadonly = process.env.SVN_AGENT_READONLY;
    try {
      fs.writeFileSync(path.join(fixture.wc, "readonly-prop.txt"), "one\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: ["readonly-prop.txt"] })).ok).toBe(true);
      expect((await svnCommit({ cwd: fixture.wc, paths: ["readonly-prop.txt"], message: commitMessage("Add readonly prop target") })).ok).toBe(true);
      expect((await svnPropset({
        cwd: fixture.wc,
        paths: ["readonly-prop.txt"],
        name: "custom:readonly",
        value: "yes"
      })).ok).toBe(true);

      process.env.SVN_AGENT_READONLY = "1";
      const refused = await svnPropset({
        cwd: fixture.wc,
        paths: ["readonly-prop.txt"],
        name: "custom:readonly",
        value: "no"
      });
      const read = await svnPropget({ cwd: fixture.wc, paths: ["readonly-prop.txt"], name: "custom:readonly" });

      expect(refused.ok).toBe(false);
      expect(refused.note).toBe("READONLY instance");
      expect(read.ok).toBe(true);
    } finally {
      if (oldReadonly === undefined) {
        delete process.env.SVN_AGENT_READONLY;
      } else {
        process.env.SVN_AGENT_READONLY = oldReadonly;
      }
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects malformed export revisions before invoking SVN", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const exported = await svnExport({
        cwd: fixture.wc,
        src: pathToFileURL(fixture.repo).href,
        dest: path.join(fixture.root, "exported"),
        revision: "not a revision"
      });

      expect(exported.ok).toBe(false);
      expect(exported.note).toContain("invalid revision");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("requires an explicit acknowledgment for export destinations outside a working copy", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const destination = path.join(fixture.root, "external-export");
      const refused = await svnExport({
        cwd: fixture.wc,
        src: pathToFileURL(fixture.repo).href,
        dest: destination
      });
      expect(refused.ok).toBe(false);
      expect(refused.note).toContain("externalDestAck:true");

      const exported = await svnExport({
        cwd: fixture.wc,
        src: pathToFileURL(fixture.repo).href,
        dest: destination,
        externalDestAck: true
      });
      expect(exported.ok).toBe(true);
      expect(fs.existsSync(destination)).toBe(true);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("treats dash-prefixed export destinations and property values as operands", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const exported = await svnExport({
        cwd: fixture.wc,
        src: pathToFileURL(fixture.repo).href,
        dest: "--force"
      });

      expect(exported.ok).toBe(true);
      expect(fs.existsSync(path.join(fixture.wc, "--force"))).toBe(true);
      expect(fs.existsSync(path.join(fixture.wc, path.basename(fixture.repo)))).toBe(false);

      fs.writeFileSync(path.join(fixture.wc, "dash-property.txt"), "value\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: ["dash-property.txt"] })).ok).toBe(true);
      const set = await svnPropset({
        cwd: fixture.wc,
        paths: ["dash-property.txt"],
        name: "custom:dash-value",
        value: "--force"
      });
      const got = await svnPropget({ cwd: fixture.wc, paths: ["dash-property.txt"], name: "custom:dash-value" });

      expect(set.ok).toBe(true);
      expect(got.properties).toEqual([{ path: "dash-property.txt", name: "custom:dash-value", value: "--force" }]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("returns EOL diagnostics when svn diff fails on inconsistent line endings", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const file = path.join(fixture.wc, "mixed-eol.txt");
      fs.writeFileSync(file, "one\r\ntwo\r\n", "utf8");

      expect((await svnAdd({ cwd: fixture.wc, paths: ["mixed-eol.txt"] })).ok).toBe(true);
      expect((await svnCommit({
        cwd: fixture.wc,
        paths: ["mixed-eol.txt"],
        message: commitMessage("Add mixed EOL fixture")
      })).ok).toBe(true);
      execFileSync(svnExecutable(), ["propset", "svn:eol-style", "native", file], { cwd: fixture.wc });
      execFileSync(svnExecutable(), ["commit", "-m", "set native eol", file], { cwd: fixture.wc });

      fs.writeFileSync(file, "one\r\ntwo\nthree\r\n", "utf8");
      const diff = await svnDiff({ cwd: fixture.wc, paths: ["mixed-eol.txt"] });

      expect(diff.ok).toBe(false);
      expect(diff.note).toContain("inconsistent line endings");
      expect(diff.recovery_tool).toBe("eol_fix_verified");
      expect(diff.eol_files[0]?.kind).toBe("mixed");
      expect(diff.eol_files[0]?.mismatch).toBe(true);

      const precommit = await svnPrecommit({ cwd: fixture.wc, paths: ["mixed-eol.txt"] });
      expect(precommit.verdict).toBe("EOL_FIX_NEEDED");
      expect(precommit.note).toContain("svn diff failed");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("derives the EOL converter from svn:eol-style when no target is supplied", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const file = path.join(fixture.wc, "lf.txt");
      fs.writeFileSync(file, "one\r\ntwo\r\n", "utf8");

      expect((await svnAdd({ cwd: fixture.wc, paths: ["lf.txt"] })).ok).toBe(true);
      execFileSync(svnExecutable(), ["propset", "svn:eol-style", "LF", file], { cwd: fixture.wc });

      const check = await eolCheck({ cwd: fixture.wc, paths: ["lf.txt"] });
      expect(check.files[0]?.mismatch).toBe(true);

      const fixed = await eolFixVerified({ cwd: fixture.wc, path: "lf.txt" });
      const after = fixed.after as { kind?: string } | undefined;

      expect(fixed.ok).toBe(true);
      expect(fixed.converter).toBe("dos2unix");
      expect(fixed.target).toBe("lf");
      expect(fixed.command.toLowerCase()).toContain("dos2unix");
      expect(fixed.command.toLowerCase()).not.toContain("powershell");
      expect(after?.kind).toBe("lf");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not call an EOL repair pure when a property-only diff remains", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const file = path.join(fixture.wc, "property-eol.txt");
      fs.writeFileSync(file, "one\r\ntwo\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: ["property-eol.txt"] })).ok).toBe(true);
      expect((await svnPropsetEolStyle({ cwd: fixture.wc, paths: ["property-eol.txt"], style: "LF" })).ok).toBe(true);

      const fixed = await eolFixVerified({ cwd: fixture.wc, path: "property-eol.txt" });
      expect(fixed.ok).toBe(true);
      expect(fixed.pure_eol_churn).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("applies never-commit guards to EOL property writes", async () => {
    const fixture = createTempWorkingCopy();
    try {
      fs.writeFileSync(path.join(fixture.wc, "private.key"), "secret\r\n", "utf8");
      const result = await svnPropsetEolStyle({ cwd: fixture.wc, paths: ["private.key"] });
      expect(result.ok).toBe(false);
      expect(result.note).toContain("never-commit path");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("applies never-commit guards to verified EOL repair", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const file = path.join(fixture.wc, "private.key");
      fs.writeFileSync(file, "secret\n", "utf8");

      const result = await eolFixVerified({ cwd: fixture.wc, path: "private.key", target: "crlf" });

      expect(result.ok).toBe(false);
      expect(result.note).toContain("never-commit path");
      expect(fs.readFileSync(file, "utf8")).toBe("secret\n");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("repairs and verifies large text files without loading them as one buffer", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const file = path.join(fixture.wc, "large-eol.txt");
      fs.writeFileSync(file, "large line\n".repeat(500_000), "utf8");

      const result = await eolFixVerified({
        cwd: fixture.wc,
        path: "large-eol.txt",
        target: "crlf",
        allowLarge: true
      });

      expect(result).toMatchObject({ ok: true, target: "crlf" });
      expect(result.after).toMatchObject({ kind: "crlf", has_bom: false });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("sets EOL style on remaining paths when one path already matches", async () => {
    const fixture = createTempWorkingCopy();
    try {
      fs.writeFileSync(path.join(fixture.wc, "already-lf.txt"), "one\r\n", "utf8");
      fs.writeFileSync(path.join(fixture.wc, "needs-lf.txt"), "two\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: ["already-lf.txt", "needs-lf.txt"] })).ok).toBe(true);
      expect((await svnPropsetEolStyle({ cwd: fixture.wc, paths: ["already-lf.txt"], style: "LF" })).ok).toBe(true);

      const updated = await svnPropsetEolStyle({
        cwd: fixture.wc,
        paths: ["already-lf.txt", "needs-lf.txt"],
        style: "LF"
      });
      const properties = await svnPropget({
        cwd: fixture.wc,
        paths: ["already-lf.txt", "needs-lf.txt"],
        name: "svn:eol-style"
      });

      expect(updated.ok).toBe(true);
      expect(properties.properties).toEqual([
        { path: "already-lf.txt", name: "svn:eol-style", value: "LF" },
        { path: "needs-lf.txt", name: "svn:eol-style", value: "LF" }
      ]);
      expect((await svnPropsetEolStyle({
        cwd: fixture.wc,
        paths: ["already-lf.txt", "needs-lf.txt"],
        style: "LF"
      })).ok).toBe(true);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses svn:eol-style on directories", async () => {
    const fixture = createTempWorkingCopy();
    try {
      fs.mkdirSync(path.join(fixture.wc, "eol-directory"));
      const result = await svnPropsetEolStyle({ cwd: fixture.wc, paths: ["eol-directory"] });
      expect(result).toMatchObject({ ok: false });
      expect(result.note).toContain("requires a regular file");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("allows EOL repair dry runs in readonly mode without changing the file", async () => {
    const fixture = createTempWorkingCopy();
    const oldReadonly = process.env.SVN_AGENT_READONLY;
    try {
      const file = path.join(fixture.wc, "readonly-eol.txt");
      fs.writeFileSync(file, "one\r\ntwo\r\n", "utf8");
      process.env.SVN_AGENT_READONLY = "1";

      const dryRun = await eolFixVerified({ cwd: fixture.wc, path: "readonly-eol.txt", target: "lf", dryRun: true });

      expect(dryRun).toMatchObject({ ok: true, target: "lf" });
      expect(fs.readFileSync(file, "utf8")).toBe("one\r\ntwo\r\n");
    } finally {
      if (oldReadonly === undefined) {
        delete process.env.SVN_AGENT_READONLY;
      } else {
        process.env.SVN_AGENT_READONLY = oldReadonly;
      }
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("returns a structured EOL repair refusal for missing files", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const fixed = await eolFixVerified({ cwd: fixture.wc, path: "missing.txt" });

      expect(fixed.ok).toBe(false);
      expect(fixed.command).toBe("eol_fix_verified");
      expect(fixed.note).toContain("path does not exist");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("moves, renames, and copies working-copy files with parent directories", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const file = path.join(fixture.wc, "source.txt");
      fs.writeFileSync(file, "one\r\n", "utf8");

      expect((await svnAdd({ cwd: fixture.wc, paths: ["source.txt"] })).ok).toBe(true);
      expect((await svnCommit({ cwd: fixture.wc, paths: ["source.txt"], message: commitMessage("Add source") })).ok).toBe(true);

      const moved = await svnMove({ cwd: fixture.wc, src: "source.txt", dest: "moved/source.txt" });
      expect(moved.ok).toBe(true);
      expectSvnArgs(moved.command, "move --parents --");
      expect(statusByPath(moved.changed_paths, fixture.wc).get("source.txt")).toBe("D");
      expect(statusByPath(moved.changed_paths, fixture.wc).get("moved/source.txt")).toBe("A");
      expect((await svnCommit({
        cwd: fixture.wc,
        paths: ["source.txt", "moved/source.txt"],
        message: commitMessage("Move source"),
        riskAck: true
      })).ok).toBe(true);

      const copied = await svnCopy({ cwd: fixture.wc, src: "moved/source.txt", dest: "copies/source-copy.txt" });
      expect(copied.ok).toBe(true);
      expectSvnArgs(copied.command, "copy --parents --");
      expect(statusByPath(copied.changed_paths, fixture.wc).get("copies/source-copy.txt")).toBe("A");
      expect((await svnCommit({
        cwd: fixture.wc,
        paths: ["copies/source-copy.txt"],
        message: commitMessage("Copy source")
      })).ok).toBe(true);

      const renamed = await svnRename({ cwd: fixture.wc, src: "moved/source.txt", dest: "moved/final.txt" });
      expect(renamed.ok).toBe(true);
      expectSvnArgs(renamed.command, "move --parents --");
      expect(statusByPath(renamed.changed_paths, fixture.wc).get("moved/source.txt")).toBe("D");
      expect(statusByPath(renamed.changed_paths, fixture.wc).get("moved/final.txt")).toBe("A");
      expect((await svnCommit({
        cwd: fixture.wc,
        paths: ["moved/source.txt", "moved/final.txt"],
        message: commitMessage("Rename source"),
        riskAck: true
      })).ok).toBe(true);

      const blocked = await svnCopy({ cwd: fixture.wc, src: "moved/final.txt", dest: ".env" });
      expect(blocked.ok).toBe(false);
      expect(blocked.note).toContain("never-commit path");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("normalizes commit message files before invoking svn", async () => {
    const fixture = createTempWorkingCopy();
    try {
      fs.writeFileSync(path.join(fixture.wc, "message-eol.txt"), "one\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: ["message-eol.txt"] })).ok).toBe(true);

      const committed = await svnCommit({
        cwd: fixture.wc,
        paths: ["message-eol.txt"],
        message: "Add message EOL fixture\r\n\r\n- First line uses CRLF\r\n- Second line uses LF\n- Verified by integration test\r\n"
      });

      expect(committed.ok).toBe(true);
      expect(committed.note).not.toContain("inconsistent line endings");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("redacts secrets from diff excerpts returned by diff and precommit", async () => {
    const fixture = createTempWorkingCopy();
    try {
      fs.writeFileSync(path.join(fixture.wc, "url-redaction.txt"), "safe\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: ["url-redaction.txt"] })).ok).toBe(true);
      expect((await svnCommit({
        cwd: fixture.wc,
        paths: ["url-redaction.txt"],
        message: commitMessage("Add redaction fixture")
      })).ok).toBe(true);

      fs.writeFileSync(
        path.join(fixture.wc, "url-redaction.txt"),
        "https://user:secret@example.com/repo?token=abc123&apikey=def456\r\n",
        "utf8"
      );

      const diff = await svnDiff({ cwd: fixture.wc, paths: ["url-redaction.txt"] });
      expect(diff.ok).toBe(true);
      expect(diff.diff_excerpt).toContain("https://***:***@example.com/repo?token=***&apikey=***");
      expect(diff.diff_excerpt).not.toContain("secret");
      expect(diff.diff_excerpt).not.toContain("abc123");
      expect(diff.diff_excerpt).not.toContain("def456");

      const precommit = await svnPrecommit({ cwd: fixture.wc, paths: ["url-redaction.txt"] });
      expect(precommit.diff_excerpt).toContain("https://***:***@example.com/repo?token=***&apikey=***");
      expect(precommit.diff_excerpt).not.toContain("secret");
      expect(precommit.diff_excerpt).not.toContain("abc123");
      expect(precommit.diff_excerpt).not.toContain("def456");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("returns envelopes when mutation targets disappear before stat", async () => {
    const fixture = createTempWorkingCopy();
    const originalStatSync = fs.statSync.bind(fs);
    let statSpy: jest.SpiedFunction<typeof fs.statSync> | null = null;
    try {
      const vanishingAdd = path.join(fixture.wc, "vanishing-add.txt");
      const vanishingImport = path.join(fixture.root, "vanishing-import");
      fs.writeFileSync(vanishingAdd, "gone\r\n", "utf8");
      fs.mkdirSync(vanishingImport);
      const failPaths = new Set([
        path.resolve(vanishingAdd).toLowerCase(),
        path.resolve(vanishingImport).toLowerCase()
      ]);

      statSpy = jest.spyOn(fs, "statSync");
      (statSpy as unknown as { mockImplementation: (fn: (...args: unknown[]) => unknown) => void }).mockImplementation(
        (target: unknown, options?: unknown) => {
          const targetPath = path.resolve(String(target)).toLowerCase();
          if (failPaths.has(targetPath)) {
            throw Object.assign(new Error("simulated stat race"), { code: "ENOENT" });
          }
          return originalStatSync(target as fs.PathLike, options as fs.StatSyncOptions);
        }
      );

      const added = await svnAdd({ cwd: fixture.wc, paths: ["vanishing-add.txt"] });
      expect(added.ok).toBe(false);
      expect(added.note).toContain("path stat failed before svn command");

      const imported = await svnImport({
        cwd: fixture.wc,
        src: vanishingImport,
        url: `${pathToFileURL(fixture.repo).href}/imported`,
        message: commitMessage("Import stat race")
      });
      expect(imported.ok).toBe(false);
      expect(imported.note).toContain("path stat failed before svn command");
    } finally {
      statSpy?.mockRestore();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("reverts mixed file and directory targets without applying recursive depth to files", async () => {
    const fixture = createTempWorkingCopy();
    try {
      fs.mkdirSync(path.join(fixture.wc, "dir"), { recursive: true });
      fs.writeFileSync(path.join(fixture.wc, "dir", "nested.txt"), "one\r\n", "utf8");
      fs.writeFileSync(path.join(fixture.wc, "file.txt"), "one\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: ["dir/nested.txt"] })).ok).toBe(true);
      expect((await svnAdd({ cwd: fixture.wc, paths: ["file.txt"] })).ok).toBe(true);
      expect((await svnCommit({
        cwd: fixture.wc,
        paths: ["dir/nested.txt", "file.txt"],
        message: commitMessage("Add revert fixture"),
        riskAck: true
      })).ok).toBe(true);

      fs.writeFileSync(path.join(fixture.wc, "dir", "nested.txt"), "two\r\n", "utf8");
      fs.writeFileSync(path.join(fixture.wc, "file.txt"), "two\r\n", "utf8");
      const refused = await svnRevert({ cwd: fixture.wc, paths: ["dir", "file.txt"], allowRecursive: true, dryRun: false });
      expect(refused).toMatchObject({ ok: false, code: "RISK_ACK_REQUIRED" });
      expect(fs.readFileSync(path.join(fixture.wc, "dir", "nested.txt"), "utf8")).toBe("two\r\n");

      const reverted = await svnRevert({
        cwd: fixture.wc,
        paths: ["dir", "file.txt"],
        allowRecursive: true,
        dryRun: false,
        riskAck: true
      });

      expect(reverted.ok).toBe(true);
      expect(reverted.command).toContain("--depth infinity --");
      expect(fs.readFileSync(path.join(fixture.wc, "dir", "nested.txt"), "utf8")).toBe("one\r\n");
      expect(fs.readFileSync(path.join(fixture.wc, "file.txt"), "utf8")).toBe("one\r\n");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("previews and performs guarded file and directory deletes", async () => {
    const fixture = createTempWorkingCopy();
    try {
      fs.mkdirSync(path.join(fixture.wc, "delete-dir"));
      fs.writeFileSync(path.join(fixture.wc, "delete-file.txt"), "one\r\n", "utf8");
      fs.writeFileSync(path.join(fixture.wc, "delete-dir", "nested.txt"), "one\r\n", "utf8");
      expect((await svnAdd({
        cwd: fixture.wc,
        paths: ["delete-file.txt", "delete-dir/nested.txt"]
      })).ok).toBe(true);
      expect((await svnCommit({
        cwd: fixture.wc,
        paths: ["delete-file.txt", "delete-dir/nested.txt"],
        message: commitMessage("Add delete fixtures")
      })).ok).toBe(true);

      const preview = await svnDelete({ cwd: fixture.wc, paths: ["delete-file.txt"] });
      expect(preview).toMatchObject({ ok: true, dry_run: true });
      expect(fs.existsSync(path.join(fixture.wc, "delete-file.txt"))).toBe(true);

      const missingAck = await svnDelete({ cwd: fixture.wc, paths: ["delete-file.txt"], dryRun: false });
      expect(missingAck).toMatchObject({ ok: false });
      expect(missingAck.note).toContain("riskAck required");

      const missingRecursiveAck = await svnDelete({
        cwd: fixture.wc,
        paths: ["delete-dir"],
        dryRun: false,
        riskAck: true
      });
      expect(missingRecursiveAck).toMatchObject({ ok: false });
      expect(missingRecursiveAck.note).toContain("allowRecursive:true");

      const rootRefusal = await svnDelete({
        cwd: fixture.wc,
        paths: ["."],
        dryRun: false,
        allowRecursive: true,
        riskAck: true
      });
      expect(rootRefusal).toMatchObject({ ok: false });
      expect(rootRefusal.note).toContain("working-copy root");

      const deletedFile = await svnDelete({
        cwd: fixture.wc,
        paths: ["delete-file.txt"],
        dryRun: false,
        riskAck: true
      });
      expect(deletedFile).toMatchObject({ ok: true, post_status_verified: true });
      expect(statusByPath(deletedFile.changed_paths, fixture.wc).get("delete-file.txt")).toBe("D");
      const committedDeletion = await svnCommit({
        cwd: fixture.wc,
        paths: ["delete-file.txt"],
        message: commitMessage("Commit deleted file"),
        riskAck: true
      });
      expect(committedDeletion).toMatchObject({
        ok: true,
        committed_paths: ["delete-file.txt"],
        committed_count: 1,
        post_status_clean: true
      });

      const deletedDirectory = await svnDelete({
        cwd: fixture.wc,
        paths: ["delete-dir"],
        dryRun: false,
        allowRecursive: true,
        riskAck: true
      });
      expect(deletedDirectory).toMatchObject({ ok: true, post_status_verified: true });
      expect(statusByPath(deletedDirectory.changed_paths, fixture.wc).get("delete-dir")).toBe("D");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses directory commit targets that would exclude changed descendants", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const directory = path.join(fixture.wc, "commit-dir");
      const child = path.join(directory, "child.txt");
      fs.mkdirSync(directory);
      fs.writeFileSync(child, "one\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: ["commit-dir/child.txt"] })).ok).toBe(true);
      expect((await svnCommit({
        cwd: fixture.wc,
        paths: ["commit-dir/child.txt"],
        message: commitMessage("Add directory commit fixture")
      })).ok).toBe(true);

      fs.writeFileSync(child, "two\r\n", "utf8");
      expect((await svnPropset({
        cwd: fixture.wc,
        paths: ["commit-dir"],
        name: "custom:directory",
        value: "changed"
      })).ok).toBe(true);

      const precommitRefused = await svnPrecommit({ cwd: fixture.wc, paths: ["commit-dir"] });
      expect(precommitRefused).toMatchObject({ ok: false, verdict: "GUARD_BLOCKED" });
      expect(precommitRefused.note).toContain("allowDirectoryTargets:true");
      const precommitAcknowledged = await svnPrecommit({
        cwd: fixture.wc,
        paths: ["commit-dir"],
        allowDirectoryTargets: true
      });
      expect(precommitAcknowledged).toMatchObject({ ok: true, verdict: "READY" });

      const refused = await svnCommit({
        cwd: fixture.wc,
        paths: ["commit-dir"],
        message: commitMessage("Attempt directory-only commit")
      });
      expect(refused).toMatchObject({ ok: false });
      expect(refused.note).toContain("allowDirectoryTargets:true");
      const remaining = await svnStatus({ cwd: fixture.wc, paths: ["commit-dir/child.txt"] });
      expect(statusByPath(remaining.changed_paths, fixture.wc).get("commit-dir/child.txt")).toBe("M");

      const acknowledged = await svnCommit({
        cwd: fixture.wc,
        paths: ["commit-dir"],
        message: commitMessage("Commit directory property only"),
        allowDirectoryTargets: true
      });
      expect(acknowledged).toMatchObject({ ok: true, post_status_clean: false });
      expect(acknowledged.command).toContain("--depth empty");
      const descendantAfterCommit = await svnStatus({ cwd: fixture.wc, paths: ["commit-dir/child.txt"] });
      expect(statusByPath(descendantAfterCommit.changed_paths, fixture.wc).get("commit-dir/child.txt")).toBe("M");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("expands an explicit directory to its changed descendants without including siblings", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const directory = path.join(fixture.wc, "expanded scope");
      const nested = path.join(directory, "nested");
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(directory, "one.txt"), "one\r\n", "utf8");
      fs.writeFileSync(path.join(nested, "two.txt"), "two\r\n", "utf8");
      fs.writeFileSync(path.join(directory, "version.ver"), "1\r\n", "utf8");
      fs.writeFileSync(path.join(fixture.wc, "sibling.txt"), "sibling\r\n", "utf8");
      expect((await svnAdd({
        cwd: fixture.wc,
        paths: ["expanded scope", "sibling.txt"],
        allowRecursive: true
      })).ok).toBe(true);
      expect((await svnCommit({
        cwd: fixture.wc,
        paths: ["expanded scope/one.txt", "expanded scope/nested/two.txt", "expanded scope/version.ver", "sibling.txt"],
        message: commitMessage("Add expansion fixtures"),
        riskAck: true
      })).ok).toBe(true);

      fs.writeFileSync(path.join(directory, "one.txt"), "one changed\r\n", "utf8");
      fs.writeFileSync(path.join(nested, "two.txt"), "two changed\r\n", "utf8");
      fs.writeFileSync(path.join(directory, "version.ver"), "2\r\n", "utf8");
      fs.writeFileSync(path.join(directory, "untracked.tmp"), "not scheduled\r\n", "utf8");
      fs.writeFileSync(path.join(fixture.wc, "sibling.txt"), "sibling changed\r\n", "utf8");

      const precommit = await svnPrecommit({
        cwd: fixture.wc,
        paths: ["expanded scope"],
        expandDescendants: true
      });
      expect(precommit).toMatchObject({ ok: true, verdict: "READY", scope_expanded: true });
      expect(precommit.expanded_paths).toEqual([
        "expanded scope/nested/two.txt",
        "expanded scope/one.txt",
        "expanded scope/version.ver"
      ]);
      expect(precommit.expanded_paths).not.toContain("expanded scope/untracked.tmp");
      expect(precommit.risk_signals).toContain("version file touched");

      const committed = await svnCommit({
        cwd: fixture.wc,
        paths: ["expanded scope"],
        message: commitMessage("Commit expanded descendants"),
        expandDescendants: true,
        riskAck: true
      });
      expect(committed).toMatchObject({ ok: true, scope_expanded: true, post_status_clean: true });
      expect(committed.expanded_paths).toEqual([
        "expanded scope/nested/two.txt",
        "expanded scope/one.txt",
        "expanded scope/version.ver"
      ]);
      expect(committed.committed_paths).toEqual(expect.arrayContaining([
        "expanded scope/nested/two.txt",
        "expanded scope/one.txt",
        "expanded scope/version.ver"
      ]));

      const remaining = await svnStatus({ cwd: fixture.wc });
      expect(statusByPath(remaining.changed_paths, fixture.wc).get("sibling.txt")).toBe("M");
      expect(statusByPath(remaining.changed_paths, fixture.wc).get("expanded scope/untracked.tmp")).toBe("?");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses a never-commit descendant discovered while expanding a directory", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const directory = path.join(fixture.wc, "guarded scope");
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "safe.txt"), "safe\r\n", "utf8");
      fs.writeFileSync(path.join(directory, ".env"), "SECRET=example\r\n", "utf8");
      execFileSync(svnExecutable(), ["add", "--force", "--no-ignore", "--", directory], { cwd: fixture.wc });

      const precommit = await svnPrecommit({
        cwd: fixture.wc,
        paths: ["guarded scope"],
        expandDescendants: true
      });
      expect(precommit).toMatchObject({ ok: false, verdict: "GUARD_BLOCKED", scope_expanded: true });
      expect(precommit.note).toContain(".env");

      const committed = await svnCommit({
        cwd: fixture.wc,
        paths: ["guarded scope"],
        message: commitMessage("Attempt guarded expansion"),
        expandDescendants: true
      });
      expect(committed).toMatchObject({ ok: false });
      expect(committed.note).toContain(".env");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("supports bounded revision inspection, snapshots, and commit root guards", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const file = path.join(fixture.wc, "history.txt");
      fs.writeFileSync(file, "one\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: ["history.txt"] })).ok).toBe(true);
      const firstCommit = await svnCommit({
        cwd: fixture.wc,
        paths: ["history.txt"],
        message: commitMessage("Add history fixture")
      });
      expect(firstCommit.ok).toBe(true);

      fs.writeFileSync(file, "one\r\ntwo\r\n", "utf8");
      const blankMessage = await svnCommit({ cwd: fixture.wc, paths: ["history.txt"], message: "   " });
      expect(blankMessage).toMatchObject({ ok: false });
      expect(blankMessage.note).toContain("non-empty commit message");

      const secondCommit = await svnCommit({
        cwd: fixture.wc,
        paths: ["history.txt"],
        message: commitMessage("Extend history fixture")
      });
      expect(secondCommit.ok).toBe(true);
      const firstRevision = String(firstCommit.revision);
      const secondRevision = String(secondCommit.revision);

      const exactLog = await svnLog({ cwd: fixture.wc, paths: ["history.txt"], revision: firstRevision });
      expect(exactLog.ok).toBe(true);
      expect(exactLog.entries).toHaveLength(1);
      expect((exactLog.entries as Array<{ rev: number }>)[0]?.rev).toBe(firstCommit.revision);

      const filteredLog = await svnLog({
        cwd: fixture.wc,
        paths: ["history.txt"],
        limit: 1,
        messageContains: "add HISTORY fixture"
      });
      expect(filteredLog).toMatchObject({ ok: true, entry_count: 1, scan_truncated: false });
      expect((filteredLog.entries as Array<{ rev: number }>)[0]?.rev).toBe(firstCommit.revision);

      const caseSensitiveMiss = await svnLog({
        cwd: fixture.wc,
        paths: ["history.txt"],
        messageContains: "add HISTORY fixture",
        messageCaseSensitive: true
      });
      expect(caseSensitiveMiss).toMatchObject({ ok: true, entry_count: 0, scan_truncated: false });

      const firstFilteredPage = await svnLog({
        cwd: fixture.wc,
        paths: ["history.txt"],
        limit: 1,
        scanLimit: 1,
        messageContains: "Add history fixture"
      });
      expect(firstFilteredPage).toMatchObject({
        ok: true,
        entry_count: 0,
        scanned_count: 1,
        scan_truncated: true,
        has_more: true
      });
      expect(firstFilteredPage.next_cursor).toEqual(expect.any(String));
      const secondFilteredPage = await svnLog({
        cwd: fixture.wc,
        paths: ["history.txt"],
        limit: 1,
        scanLimit: 1,
        messageContains: "Add history fixture",
        cursor: String(firstFilteredPage.next_cursor)
      });
      expect((secondFilteredPage.entries as Array<{ rev: number }>)[0]?.rev).toBe(firstCommit.revision);

      const revisionDiff = await svnDiff({ cwd: fixture.wc, paths: ["history.txt"], revision: secondRevision });
      expect(revisionDiff.ok).toBe(true);
      expect(revisionDiff.per_file).toEqual([
        expect.objectContaining({ path: expect.stringContaining("history.txt"), added: 1, removed: 0 })
      ]);

      const historicalFile = await svnCat({ cwd: fixture.wc, path: "history.txt", revision: firstRevision });
      expect(historicalFile).toMatchObject({ ok: true, content: "one\r\n", has_more: false });

      const blame = await svnBlame({ cwd: fixture.wc, path: "history.txt", revision: secondRevision, maxLines: 1 });
      expect(blame).toMatchObject({ ok: true, has_more: true, next_cursor: "1" });
      expect(blame.lines).toEqual([
        expect.objectContaining({ line: 1, revision: firstCommit.revision })
      ]);

      fs.writeFileSync(file, "one\r\ntwo\r\nthree\r\n", "utf8");
      const snapshot = await svnSnapshot({ cwd: fixture.wc, paths: ["history.txt"] });
      expect(snapshot).toMatchObject({ ok: true, revision: secondCommit.revision, local_modifications: true });
      expect(statusByPath(snapshot.changed_paths, fixture.wc).get("history.txt")).toBe("M");

      expect((await svnPropset({
        cwd: fixture.wc,
        paths: ["."],
        name: "custom:root",
        value: "changed"
      })).ok).toBe(true);
      const precommitRoot = await svnPrecommit({ cwd: fixture.wc, paths: ["."] });
      expect(precommitRoot).toMatchObject({ ok: false, verdict: "GUARD_BLOCKED" });
      expect(precommitRoot.note).toContain("allowRoot:true");
      const precommitRootAcknowledged = await svnPrecommit({
        cwd: fixture.wc,
        paths: ["."],
        allowRoot: true,
        allowDirectoryTargets: true
      });
      expect(precommitRootAcknowledged).toMatchObject({ ok: true, verdict: "READY" });
      const blockedRoot = await svnCommit({
        cwd: fixture.wc,
        paths: ["."],
        message: commitMessage("Change root property")
      });
      expect(blockedRoot).toMatchObject({ ok: false });
      expect(blockedRoot.note).toContain("allowRoot:true");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("pages stable diff evidence without rerunning a changed working file", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const relative = "diff evidence.txt";
      const file = path.join(fixture.wc, relative);
      fs.writeFileSync(file, "one\r\ntwo\r\nthree\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: [relative] })).ok).toBe(true);
      expect((await svnCommit({
        cwd: fixture.wc,
        paths: [relative],
        message: commitMessage("Add diff evidence fixture")
      })).ok).toBe(true);

      fs.writeFileSync(file, "one changed\r\ntwo changed\r\nthree changed\r\nfour\r\n", "utf8");
      const first = await svnDiff({ cwd: fixture.wc, paths: ["."], file: relative, lineLimit: 5 });
      expect(first).toMatchObject({
        ok: true,
        operation_id: expect.any(String),
        evidence_expires_at: expect.any(Number),
        total_files: 1,
        total_hunks: 1
      });
      expect(first.next_cursor).toEqual(expect.any(String));

      fs.writeFileSync(file, "AFTER THE SNAPSHOT\r\n", "utf8");
      const second = await svnDiff({
        cwd: fixture.wc,
        paths: ["."],
        file: relative,
        lineLimit: 50,
        cursor: String(first.next_cursor),
        operationId: String(first.operation_id)
      });
      expect(second.ok).toBe(true);
      expect(second.operation_id).toBe(first.operation_id);
      expect(second.diff_excerpt).not.toContain("AFTER THE SNAPSHOT");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps exact ignored descendants visible without misreporting missing paths", async () => {
    const fixture = createTempWorkingCopy();
    try {
      execFileSync(svnExecutable(), ["propset", "svn:ignore", "waste space", "--", fixture.wc], { cwd: fixture.wc });
      const ignoredDirectory = path.join(fixture.wc, "waste space");
      const ignoredChild = path.join(ignoredDirectory, "nested", "report.txt");
      fs.mkdirSync(path.dirname(ignoredChild), { recursive: true });
      fs.writeFileSync(ignoredChild, "ignored\r\n", "utf8");
      fs.writeFileSync(path.join(fixture.wc, "unversioned file.txt"), "new\r\n", "utf8");
      fs.writeFileSync(path.join(fixture.wc, "versioned file.txt"), "tracked\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: ["versioned file.txt"] })).ok).toBe(true);
      expect((await svnCommit({
        cwd: fixture.wc,
        paths: ["versioned file.txt"],
        message: commitMessage("Add status fixture")
      })).ok).toBe(true);

      const childStatus = await svnStatus({
        cwd: fixture.wc,
        paths: ["waste space/nested/report.txt"],
        includeIgnored: true
      });
      expect(childStatus.ok).toBe(true);
      expect(childStatus.note).toContain("W155010");
      expect(childStatus.stderr_summary).toContain("W155010");
      expect(childStatus.changed_paths).toEqual([
        expect.objectContaining({
          status: "I",
          path: ignoredChild,
          covered_by_ignored_ancestor: true,
          ignored_ancestor: "waste space"
        })
      ]);

      const directoryStatus = await svnStatus({ cwd: fixture.wc, paths: ["waste space"], includeIgnored: true });
      expect(statusByPath(directoryStatus.changed_paths, fixture.wc).get("waste space")).toBe("I");

      const missingStatus = await svnStatus({ cwd: fixture.wc, paths: ["missing file.txt"], includeIgnored: true });
      expect(missingStatus).toMatchObject({ ok: true, changed_paths: [] });

      const unversionedStatus = await svnStatus({ cwd: fixture.wc, paths: ["unversioned file.txt"], includeIgnored: true });
      expect(statusByPath(unversionedStatus.changed_paths, fixture.wc).get("unversioned file.txt")).toBe("?");

      const versionedStatus = await svnStatus({ cwd: fixture.wc, paths: ["versioned file.txt"], includeIgnored: true });
      expect(versionedStatus).toMatchObject({ ok: true, changed_paths: [], note: "" });
      expect(versionedStatus.stderr_summary).toBe("");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("pins updates when remote HEAD advances and keeps conflicts postponed", async () => {
    const fixture = createTempWorkingCopy();
    const peer = path.join(fixture.root, "peer working copy");
    try {
      const relativePath = "release notes.txt";
      const localFile = path.join(fixture.wc, relativePath);
      fs.writeFileSync(localFile, "one\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: [relativePath] })).ok).toBe(true);
      expect((await svnCommit({
        cwd: fixture.wc,
        paths: [relativePath],
        message: commitMessage("Add release fixture")
      })).ok).toBe(true);

      execFileSync(svnExecutable(), ["checkout", pathToFileURL(fixture.repo).href, peer], { cwd: fixture.root });
      const peerFile = path.join(peer, relativePath);
      fs.writeFileSync(peerFile, "two\r\n", "utf8");
      execFileSync(svnExecutable(), ["commit", "-m", "remote revision two", "--", peerFile], { cwd: peer });

      const initialProbe = await svnInfo({ cwd: fixture.wc, paths: [relativePath] });
      const probedHead = Number(initialProbe.remote_head_revision);
      expect(probedHead).toBeGreaterThan(0);

      fs.writeFileSync(peerFile, "three\r\n", "utf8");
      execFileSync(svnExecutable(), ["commit", "-m", "remote revision three", "--", peerFile], { cwd: peer });
      const advancedHead = Number((await svnInfo({ cwd: fixture.wc, paths: [relativePath] })).remote_head_revision);
      expect(advancedHead).toBeGreaterThan(probedHead);

      const unpinnedGuard = await svnUpdate({ cwd: fixture.wc, updateAll: true, expectedRemoteHead: advancedHead });
      expect(unpinnedGuard).toMatchObject({ ok: false });
      expect(unpinnedGuard.note).toContain("numeric revision");

      const staleGuard = await svnUpdate({
        cwd: fixture.wc,
        updateAll: true,
        revision: String(probedHead),
        expectedRemoteHead: probedHead
      });
      expect(staleGuard).toMatchObject({ ok: false, expected_remote_head: probedHead, observed_remote_head: advancedHead });
      expect(staleGuard.note).toContain("remote HEAD changed");

      const invalidRange = await svnUpdate({ cwd: fixture.wc, updateAll: true, revision: `${probedHead}:${advancedHead}` });
      expect(invalidRange).toMatchObject({ ok: false, note: "invalid revision selector" });

      const updateOperationId = randomUUID();
      const pinned = await svnUpdate({
        cwd: fixture.wc,
        updateAll: true,
        revision: String(probedHead),
        expectedRemoteHead: advancedHead,
        operationId: updateOperationId
      });
      expect(pinned).toMatchObject({
        ok: true,
        requested_revision: String(probedHead),
        resulting_revision: probedHead,
        revision_range: { min: probedHead, max: probedHead },
        mixed_revision: false,
        expected_remote_head: advancedHead,
        observed_remote_head: advancedHead
      });
      expectSvnArgs(pinned.command, `update -r ${probedHead} --accept postpone`);
      expect(fs.readFileSync(localFile, "utf8")).toBe("two\r\n");
      const pinnedReplay = await svnUpdate({
        cwd: fixture.wc,
        updateAll: true,
        revision: String(probedHead),
        expectedRemoteHead: advancedHead,
        operationId: updateOperationId
      });
      expect(pinnedReplay).toMatchObject({
        ok: true,
        resulting_revision: probedHead,
        operation_id: updateOperationId,
        idempotent_replay: true
      });

      const rangeLog = await svnLog({
        cwd: fixture.wc,
        paths: [relativePath],
        revision: `${advancedHead}:${probedHead}`,
        changedPaths: true
      });
      expect(rangeLog).toMatchObject({
        ok: true,
        revision: null,
        entry_count: 2,
        revision_range: { min: probedHead, max: advancedHead }
      });
      expect(rangeLog.changed_paths).toEqual([]);
      expect((rangeLog.entries as Array<{ changed_paths: unknown[] }>).every((entry) => entry.changed_paths.length > 0)).toBe(true);

      const exactLog = await svnLog({ cwd: fixture.wc, paths: [relativePath], revision: String(probedHead) });
      expect(exactLog).toMatchObject({ revision: probedHead, entry_count: 1 });

      fs.writeFileSync(localFile, "mine\r\n", "utf8");
      const conflicted = await svnUpdate({ cwd: fixture.wc, paths: [relativePath], revision: String(advancedHead) });
      expect(conflicted.ok).toBe(true);
      expectSvnArgs(conflicted.command, `update -r ${advancedHead} --accept postpone --`);
      expect(conflicted.conflicts.length).toBeGreaterThan(0);
      expect(conflicted.note).toContain("conflicts present");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("reports same-path collisions against a captured pre-edit baseline", async () => {
    const fixture = createTempWorkingCopy();
    const peer = path.join(fixture.root, "baseline collision peer");
    try {
      const relativePath = "collision scope/shared.txt";
      const localFile = path.join(fixture.wc, relativePath);
      fs.mkdirSync(path.dirname(localFile), { recursive: true });
      fs.writeFileSync(localFile, "alpha\r\nbeta\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: [relativePath] })).ok).toBe(true);
      expect((await svnCommit({
        cwd: fixture.wc,
        paths: [relativePath],
        message: commitMessage("Add collision fixture")
      })).ok).toBe(true);

      const baseline = await svnSnapshot({ cwd: fixture.wc, paths: [relativePath], captureBaseline: true });
      execFileSync(svnExecutable(), ["checkout", pathToFileURL(fixture.repo).href, peer], { cwd: fixture.root });
      const peerFile = path.join(peer, relativePath);
      fs.writeFileSync(peerFile, "alpha\r\nremote beta\r\n", "utf8");
      execFileSync(svnExecutable(), ["commit", "-m", "remote collision", "--", peerFile], { cwd: peer });
      const remoteHead = Number((await svnInfo({ cwd: fixture.wc, paths: [relativePath] })).remote_head_revision);

      fs.writeFileSync(localFile, "local alpha\r\nbeta\r\n", "utf8");
      const updated = await svnUpdate({
        cwd: fixture.wc,
        paths: [relativePath],
        revision: String(remoteHead),
        expectedRemoteHead: remoteHead,
        baselineToken: String(baseline.baseline_token)
      });

      expect(updated).toMatchObject({
        ok: true,
        baseline_token: baseline.baseline_token,
        collision: true,
        collision_paths: [relativePath],
        recommended_action: "reconcile-and-reverify"
      });
      expect(updated.path_states).toEqual([
        expect.objectContaining({
          path: relativePath,
          locally_modified_before_update: true,
          remotely_changed_during_update: true,
          same_path_collision: true,
          conflict_postponed: false
        })
      ]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("prepares only explicit commit paths at a pinned revision after remote HEAD advances", async () => {
    const fixture = createTempWorkingCopy();
    const peer = path.join(fixture.root, "prepare peer");
    try {
      const relativePath = "prepared scope/prepared.txt";
      const localFile = path.join(fixture.wc, relativePath);
      fs.mkdirSync(path.dirname(localFile));
      fs.writeFileSync(localFile, "alpha\r\nbeta\r\ngamma\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: [relativePath] })).ok).toBe(true);
      expect((await svnCommit({
        cwd: fixture.wc,
        paths: [relativePath],
        message: commitMessage("Add prepare fixture")
      })).ok).toBe(true);

      execFileSync(svnExecutable(), ["checkout", pathToFileURL(fixture.repo).href, peer], { cwd: fixture.root });
      const peerFile = path.join(peer, relativePath);
      fs.writeFileSync(peerFile, "alpha\r\nremote beta\r\ngamma\r\n", "utf8");
      execFileSync(svnExecutable(), ["commit", "-m", "remote revision two", "--", peerFile], { cwd: peer });
      const probedHead = Number((await svnInfo({ cwd: fixture.wc, paths: [relativePath] })).remote_head_revision);

      fs.writeFileSync(localFile, "local alpha\r\nbeta\r\ngamma\r\n", "utf8");
      fs.writeFileSync(peerFile, "alpha\r\nremote beta\r\nremote gamma\r\n", "utf8");
      execFileSync(svnExecutable(), ["commit", "-m", "remote revision three", "--", peerFile], { cwd: peer });
      const advancedHead = Number((await svnInfo({ cwd: fixture.wc, paths: [relativePath] })).remote_head_revision);
      expect(advancedHead).toBeGreaterThan(probedHead);

      const beforeRefusals = fs.readFileSync(localFile, "utf8");
      const rootRefused = await svnPrepareCommit({
        cwd: fixture.wc,
        paths: ["."],
        revision: String(probedHead),
        expectedRemoteHead: advancedHead
      });
      expect(rootRefused).toMatchObject({ ok: false, verdict: "GUARD_BLOCKED" });
      expect(rootRefused.note).toContain("allowRoot:true");
      expect(fs.readFileSync(localFile, "utf8")).toBe(beforeRefusals);

      const directoryRefused = await svnPrepareCommit({
        cwd: fixture.wc,
        paths: ["prepared scope"],
        revision: String(probedHead),
        expectedRemoteHead: advancedHead
      });
      expect(directoryRefused).toMatchObject({ ok: false, verdict: "GUARD_BLOCKED" });
      expect(directoryRefused.note).toContain("allowDirectoryTargets:true");
      expect(fs.readFileSync(localFile, "utf8")).toBe(beforeRefusals);

      const refused = await svnPrepareCommit({
        cwd: fixture.wc,
        paths: [relativePath],
        revision: String(probedHead),
        expectedRemoteHead: probedHead
      });
      expect(refused).toMatchObject({ ok: false, verdict: "REMOTE_HEAD_CHANGED" });
      expect(fs.readFileSync(localFile, "utf8")).toBe("local alpha\r\nbeta\r\ngamma\r\n");

      const prepared = await svnPrepareCommit({
        cwd: fixture.wc,
        paths: [relativePath],
        revision: String(probedHead),
        expectedRemoteHead: advancedHead
      });
      expect(prepared).toMatchObject({
        ok: true,
        verdict: "READY",
        requested_revision: String(probedHead),
        resulting_revision: probedHead,
        unexpected_touched_paths: [],
        final_commit_scope: [relativePath]
      });
      expect(prepared.conflicts).toEqual([]);
      expect(fs.readFileSync(localFile, "utf8")).toBe("local alpha\r\nremote beta\r\ngamma\r\n");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("optionally blocks precommit until the working copy is pinned to one revision", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const relativePath = "mixed revision.txt";
      const file = path.join(fixture.wc, relativePath);
      fs.writeFileSync(file, "one\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: [relativePath] })).ok).toBe(true);
      const committed = await svnCommit({
        cwd: fixture.wc,
        paths: [relativePath],
        message: commitMessage("Add mixed revision fixture")
      });
      expect(committed.ok).toBe(true);
      fs.writeFileSync(file, "two\r\n", "utf8");

      const compatible = await svnPrecommit({ cwd: fixture.wc, paths: [relativePath] });
      expect(compatible).toMatchObject({ ok: true, verdict: "READY", mixed_revision: true });

      const strict = await svnPrecommit({ cwd: fixture.wc, paths: [relativePath], requireUniformRevision: true });
      expect(strict).toMatchObject({
        ok: false,
        verdict: "REVISION_NORMALIZATION_NEEDED",
        mixed_revision: true
      });
      expect(strict.note).toContain("svn_update");
      expect(strict.remediation).toContain("revision:<pinned-revision>");

      const normalized = await svnUpdate({ cwd: fixture.wc, updateAll: true, revision: String(committed.revision) });
      expect(normalized).toMatchObject({ ok: true, mixed_revision: false });
      const ready = await svnPrecommit({ cwd: fixture.wc, paths: [relativePath], requireUniformRevision: true });
      expect(ready).toMatchObject({ ok: true, verdict: "READY", mixed_revision: false });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("binds a READY precommit token to the exact verified path state", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const relativePath = "bound commit.txt";
      const file = path.join(fixture.wc, relativePath);
      fs.writeFileSync(file, "one\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: [relativePath] })).ok).toBe(true);
      expect((await svnCommit({
        cwd: fixture.wc,
        paths: [relativePath],
        message: commitMessage("Add bound commit fixture")
      })).ok).toBe(true);

      fs.writeFileSync(file, "two\r\n", "utf8");
      expect((await svnPropset({
        cwd: fixture.wc,
        paths: [relativePath],
        name: "custom:bound-state",
        value: "001"
      })).ok).toBe(true);
      const ready = await svnPrecommit({ cwd: fixture.wc, paths: [relativePath] });
      expect(ready).toMatchObject({
        ok: true,
        verdict: "READY",
        precommit_token: expect.stringMatching(/^[0-9a-f-]{36}$/i),
        precommit_expires_at: expect.any(Number)
      });

      expect((await svnPropset({
        cwd: fixture.wc,
        paths: [relativePath],
        name: "custom:bound-state",
        value: "1"
      })).ok).toBe(true);
      const numericPropertyChanged = await svnCommit({
        cwd: fixture.wc,
        paths: [relativePath],
        message: commitMessage("Commit bound state"),
        precommitToken: String(ready.precommit_token)
      });
      expect(numericPropertyChanged).toMatchObject({ ok: false, code: "PRECOMMIT_STATE_CHANGED" });
      expect((await svnPropset({
        cwd: fixture.wc,
        paths: [relativePath],
        name: "custom:bound-state",
        value: " 001 "
      })).ok).toBe(true);
      const whitespacePropertyChanged = await svnCommit({
        cwd: fixture.wc,
        paths: [relativePath],
        message: commitMessage("Commit bound state"),
        precommitToken: String(ready.precommit_token)
      });
      expect(whitespacePropertyChanged).toMatchObject({ ok: false, code: "PRECOMMIT_STATE_CHANGED" });
      expect((await svnPropset({
        cwd: fixture.wc,
        paths: [relativePath],
        name: "custom:bound-state",
        value: "001"
      })).ok).toBe(true);

      fs.writeFileSync(path.join(fixture.wc, ".svn-mcp-policy.json"), JSON.stringify({ deny: ["scratch/**"] }), "utf8");
      const policyChanged = await svnCommit({
        cwd: fixture.wc,
        paths: [relativePath],
        message: commitMessage("Commit bound state"),
        precommitToken: String(ready.precommit_token)
      });
      expect(policyChanged).toMatchObject({ ok: false, code: "PRECOMMIT_POLICY_CHANGED" });
      fs.rmSync(path.join(fixture.wc, ".svn-mcp-policy.json"));

      fs.writeFileSync(file, "three\r\n", "utf8");
      const changed = await svnCommit({
        cwd: fixture.wc,
        paths: [relativePath],
        message: commitMessage("Commit bound state"),
        precommitToken: String(ready.precommit_token)
      });
      expect(changed).toMatchObject({ ok: false, code: "PRECOMMIT_STATE_CHANGED" });

      fs.writeFileSync(file, "two\r\n", "utf8");
      const committed = await svnCommit({
        cwd: fixture.wc,
        paths: [relativePath],
        message: commitMessage("Commit bound state"),
        precommitToken: String(ready.precommit_token)
      });
      expect(committed).toMatchObject({
        ok: true,
        precommit_token: ready.precommit_token,
        committed_revision: expect.any(Number)
      });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("binds READY evidence to decoded binary SVN property bytes", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const relativePath = "binary property state.txt";
      const file = path.join(fixture.wc, relativePath);
      const propertyFile = path.join(fixture.root, "binary-property.bin");
      fs.writeFileSync(file, "one\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: [relativePath] })).ok).toBe(true);
      expect((await svnCommit({
        cwd: fixture.wc,
        paths: [relativePath],
        message: commitMessage("Add binary property fixture")
      })).ok).toBe(true);

      fs.writeFileSync(file, "two\r\n", "utf8");
      fs.writeFileSync(propertyFile, Buffer.from([0, 1, 2, 255]));
      execFileSync(svnExecutable(), ["propset", "-F", propertyFile, "custom:binary-state", "--", file], { cwd: fixture.wc });
      const ready = await svnPrecommit({ cwd: fixture.wc, paths: [relativePath] });
      expect(ready).toMatchObject({ ok: true, verdict: "READY" });

      fs.writeFileSync(propertyFile, Buffer.from([0, 1, 3, 255]));
      execFileSync(svnExecutable(), ["propset", "-F", propertyFile, "custom:binary-state", "--", file], { cwd: fixture.wc });
      const changed = await svnCommit({
        cwd: fixture.wc,
        paths: [relativePath],
        message: commitMessage("Commit binary property state"),
        precommitToken: String(ready.precommit_token)
      });
      expect(changed).toMatchObject({ ok: false, code: "PRECOMMIT_STATE_CHANGED" });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("binds precommit evidence for a newly added path using repository HEAD", async () => {
    const fixture = createTempWorkingCopy();
    try {
      fs.writeFileSync(path.join(fixture.wc, "new bound file.txt"), "one\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: ["new bound file.txt"] })).ok).toBe(true);
      const ready = await svnPrecommit({ cwd: fixture.wc, paths: ["new bound file.txt"] });
      expect(ready).toMatchObject({
        ok: true,
        verdict: "READY",
        remote_head_revision: 0,
        precommit_token: expect.stringMatching(/^[0-9a-f-]{36}$/i)
      });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("runs an idempotent safe commit without touching unrelated local edits", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const targetPath = "safe scope/target.txt";
      const unrelatedPath = "safe scope/unrelated.txt";
      const target = path.join(fixture.wc, targetPath);
      const unrelated = path.join(fixture.wc, unrelatedPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "one\r\n", "utf8");
      fs.writeFileSync(unrelated, "keep\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: [targetPath, unrelatedPath] })).ok).toBe(true);
      expect((await svnCommit({
        cwd: fixture.wc,
        paths: [targetPath, unrelatedPath],
        message: commitMessage("Add safe commit fixtures")
      })).ok).toBe(true);

      fs.writeFileSync(target, "two\n", "utf8");
      fs.writeFileSync(unrelated, "unrelated local edit\r\n", "utf8");
      const remoteHead = Number((await svnInfo({ cwd: fixture.wc, paths: [targetPath] })).remote_head_revision);
      const operationId = randomUUID();
      const committed = await svnCommitWorkflow({
        operation: "safe",
        cwd: fixture.wc,
        paths: [targetPath],
        message: commitMessage("Safely update target"),
        revision: String(remoteHead),
        expectedRemoteHead: remoteHead,
        operationId
      });

      expect(committed).toMatchObject({
        ok: true,
        operation: "safe_commit",
        verdict: "COMMITTED",
        operation_id: operationId,
        committed_revision: expect.any(Number),
        committed_paths: [targetPath],
        final_scope_clean: true,
        scope_uniform: true,
        baseline_captured_automatically: true,
        detail_operation_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
        detail_expires_at: expect.any(Number)
      });
      expect(statusByPath((await svnStatus({ cwd: fixture.wc })).changed_paths, fixture.wc).get(unrelatedPath)).toBe("M");

      const replay = await svnCommitWorkflow({
        operation: "safe",
        cwd: fixture.wc,
        paths: [targetPath],
        message: commitMessage("Safely update target"),
        revision: String(remoteHead),
        expectedRemoteHead: remoteHead,
        operationId
      });
      expect(replay).toMatchObject({ ok: true, committed_revision: committed.committed_revision, idempotent_replay: true });

      const detail = await svnCommitWorkflow({
        operation: "detail",
        cwd: fixture.wc,
        paths: [targetPath],
        detailOperationId: String(committed.detail_operation_id),
        cursor: "0",
        maxChars: 2048
      });
      expect(detail).toMatchObject({ ok: true, operation: "safe_commit_detail", detail_operation_id: committed.detail_operation_id });
      expect(String(detail.detail)).toContain("precommit");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps safe-commit scope exact when cwd is below the working-copy root", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const rootPath = "root-target.txt";
      const subdirectory = path.join(fixture.wc, "sub");
      const decoyPath = "sub/root-target.txt";
      const rootFile = path.join(fixture.wc, rootPath);
      const decoyFile = path.join(fixture.wc, decoyPath);
      fs.mkdirSync(subdirectory, { recursive: true });
      fs.writeFileSync(rootFile, "root one\r\n", "utf8");
      fs.writeFileSync(decoyFile, "decoy unchanged\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: [rootPath, decoyPath] })).ok).toBe(true);
      expect((await svnCommit({
        cwd: fixture.wc,
        paths: [rootPath, decoyPath],
        message: commitMessage("Add subdirectory safe-commit fixtures")
      })).ok).toBe(true);

      fs.writeFileSync(rootFile, "root two\n", "utf8");
      const remoteHead = Number((await svnInfo({ cwd: subdirectory, paths: ["../root-target.txt"] })).remote_head_revision);
      const committed = await svnCommitWorkflow({
        operation: "safe",
        cwd: subdirectory,
        paths: ["../root-target.txt"],
        message: commitMessage("Safely update parent target"),
        revision: String(remoteHead),
        expectedRemoteHead: remoteHead,
        operationId: randomUUID()
      });

      expect(committed).toMatchObject({
        ok: true,
        verdict: "COMMITTED",
        committed_paths: [rootPath],
        final_scope_clean: true,
        scope_uniform: true
      });
      expect(fs.readFileSync(rootFile, "utf8")).toBe("root two\n");
      expect(fs.readFileSync(decoyFile, "utf8")).toBe("decoy unchanged\r\n");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("stops a safe commit before mutation when a baseline path changed remotely", async () => {
    const fixture = createTempWorkingCopy();
    const peer = path.join(fixture.root, "safe collision peer");
    try {
      const relativePath = "safe collision.txt";
      const file = path.join(fixture.wc, relativePath);
      fs.writeFileSync(file, "one\r\ntwo\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: [relativePath] })).ok).toBe(true);
      expect((await svnCommit({
        cwd: fixture.wc,
        paths: [relativePath],
        message: commitMessage("Add safe collision fixture")
      })).ok).toBe(true);
      const baseline = await svnSnapshot({ cwd: fixture.wc, paths: [relativePath], captureBaseline: true });

      execFileSync(svnExecutable(), ["checkout", pathToFileURL(fixture.repo).href, peer], { cwd: fixture.root });
      const peerFile = path.join(peer, relativePath);
      fs.writeFileSync(peerFile, "one\r\nremote two\r\n", "utf8");
      execFileSync(svnExecutable(), ["commit", "-m", "remote safe collision", "--", peerFile], { cwd: peer });
      const remoteHead = Number((await svnInfo({ cwd: fixture.wc, paths: [relativePath] })).remote_head_revision);
      fs.writeFileSync(file, "local one\r\ntwo\r\n", "utf8");

      const refused = await svnCommitWorkflow({
        operation: "safe",
        cwd: fixture.wc,
        paths: [relativePath],
        message: commitMessage("Refuse colliding safe commit"),
        revision: String(remoteHead),
        expectedRemoteHead: remoteHead,
        baselineToken: String(baseline.baseline_token),
        operationId: randomUUID()
      });
      expect(refused).toMatchObject({
        ok: false,
        operation: "safe_commit",
        verdict: "COLLISION_DETECTED"
      });
      expect((await svnLog({ cwd: fixture.wc, paths: [relativePath], limit: 1 })).entries).toEqual([
        expect.objectContaining({ rev: remoteHead, msg: "remote safe collision" })
      ]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("finalizes a safe deletion without updating the removed path", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const relativePath = "safe delete.txt";
      fs.writeFileSync(path.join(fixture.wc, relativePath), "remove me\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: [relativePath] })).ok).toBe(true);
      expect((await svnCommit({
        cwd: fixture.wc,
        paths: [relativePath],
        message: commitMessage("Add safe delete fixture")
      })).ok).toBe(true);
      const baseline = await svnSnapshot({ cwd: fixture.wc, paths: [relativePath], captureBaseline: true });
      expect((await svnDelete({
        cwd: fixture.wc,
        paths: [relativePath],
        dryRun: false,
        riskAck: true
      })).ok).toBe(true);
      const remoteHead = Number((await svnInfo({ cwd: fixture.wc })).remote_head_revision);

      const committed = await svnCommitWorkflow({
        operation: "safe",
        cwd: fixture.wc,
        paths: [relativePath],
        message: commitMessage("Safely delete fixture"),
        revision: String(remoteHead),
        expectedRemoteHead: remoteHead,
        baselineToken: String(baseline.baseline_token),
        riskAck: true,
        operationId: randomUUID()
      });
      expect(committed).toMatchObject({
        ok: true,
        verdict: "COMMITTED",
        final_scope_clean: true,
        scope_uniform: true
      });
      expect(fs.existsSync(path.join(fixture.wc, relativePath))).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("safe-commits a newly added file with an internal current-state baseline", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const relativePath = "new safe file.txt";
      fs.writeFileSync(path.join(fixture.wc, relativePath), "new file\r\n", "utf8");
      expect((await svnAdd({ cwd: fixture.wc, paths: [relativePath] })).ok).toBe(true);
      const remoteHead = Number((await svnInfo({ cwd: fixture.wc })).remote_head_revision);
      const committed = await svnCommitWorkflow({
        operation: "safe",
        cwd: fixture.wc,
        paths: [relativePath],
        message: commitMessage("Safely add fixture"),
        revision: String(remoteHead),
        expectedRemoteHead: remoteHead,
        operationId: randomUUID()
      });
      expect(committed).toMatchObject({
        ok: true,
        verdict: "COMMITTED",
        committed_paths: [relativePath],
        baseline_captured_automatically: true,
        final_scope_clean: true,
        scope_uniform: true
      });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

function createTempWorkingCopy(): { root: string; repo: string; wc: string } {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "svn-agent-it-"));
  const repo = path.join(root, "repo");
  const wc = path.join(root, "wc");
  execFileSync(svnAdminExecutable(), ["create", repo], { cwd: root });
  execFileSync(svnExecutable(), ["checkout", pathToFileURL(repo).href, wc], { cwd: root });
  return { root, repo, wc };
}

function expectSvnArgs(command: string, argsPrefix: string): void {
  expect(command).toContain(` ${argsPrefix}`);
}

function commitMessage(summary: string): string {
  return `${summary}\n\n- Test fixture change\n- Verified by integration test\n- No behavior changes\n`;
}

function normalizeStatusPath(statusPath: string, cwd: string): string {
  const relative = path.isAbsolute(statusPath) ? path.relative(cwd, statusPath) : statusPath;
  return relative.replace(/\\/g, "/");
}

function statusByPath(changedPaths: Array<{ path: string; status: string }>, cwd: string): Map<string, string> {
  return new Map(changedPaths.map((entry) => [normalizeStatusPath(entry.path, cwd), entry.status]));
}
