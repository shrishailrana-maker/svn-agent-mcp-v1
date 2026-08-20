import { describe, expect, it } from "@jest/globals";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import packageJson from "../package.json" with { type: "json" };
import {
  advancedInputNames, configuredToolProfile, fieldProjectionNames, handleTool, serverVersion, toolNamesForProfile
} from "../src/index.js";

const distIndex = path.resolve("dist", "index.js");

describe("server entrypoint launch detection", () => {
  it("selects bounded tool profiles while keeping full as the default", () => {
    expect(configuredToolProfile(undefined)).toBe("full");
    expect([...(toolNamesForProfile("docs") ?? [])]).toEqual([
      "svn_update", "svn_status", "svn_log", "svn_add", "eol_check", "eol_fix_verified", "svn_precommit", "svn_commit"
    ]);
    expect(toolNamesForProfile("review")?.size).toBe(11);
    expect(toolNamesForProfile("full")).toBeNull();
    expect(() => configuredToolProfile("wide-open")).toThrow("allowed full, docs, review");
  });

  it("uses the package version as the MCP server version", () => {
    expect(serverVersion).toBe(packageJson.version);
  });

  it("publishes projections for revision, update-scope, and cleanliness evidence", () => {
    expect(fieldProjectionNames.svn_info).toEqual(expect.arrayContaining([
      "remoteHeadRevision", "remoteHeadUnavailableReason"
    ]));
    expect(fieldProjectionNames.svn_snapshot).toEqual(expect.arrayContaining([
      "workingCopyRoot", "repositoryUrl", "repositoryRoot", "changedCount", "conflictCount",
      "lockState", "lockCount", "lockStates", "lockStateTruncated", "lockStateUnavailableReason"
    ]));
    expect(fieldProjectionNames.svn_update).toEqual(expect.arrayContaining([
      "scopeKind", "scopeComplete", "omittedRepositoryAdditions", "omittedRepositoryAdditionCount",
      "omittedRepositoryAdditionsTruncated", "scopeCheckUnavailableReason", "recommendedAction"
    ]));
    expect(fieldProjectionNames.svn_commit).toEqual(expect.arrayContaining([
      "outOfDatePaths", "outOfDatePathCount", "outOfDatePathsTruncated", "workingCopyMixed",
      "baseRevision", "baseRevisionRange", "postStatusClean", "postStatusScope", "postStatusPaths",
      "postStatusPathCount", "postStatusPathsTruncated", "workingCopyClean"
    ]));
  });

  it("publishes compact response modes without repeating global controls in every schema", async () => {
    if (!fs.existsSync(distIndex)) {
      return;
    }
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const client = new Client({ name: "schema-controls", version: "1.0.0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [distIndex], stderr: "ignore" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(expect.arrayContaining([
        "svn_inspect_working_copy", "svn_safe_update", "svn_safe_commit",
        "svn_repair_eol", "svn_lock_edit_unlock", "svn_diagnose_commit"
      ]));
      const inspectPrompt = prompts.prompts.find((prompt) => prompt.name === "svn_inspect_working_copy");
      expect(inspectPrompt?.arguments?.map((argument) => argument.name)).not.toContain("revision");
      const safeCommitPrompt = await client.getPrompt({
        name: "svn_safe_commit",
        arguments: { cwd: "C:\\Projects\\sample", paths: "src\\Program.cs", revision: "42" }
      });
      expect(safeCommitPrompt.messages[0]?.content).toMatchObject({ type: "text" });
      expect(JSON.stringify(safeCommitPrompt)).toContain("svn_commit operation:safe");
      expect(JSON.stringify(safeCommitPrompt)).toContain('"revision":"42"');
      const status = tools.tools.find((tool) => tool.name === "svn_status");
      expect(status?.inputSchema.properties?.responseMode?.enum).toEqual([
        "compact", "standard", "full", "receipt", "structured-only"
      ]);
      expect(status?.inputSchema.properties).not.toHaveProperty("humanText");
      expect(status?.inputSchema.properties).not.toHaveProperty("fields");
      expect(status?.inputSchema.properties).not.toHaveProperty("afterCursor");
      const diff = tools.tools.find((tool) => tool.name === "svn_diff");
      expect(diff?.inputSchema.properties).not.toHaveProperty("operationId");
      expect(advancedInputNames.svn_status).toContain("afterCursor");
      expect(advancedInputNames.svn_diff).toContain("operationId");
      expect(advancedInputNames.svn_update).toContain("operationId");
      expect(advancedInputNames.svn_commit).toContain("operationId");
      expect(advancedInputNames.eol_fix_verified).toContain("operationId");
      expect(advancedInputNames.svn_resolve).toContain("operationId");
    } finally {
      await client.close();
    }
  }, 20000);

  it("contains unexpected tool failures in a redacted error envelope", async () => {
    const secret = "unexpected-private-detail";
    const result = await handleTool(
      "svn_status",
      { responseMode: "compact" },
      new AbortController().signal,
      async () => { throw new Error(secret); }
    );

    expect(result.structuredContent).toEqual({ ok: false, note: "unexpected MCP tool failure" });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("starts the server when launched through a directory junction", async () => {
    if (!fs.existsSync(distIndex)) {
      // dist/ is produced by `npm run build`; without it there is nothing to launch.
      return;
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "svn-agent-entry-"));
    const junction = path.join(tmp, "current");
    try {
      fs.symlinkSync(path.resolve("dist"), junction, "junction");
      const streams = await startupStreams(path.join(junction, "index.js"));
      expect(streams.stderr).toContain("running on stdio");
      expect(streams.stdout).toBe("");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 20000);
});

function startupStreams(entry: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.includes("running on stdio")) {
        clearTimeout(timer);
        child.kill();
      }
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
  });
}
