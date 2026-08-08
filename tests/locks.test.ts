import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEnvelope } from "../src/envelope.js";
import { COMMIT_MESSAGE_REQUIREMENT, RISK_ACK_PATH_THRESHOLD } from "../src/guards.js";
import { createServer, readOnlyToolNames } from "../src/index.js";
import { parseInfoXml } from "../src/parse/infoXml.js";
import { svnAdminExecutable, svnExecutable } from "../src/runner.js";
import { svnLock, svnNeedsLock, svnUnlock } from "../src/tools/mutating.js";
import { svnLockStatus } from "../src/tools/readonly.js";
import { toToolResult } from "../src/response.js";

type AssertFalse<T extends false> = T;
type _SvnLockDoesNotExposeReceiptExecution = AssertFalse<"receiptExecution" extends keyof Parameters<typeof svnLock>[0] ? true : false>;
type _SvnUnlockDoesNotExposeReceiptExecution = AssertFalse<"receiptExecution" extends keyof Parameters<typeof svnUnlock>[0] ? true : false>;

describe("repository lock support", () => {
  it("parses repository lock metadata from svn info XML", () => {
    const parsed = parseInfoXml(`<?xml version="1.0"?>
<info>
  <entry kind="file" path="locked.txt" revision="9">
    <url>file:///repo/trunk/locked.txt</url>
    <repository><root>file:///repo</root></repository>
    <lock>
      <token>opaque-token</token>
      <owner>alice</owner>
      <comment>[svn-agent-mcp workstation=build-01] edit</comment>
      <created>2026-08-04T10:20:30.000000Z</created>
      <expires>2026-08-11T10:20:30.000000Z</expires>
    </lock>
    <wc-info><wcroot-abspath>C:\\work\\repo</wcroot-abspath></wc-info>
  </entry>
</info>`);

    expect(parsed[0]?.lock).toEqual({
      token: "opaque-token",
      owner: "alice",
      comment: "[svn-agent-mcp workstation=build-01] edit",
      created: "2026-08-04T10:20:30.000000Z",
      expires: "2026-08-11T10:20:30.000000Z"
    });
  });

  it("refuses lock mutations in readonly mode", async () => {
    const previous = process.env.SVN_AGENT_READONLY;
    process.env.SVN_AGENT_READONLY = "1";
    try {
      expect((await svnLock({ cwd: process.cwd(), paths: ["locked.txt"], comment: "edit", workstationLabel: "build-01" })).note)
        .toBe("READONLY instance");
      expect((await svnUnlock({ cwd: process.cwd(), paths: ["locked.txt"] })).note).toBe("READONLY instance");
      expect((await svnNeedsLock({ cwd: process.cwd(), paths: ["locked.txt"], action: "set" })).note)
        .toBe("READONLY instance");
    } finally {
      if (previous === undefined) delete process.env.SVN_AGENT_READONLY;
      else process.env.SVN_AGENT_READONLY = previous;
    }
  });

  it("locks, reports, marks needs-lock, and unlocks one file", async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "svn-agent-lock-it-"));
    const repo = path.join(root, "repo");
    const wc = path.join(root, "wc");
    try {
      execFileSync(svnAdminExecutable(), ["create", repo], { cwd: root });
      execFileSync(svnExecutable(), ["checkout", pathToFileURL(repo).href, wc], { cwd: root });
      const file = path.join(wc, "locked.txt");
      fs.writeFileSync(file, "one\r\n", "utf8");
      execFileSync(svnExecutable(), ["add", "--", file], { cwd: wc });
      execFileSync(svnExecutable(), ["commit", "-m", "lock fixture", "--", file], { cwd: wc });

      expect((await svnNeedsLock({ cwd: wc, paths: ["locked.txt"], action: "set" })).ok).toBe(true);
      const lockId = randomUUID();
      const locked = await svnLock({
        cwd: wc,
        paths: ["locked.txt"],
        comment: "edit fixture",
        workstationLabel: "build-01",
        operationId: lockId
      });
      expect(locked).toMatchObject({ ok: true, operation_id: lockId });

      const status = await svnLockStatus({ cwd: wc, paths: ["locked.txt"] });
      expect(status).toMatchObject({ ok: true, note: "", locks: [expect.objectContaining({
        repository_locked: true,
        local_token_possession: true,
        workstation_label: "build-01",
        state: "held-local"
      })] });
      expect(JSON.stringify(status)).not.toContain("opaque-token");

      const unlocked = await svnUnlock({ cwd: wc, paths: ["locked.txt"], operationId: randomUUID() });
      expect(unlocked.ok).toBe(true);
      expect((await svnLockStatus({ cwd: wc, paths: ["locked.txt"] })).locks?.[0]).toMatchObject({
        repository_locked: false,
        state: "unlocked"
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("protects same-user locks across two working copies and replays forced operations", async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "svn-agent-lock-peer-it-"));
    const repo = path.join(root, "repo");
    const wcA = path.join(root, "wc-a");
    const wcB = path.join(root, "wc-b");
    try {
      execFileSync(svnAdminExecutable(), ["create", repo], { cwd: root });
      execFileSync(svnExecutable(), ["checkout", pathToFileURL(repo).href, wcA], { cwd: root });
      const fileA = path.join(wcA, "shared.txt");
      fs.writeFileSync(fileA, "one\r\n", "utf8");
      execFileSync(svnExecutable(), ["add", "--", fileA], { cwd: wcA });
      execFileSync(svnExecutable(), ["commit", "-m", "peer lock fixture", "--", fileA], { cwd: wcA });
      execFileSync(svnExecutable(), ["checkout", pathToFileURL(repo).href, wcB], { cwd: root });

      const lockA = await svnLock({
        cwd: wcA,
        paths: ["shared.txt"],
        comment: "held by A",
        workstationLabel: "workstation-a",
        operationId: randomUUID()
      });
      expect(lockA.ok).toBe(true);

      const statusB = await svnLockStatus({ cwd: wcB, paths: ["shared.txt"] });
      expect(statusB.locks?.[0]).toMatchObject({
        repository_locked: true,
        local_token_possession: false,
        state: "held-elsewhere"
      });

      const normalUnlockB = await svnUnlock({ cwd: wcB, paths: ["shared.txt"] });
      expect(normalUnlockB).toMatchObject({ ok: false, code: "LOCK_TOKEN_REQUIRED" });

      const missingForceAck = await svnLock({
        cwd: wcB,
        paths: ["shared.txt"],
        comment: "steal without acknowledgement",
        workstationLabel: "workstation-b",
        force: true
      });
      expect(missingForceAck).toMatchObject({ ok: false, code: "FORCE_ACK_REQUIRED" });
      const missingForceOperationId = await svnLock({
        cwd: wcB,
        paths: ["shared.txt"],
        comment: "steal without operation id",
        workstationLabel: "workstation-b",
        force: true,
        forceAck: true
      });
      expect(missingForceOperationId).toMatchObject({ ok: false, code: "FORCE_ACK_REQUIRED" });
      const invalidForceOperationId = await svnLock({
        cwd: wcB,
        paths: ["shared.txt"],
        comment: "steal with invalid operation id",
        workstationLabel: "workstation-b",
        force: true,
        forceAck: true,
        operationId: "not-a-uuid"
      });
      expect(invalidForceOperationId).toMatchObject({ ok: false, code: "FORCE_ACK_REQUIRED" });
      const invalidUnlockOperationId = await svnUnlock({
        cwd: wcB,
        paths: ["shared.txt"],
        force: true,
        forceAck: true
      });
      expect(invalidUnlockOperationId).toMatchObject({ ok: false, code: "FORCE_ACK_REQUIRED" });

      const stealInput = {
        cwd: wcB,
        paths: ["shared.txt"],
        comment: "stolen by B",
        workstationLabel: "workstation-b",
        force: true,
        forceAck: true,
        operationId: randomUUID()
      };
      expect(await svnLock(stealInput)).toMatchObject({ ok: true, operation_id: stealInput.operationId });
      expect(await svnLock(stealInput)).toMatchObject({ ok: true, idempotent_replay: true });
      expect((await svnLockStatus({ cwd: wcB, paths: ["shared.txt"] })).locks?.[0]).toMatchObject({
        repository_locked: true,
        local_token_possession: true,
        state: "held-local"
      });

      const unlockInput = {
        cwd: wcB,
        paths: ["shared.txt"],
        force: true,
        forceAck: true,
        operationId: randomUUID()
      };
      expect(await svnUnlock(unlockInput)).toMatchObject({ ok: true, operation_id: unlockInput.operationId });
      expect(await svnUnlock(unlockInput)).toMatchObject({ ok: true, idempotent_replay: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("redacts parsed lock tokens from every public svn_info response mode", () => {
    const token = "secret-lock-token";
    const parsed = parseInfoXml(`<?xml version="1.0"?>
<info><entry kind="file" path="locked.txt" revision="9">
  <url>file:///repo/trunk/locked.txt</url><repository><root>file:///repo</root></repository>
  <lock><token>${token}</token><owner>alice</owner><comment>edit</comment></lock>
  <wc-info><wcroot-abspath>C:\\work\\repo</wcroot-abspath></wc-info>
</entry></info>`);
    const payload = {
      ...createEnvelope({ ok: true, command: "svn info --xml", cwd: "C:\\work\\repo" }),
      wc_root: "C:\\work\\repo",
      entries: parsed
    };
    for (const responseMode of ["compact", "standard", "receipt", "structured-only", "full"] as const) {
      const result = toToolResult("svn_info", payload, { responseMode });
      expect(JSON.stringify(result)).not.toContain(token);
    }
  });

  it("does not paginate lock rows twice in compact shaping", () => {
    const payload = {
      ...createEnvelope({ ok: true, command: "svn info --xml", cwd: "C:\\work\\repo" }),
      wc_root: "C:\\work\\repo",
      locks: [{
        path: "one.txt",
        repository_path: "one.txt",
        repository_locked: false,
        owner: null,
        created: null,
        expires: null,
        comment: null,
        local_token_possession: false,
        state: "unlocked"
      }],
      lock_count: 3,
      next_cursor: "2",
      truncated: true
    };
    const result = toToolResult("svn_lock_status", payload, {
      responseMode: "compact",
      request: { cursor: "1", maxItems: 1 }
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      lockCount: 3,
      nextCursor: "2",
      truncated: true,
      locks: [expect.objectContaining({ path: "one.txt" })]
    });
  });

  it("advertises explicit non-destructive annotations for all full-profile tools", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer("full");
    const client = new Client({ name: "lock-annotation-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(29);
      const commit = listed.tools.find((tool) => tool.name === "svn_commit");
      expect(commit?.description).toContain(COMMIT_MESSAGE_REQUIREMENT);
      expect(commit?.description).toContain(`more than ${RISK_ACK_PATH_THRESHOLD} paths requires riskAck:true.`);
      const imported = listed.tools.find((tool) => tool.name === "svn_import");
      expect(imported?.description).toContain(COMMIT_MESSAGE_REQUIREMENT);
      for (const toolName of ["svn_diff", "eol_check", "eol_fix_verified"]) {
        const tool = listed.tools.find((candidate) => candidate.name === toolName);
        expect(tool?.description).toContain("eol_check -> eol_fix_verified -> svn_diff(ignoreEol:true)");
        expect(tool?.description).toContain("LF/BOM");
        expect(tool?.description).toContain("byte/content preservation");
      }
      for (const tool of listed.tools.filter((candidate) => candidate.name !== "svn_commit")) {
        expect(tool.description ?? "").not.toContain(`more than ${RISK_ACK_PATH_THRESHOLD} paths requires riskAck:true.`);
      }
      for (const tool of listed.tools) {
        expect(tool.annotations?.destructiveHint).toBe(false);
        expect(tool.annotations?.readOnlyHint).toBe(readOnlyToolNames.has(tool.name));
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
