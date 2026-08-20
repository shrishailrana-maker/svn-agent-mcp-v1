#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "svn-agent-client-"));
const repository = path.join(temporaryRoot, "repo");
const workingCopy = path.join(temporaryRoot, "wc");
const svn = executable("svn");
const svnadmin = executable("svnadmin");
const passed = [];
const preparedEntrypoint = path.join(projectRoot, "current", "dist", "index.js");

try {
  assert(fs.existsSync(preparedEntrypoint), "prepared current/dist/index.js is missing; run npm run prepare:local");
  run(svnadmin, ["create", repository], temporaryRoot);
  run(svn, ["checkout", pathToFileURL(repository).href, workingCopy], temporaryRoot);

  const client = new Client({ name: "svn-agent-client-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [preparedEntrypoint],
    stderr: "ignore"
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const prompts = await client.listPrompts();
    assert(tools.tools.length === 29, `expected 29 canonical tools, received ${tools.tools.length}`);
    for (const tool of tools.tools) {
      assert(tool.annotations?.destructiveHint === false, `tool ${tool.name} omitted destructiveHint:false`);
    }
    for (const name of ["svn_delete", "svn_resolve", "svn_path_change", "svn_snapshot", "svn_cat", "svn_blame", "svn_lock", "svn_unlock", "svn_lock_status", "svn_needs_lock"]) {
      assert(tools.tools.some((tool) => tool.name === name), `missing public tool: ${name}`);
    }
    for (const name of ["svn_move", "svn_rename", "svn_copy", "svn_resolved"]) {
      assert(!tools.tools.some((tool) => tool.name === name), `legacy tool should not be advertised: ${name}`);
    }
    for (const name of ["svn_inspect_working_copy", "svn_safe_update", "svn_safe_commit", "svn_repair_eol", "svn_lock_edit_unlock", "svn_diagnose_commit"]) {
      assert(prompts.prompts.some((prompt) => prompt.name === name), `missing workflow prompt: ${name}`);
    }
    passed.push("handshake", "workflow-prompts");

    const statusTool = tools.tools.find((tool) => tool.name === "svn_status");
    assert(statusTool?.inputSchema?.properties?.paths?.maxItems === 500, "status paths are not publicly bounded");
    const updateTool = tools.tools.find((tool) => tool.name === "svn_update");
    assert(updateTool?.inputSchema?.properties?.revision, "svn_update revision selector is missing");
    assert(updateTool?.inputSchema?.properties?.expectedRemoteHead, "svn_update expectedRemoteHead guard is missing");
    const precommitTool = tools.tools.find((tool) => tool.name === "svn_precommit");
    assert(precommitTool?.inputSchema?.properties?.requireUniformRevision, "precommit uniform-revision gate is missing");
    assert(precommitTool?.inputSchema?.properties?.expandDescendants, "precommit descendant expansion is missing");
    const commitTool = tools.tools.find((tool) => tool.name === "svn_commit");
    assert(commitTool?.inputSchema?.properties?.operation, "commit workflow operation selector is missing");
    assert(commitTool?.inputSchema?.properties?.revision, "commit prepare revision is missing");
    assert(commitTool?.inputSchema?.properties?.expectedRemoteHead, "commit prepare expectedRemoteHead guard is missing");
    assert(commitTool?.inputSchema?.properties?.expandDescendants, "commit descendant expansion is missing");
    assert(commitTool?.inputSchema?.properties?.operation?.enum?.includes("safe"), "commit safe workflow is missing");
    assert(commitTool?.inputSchema?.properties?.operation?.enum?.includes("detail"), "commit detail workflow is missing");
    const diffTool = tools.tools.find((tool) => tool.name === "svn_diff");
    assert(diffTool?.inputSchema?.properties?.lineLimit?.maximum === 2000, "diff lineLimit maximum is not published");
    assert(diffTool?.inputSchema?.properties?.maxHunksPerFile?.maximum === 20, "diff hunk maximum is not published");
    let validationMessage = "";
    try {
      const invalid = await client.callTool({
        name: "svn_diff",
        arguments: { cwd: workingCopy, paths: ["x"], lineLimit: 2001 }
      });
      validationMessage = JSON.stringify(invalid);
    } catch (error) {
      validationMessage = error instanceof Error ? error.message : String(error);
    }
    assert(validationMessage.includes("lineLimit=2001") && validationMessage.includes("allowed 1..2000"),
      `diff limit validation was not actionable: ${validationMessage}`);
    let projectionMessage = "";
    try {
      await client.callTool({
        name: "svn_status",
        arguments: { cwd: workingCopy, fields: ["notAField"] }
      });
    } catch (error) {
      projectionMessage = error instanceof Error ? error.message : String(error);
    }
    assert(
      projectionMessage.includes("invalid fields for svn_status") && projectionMessage.includes("changedPaths"),
      `invalid projection was not rejected locally: ${projectionMessage}`
    );
    passed.push("input-bounds");

    const selfCheck = await call(client, "svn_self_check", { cwd: workingCopy, responseMode: "compact" });
    assert(selfCheck.ok === true && selfCheck.available === true, "self-check was not healthy");
    passed.push("self-check");

    fs.writeFileSync(path.join(workingCopy, "client-smoke.txt"), "one\r\n", "utf8");
    await callOk(client, "svn_add", { cwd: workingCopy, paths: ["client-smoke.txt"] });
    passed.push("add");

    const status = await callOk(client, "svn_status", { cwd: workingCopy });
    assert(status.items.some((item) => item.path === "client-smoke.txt" && item.status === "added"), "status omitted added file");
    assert(typeof status.snapshotToken === "string", "status omitted its snapshot token");
    const unchangedStatus = await callOk(client, "svn_status", {
      cwd: workingCopy,
      afterCursor: status.snapshotToken
    });
    assert(
      unchangedStatus.verdict === "NO_CHANGE" && unchangedStatus.unchangedSinceCursor === true,
      `status snapshot cursor did not return NO_CHANGE: ${JSON.stringify(unchangedStatus)}`
    );
    const structuredOnly = await client.callTool({
      name: "svn_status",
      arguments: { cwd: workingCopy, responseMode: "structured-only" }
    });
    assert(structuredOnly.content.length === 0 && structuredOnly.structuredContent?.ok === true,
      "structured-only response duplicated text or omitted structured content");
    const withHumanText = await client.callTool({
      name: "svn_status",
      arguments: { cwd: workingCopy, responseMode: "compact", humanText: true }
    });
    assert(withHumanText.content.length === 1 && withHumanText.content[0]?.type === "text",
      "humanText opt-in did not return a text receipt");
    passed.push("status");

    const precommit = await callOk(client, "svn_precommit", { cwd: workingCopy, paths: ["client-smoke.txt"] });
    assert(precommit.ready === true, "precommit did not report ready");
    passed.push("precommit");

    const commitOperationId = randomUUID();
    const commitInput = {
      cwd: workingCopy,
      paths: ["client-smoke.txt"],
      message: "MCP client smoke\n\n- Exercise the public protocol\n- Verify guarded commit behavior\n",
      operationId: commitOperationId
    };
    const committed = await callOk(client, "svn_commit", commitInput);
    assert(Number.isInteger(committed.revision), "commit omitted its revision");
    const commitReplay = await callOk(client, "svn_commit", commitInput);
    assert(
      commitReplay.revision === committed.revision
        && commitReplay.operationId === commitOperationId
        && commitReplay.idempotentReplay === true,
      `commit retry did not replay the durable receipt: ${JSON.stringify(commitReplay)}`
    );
    const commitMismatch = await call(client, "svn_commit", {
      ...commitInput,
      message: "Different client smoke\n\n- Prove operation binding\n- Refuse mismatched retry\n"
    });
    assert(
      commitMismatch.ok === false
        && commitMismatch.code === "OPERATION_ID_CONFLICT"
        && commitMismatch.operationId === commitOperationId,
      `commit operation ID was not bound to its original payload: ${JSON.stringify(commitMismatch)}`
    );
    passed.push("commit");

    await callOk(client, "svn_needs_lock", { cwd: workingCopy, paths: ["client-smoke.txt"], action: "set" });
    const lockInput = {
      cwd: workingCopy,
      paths: ["client-smoke.txt"],
      comment: "client smoke lock",
      workstationLabel: "smoke-client",
      operationId: randomUUID()
    };
    const lock = await callOk(client, "svn_lock", lockInput);
    assert(lock.operationId === lockInput.operationId, "lock receipt omitted its operation ID");
    const lockStatus = await callOk(client, "svn_lock_status", { cwd: workingCopy, paths: ["client-smoke.txt"] });
    assert(lockStatus.locks[0]?.repositoryLocked === true && lockStatus.locks[0]?.localTokenPossession === true,
      `lock status did not report local possession: ${JSON.stringify(lockStatus)}`);
    assert(!JSON.stringify(lockStatus).includes("<token>"), "lock status exposed an XML token");
    await callOk(client, "svn_unlock", { cwd: workingCopy, paths: ["client-smoke.txt"], operationId: randomUUID() });
    await callOk(client, "svn_needs_lock", { cwd: workingCopy, paths: ["client-smoke.txt"], action: "remove", riskAck: true });
    passed.push("repository-locks");

    const baseline = await callOk(client, "svn_snapshot", {
      cwd: workingCopy,
      paths: ["client-smoke.txt"],
      captureBaseline: true
    });
    assert(typeof baseline.baselineToken === "string", "snapshot omitted its pre-edit baseline token");
    fs.writeFileSync(path.join(workingCopy, "client-smoke.txt"), "one\r\ntwo\r\n", "utf8");
    const prepared = await callOk(client, "svn_commit", {
      operation: "prepare",
      cwd: workingCopy,
      paths: ["client-smoke.txt"],
      revision: String(committed.revision),
      expectedRemoteHead: committed.revision,
      baselineToken: baseline.baselineToken
    });
    assert(
      prepared.ready === true
        && prepared.resultingRevision === committed.revision
        && prepared.finalCommitScope.includes("client-smoke.txt"),
      `prepare commit receipt was incomplete: ${JSON.stringify(prepared)}`
    );
    const prepareRootRefusal = await call(client, "svn_commit", {
      operation: "prepare",
      cwd: workingCopy,
      paths: ["."],
      revision: String(committed.revision),
      expectedRemoteHead: committed.revision
    });
    assert(
      prepareRootRefusal.ok === false && String(prepareRootRefusal.note).includes("allowRoot:true"),
      `prepare accepted an unacknowledged working-copy root: ${JSON.stringify(prepareRootRefusal)}`
    );
    passed.push("prepare-commit");

    const safeOperationId = randomUUID();
    const safeInput = {
      operation: "safe",
      cwd: workingCopy,
      paths: ["client-smoke.txt"],
      message: "Safe MCP client smoke\n\n- Exercise bound workflow evidence\n- Verify compact final receipt\n",
      revision: String(committed.revision),
      expectedRemoteHead: committed.revision,
      baselineToken: baseline.baselineToken,
      operationId: safeOperationId
    };
    const safe = await callOk(client, "svn_commit", safeInput);
    assert(
      safe.verdict === "COMMITTED"
        && safe.finalScopeClean === true
        && safe.scopeUniform === true
        && typeof safe.detailOperationId === "string",
      `safe commit receipt was incomplete: ${JSON.stringify(safe)}`
    );
    const safeReplay = await callOk(client, "svn_commit", safeInput);
    assert(safeReplay.idempotentReplay === true && safeReplay.committedRevision === safe.committedRevision,
      "safe commit retry did not replay its durable receipt");
    const safeDetail = await callOk(client, "svn_commit", {
      operation: "detail",
      cwd: workingCopy,
      paths: ["client-smoke.txt"],
      detailOperationId: safe.detailOperationId,
      cursor: "0",
      maxChars: 2048
    });
    assert(String(safeDetail.detail).includes("precommit"), "safe commit detail omitted its precommit stage");
    passed.push("safe-commit");

    const guardedDirectory = path.join(workingCopy, "guarded-directory");
    const guardedChild = path.join(guardedDirectory, "child.txt");
    fs.mkdirSync(guardedDirectory);
    fs.writeFileSync(guardedChild, "one\r\n", "utf8");
    await callOk(client, "svn_add", { cwd: workingCopy, paths: ["guarded-directory/child.txt"] });
    await callOk(client, "svn_commit", {
      cwd: workingCopy,
      paths: ["guarded-directory/child.txt"],
      message: "Add directory guard fixture\n\n- Exercise directory commit guards\n- Verify public MCP behavior\n"
    });
    fs.writeFileSync(guardedChild, "two\r\n", "utf8");
    await callOk(client, "svn_propset", {
      cwd: workingCopy,
      paths: ["guarded-directory"],
      name: "custom:directory",
      value: "changed"
    });
    const precommitDirectoryRefusal = await call(client, "svn_precommit", {
      cwd: workingCopy,
      paths: ["guarded-directory"]
    });
    assert(
      precommitDirectoryRefusal.ok === false && String(precommitDirectoryRefusal.note).includes("allowDirectoryTargets:true"),
      "precommit accepted an unacknowledged directory target"
    );
    const commitDirectoryRefusal = await call(client, "svn_commit", {
      cwd: workingCopy,
      paths: ["guarded-directory"],
      message: "Attempt directory commit\n\n- Exercise directory commit guards\n- Verify public MCP behavior\n"
    });
    assert(
      commitDirectoryRefusal.ok === false && String(commitDirectoryRefusal.note).includes("allowDirectoryTargets:true"),
      "commit accepted an unacknowledged directory target"
    );
    const precommitDirectory = await callOk(client, "svn_precommit", {
      cwd: workingCopy,
      paths: ["guarded-directory"],
      allowDirectoryTargets: true
    });
    assert(precommitDirectory.ready === true, "acknowledged directory precommit was not ready");
    const directoryCommit = await callOk(client, "svn_commit", {
      cwd: workingCopy,
      paths: ["guarded-directory"],
      message: "Commit directory property\n\n- Exercise directory commit guards\n- Verify descendant scope evidence\n",
      allowDirectoryTargets: true
    });
    assert(
      directoryCommit.postStatusClean === true
        && directoryCommit.postStatusScope === "committed-paths"
        && directoryCommit.postStatusPaths.includes("guarded-directory")
        && directoryCommit.workingCopyClean === false,
      "acknowledged directory commit did not distinguish committed scope from the dirty working copy"
    );
    passed.push("directory-commit-guard");

    const exactLog = await callOk(client, "svn_log", {
      cwd: workingCopy,
      paths: ["client-smoke.txt"],
      revision: String(committed.revision),
      messageContains: "client smoke"
    });
    assert(exactLog.entries.length === 1 && exactLog.entries[0]?.revision === committed.revision, "exact revision log failed");
    const historical = await callOk(client, "svn_cat", {
      cwd: workingCopy,
      path: "client-smoke.txt",
      revision: String(committed.revision)
    });
    assert(historical.content === "one\r\n", "historical cat returned unexpected content");
    const blame = await callOk(client, "svn_blame", {
      cwd: workingCopy,
      path: "client-smoke.txt",
      revision: String(committed.revision)
    });
    assert(blame.lines[0]?.revision === committed.revision, "blame omitted the committed revision");
    passed.push("revision-read");

    const legacyCopy = await callOk(client, "svn_copy", {
      cwd: workingCopy,
      src: "client-smoke.txt",
      dest: "legacy-copy.txt"
    });
    assert(legacyCopy.action === "copy", "hidden compatibility copy route returned the wrong receipt");
    const canonicalMove = await callOk(client, "svn_path_change", {
      cwd: workingCopy,
      action: "move",
      src: "legacy-copy.txt",
      dest: "canonical-move.txt"
    });
    assert(
      canonicalMove.action === "move" && canonicalMove.verifiedStatus === "renamed",
      `canonical path-change receipt was incorrect: ${JSON.stringify(canonicalMove)}`
    );
    passed.push("path-change-compatibility");

    fs.writeFileSync(path.join(workingCopy, "client-smoke.txt"), "one\r\ntwo\r\nthree\r\n", "utf8");
    const diff = await callOk(client, "svn_diff", { cwd: workingCopy, paths: ["client-smoke.txt"] });
    assert(
      diff.files.some((item) => item.path === "client-smoke.txt" && item.added === 1),
      `diff summary was incorrect: ${JSON.stringify(diff)}`
    );
    passed.push("diff");

    fs.appendFileSync(
      path.join(workingCopy, "client-smoke.txt"),
      Array.from({ length: 400 }, (_, index) => `large diff line ${index} ${"x".repeat(300)}\r\n`).join(""),
      "utf8"
    );
    const largeDiff = await callOk(client, "svn_diff", {
      cwd: workingCopy,
      paths: ["client-smoke.txt"],
      diffMode: "full",
      maxChars: 64_000,
      maxFiles: 500
    });
    assert(String(largeDiff.excerpt).length <= 8_000, "compact full diff exceeded its excerpt cap");
    assert(largeDiff.truncated === true && /^\d+$/.test(largeDiff.nextCursor), "large diff omitted continuation");
    assert(typeof largeDiff.operationId === "string", "large diff omitted its stable evidence operation ID");
    const continuedDiff = await callOk(client, "svn_diff", {
      cwd: workingCopy,
      paths: ["client-smoke.txt"],
      diffMode: "full",
      operationId: largeDiff.operationId,
      cursor: largeDiff.nextCursor,
      maxChars: 64_000,
      maxFiles: 500
    });
    assert(
      continuedDiff.operationId === largeDiff.operationId,
      "diff continuation did not reuse the stored operation evidence"
    );
    passed.push("large-diff");

    const statusAfterLargeDiff = await callOk(client, "svn_status", {
      cwd: workingCopy,
      paths: ["client-smoke.txt"]
    });
    assert(statusAfterLargeDiff.ok === true, "MCP stream did not recover after a large diff response");
    passed.push("large-diff-stream-recovery");

    const snapshot = await callOk(client, "svn_snapshot", { cwd: workingCopy, paths: ["client-smoke.txt"] });
    assert(snapshot.counts.modified === 1, "snapshot omitted the modified file");
    const deletePreview = await callOk(client, "svn_delete", { cwd: workingCopy, paths: ["client-smoke.txt"] });
    assert(deletePreview.dryRun === true, "delete did not default to a dry-run preview");
    passed.push("snapshot-delete-preview");

    await callOk(client, "svn_propset", {
      cwd: workingCopy,
      paths: ["client-smoke.txt"],
      name: "custom:dash-value",
      value: "--force"
    });
    const property = await callOk(client, "svn_propget", {
      cwd: workingCopy,
      paths: ["client-smoke.txt"],
      name: "custom:dash-value"
    });
    assert(property.properties[0]?.value === "--force", "property value was not preserved");
    passed.push("property");

    await callOk(client, "svn_export", {
      cwd: workingCopy,
      src: pathToFileURL(repository).href,
      dest: "--force"
    });
    assert(fs.existsSync(path.join(workingCopy, "--force")), "dash-prefixed export destination was not created");
    passed.push("export");

    const outside = await call(client, "svn_status", {
      cwd: workingCopy,
      paths: [path.join(temporaryRoot, "outside.txt")]
    });
    assert(outside.ok === false, "outside-working-copy path was accepted");
    passed.push("containment");
  } finally {
    await client.close();
  }

  console.log(`MCP client smoke passed: ${passed.length} checks (${passed.join(", ")})`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

async function call(client, name, args) {
  const response = await client.callTool({ name, arguments: { ...args, responseMode: "compact" } });
  return response.structuredContent ?? JSON.parse(response.content[0]?.text ?? "{}");
}

async function callOk(client, name, args) {
  const response = await call(client, name, args);
  assert(response.ok === true, `${name} failed: ${response.note ?? JSON.stringify(response)}`);
  return response;
}

function executable(name) {
  return process.platform === "win32" ? path.join(projectRoot, "bin", `${name}.exe`) : name;
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "ignore", windowsHide: true });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
