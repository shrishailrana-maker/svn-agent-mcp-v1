import { describe, expect, it, jest } from "@jest/globals";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { svnAdminExecutable, svnExecutable } from "../src/runner.js";
import { eolFixVerified, svnPrecommit } from "../src/tools/composite.js";
import { svnDiagnose } from "../src/tools/diagnose.js";
import { svnAdd, svnCommit, svnCopy, svnExport, svnImport, svnMove, svnPropset, svnRename, svnRevert, svnUpdate } from "../src/tools/mutating.js";
import { eolCheck, svnDiff, svnInfo, svnLog, svnPropget, svnStatus } from "../src/tools/readonly.js";

jest.setTimeout(30000);

describe("SVN tool integration against a temp repository", () => {
  it("detects LF EOL churn, fixes it, and commits via a -F message flow", async () => {
    const fixture = createTempWorkingCopy();
    try {
      const file = path.join(fixture.wc, "app.txt");
      fs.writeFileSync(file, "one\r\ntwo\r\n", "utf8");

      expect((await svnAdd({ cwd: fixture.wc, paths: ["app.txt"] })).ok).toBe(true);
      expect((await svnCommit({ cwd: fixture.wc, paths: ["app.txt"], message: commitMessage("Initial import") })).ok).toBe(true);
      execFileSync(svnExecutable(), ["propset", "svn:eol-style", "native", file], { cwd: fixture.wc });
      execFileSync(svnExecutable(), ["commit", "-m", "set prop", file], { cwd: fixture.wc });

      fs.writeFileSync(file, "one\nTWO\n", "utf8");
      const damaged = await svnPrecommit({ cwd: fixture.wc, paths: ["app.txt"] });
      expect(damaged.verdict).toBe("EOL_FIX_NEEDED");

      const diff = await svnDiff({ cwd: fixture.wc, paths: ["app.txt"] });
      expectSvnArgs(diff.command, "diff --internal-diff -x --ignore-eol-style");

      const fixed = await eolFixVerified({ cwd: fixture.wc, path: "app.txt" });
      expect(fixed.ok).toBe(true);
      expect(fixed.command.toLowerCase()).toContain("unix2dos");
      expect(fixed.command.toLowerCase()).not.toContain("powershell");
      expect(fixed.converter).toBe("unix2dos");
      expectSvnArgs(String(fixed.verification_command), "diff --internal-diff -x --ignore-eol-style");
      expect(fixed.pure_eol_churn).toBe(false);

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

      const got = await svnPropget({ cwd: fixture.wc, paths: ["props.txt"], name: "custom:review-note" });
      expect(got.ok).toBe(true);
      expect(got.properties).toEqual([
        { path: "props.txt", name: "custom:review-note", value: "checked by MCP" }
      ]);

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
      expectSvnArgs(moved.command, "move --parents");
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
      expectSvnArgs(copied.command, "copy --parents");
      expect(statusByPath(copied.changed_paths, fixture.wc).get("copies/source-copy.txt")).toBe("A");
      expect((await svnCommit({
        cwd: fixture.wc,
        paths: ["copies/source-copy.txt"],
        message: commitMessage("Copy source")
      })).ok).toBe(true);

      const renamed = await svnRename({ cwd: fixture.wc, src: "moved/source.txt", dest: "moved/final.txt" });
      expect(renamed.ok).toBe(true);
      expectSvnArgs(renamed.command, "move --parents");
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
      const reverted = await svnRevert({ cwd: fixture.wc, paths: ["dir", "file.txt"], allowRecursive: true, dryRun: false });

      expect(reverted.ok).toBe(true);
      expect(reverted.command).toContain("--depth infinity");
      expect(fs.readFileSync(path.join(fixture.wc, "dir", "nested.txt"), "utf8")).toBe("one\r\n");
      expect(fs.readFileSync(path.join(fixture.wc, "file.txt"), "utf8")).toBe("one\r\n");
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
