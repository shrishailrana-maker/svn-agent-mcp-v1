import { describe, expect, it } from "@jest/globals";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import packageJson from "../package.json" with { type: "json" };
import {
  advancedInputNames, configuredToolProfile, createServer, fieldProjectionNames, handleTool, serverVersion, toolNamesForProfile
} from "../src/index.js";

const distIndex = path.resolve("dist", "index.js");

describe("server entrypoint launch detection", () => {
  it("selects bounded tool profiles with review as the default", () => {
    expect(configuredToolProfile(undefined)).toBe("review");
    expect(configuredToolProfile("full")).toBe("full");
    expect([...(toolNamesForProfile("docs") ?? [])]).toEqual([
      "svn_help", "svn_update", "svn_status", "svn_log", "svn_add", "eol_check", "eol_fix_verified", "svn_precommit", "svn_commit"
    ]);
    expect(toolNamesForProfile("review")?.size).toBe(14);
    expect([...(toolNamesForProfile("review") ?? [])]).toEqual(expect.arrayContaining(["svn_info", "svn_propset_eol_style"]));
    expect(toolNamesForProfile("full")).toBeNull();
    expect(() => configuredToolProfile("wide-open")).toThrow("allowed full, docs, review");
  });

  it("uses the package version as the MCP server version", () => {
    expect(serverVersion).toBe(packageJson.version);
  });

  it("starts with review tools and discovers one extra tool without restricting calls", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { ToolListChangedNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
    const server = createServer("review");
    const client = new Client({ name: "profile-discovery", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let notices = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notices++; });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
      const starting = (await client.listTools()).tools;
      expect(starting).toHaveLength(14);
      expect(starting.map((tool) => tool.name)).not.toContain("svn_delete");

      const direct = await client.callTool({ name: "svn_delete", arguments: { paths: ["unused"], dryRun: true } });
      expect(direct.structuredContent).toMatchObject({ ok: false, code: "EXPLICIT_SCOPE" });
      const catalog = await client.callTool({ name: "svn_help", arguments: { tool: "tools" } });
      expect(catalog.structuredContent).toMatchObject({ contract: {
        advertised: expect.arrayContaining(["svn_commit", "svn_info"]),
        onDemand: expect.arrayContaining(["svn_delete", "svn_lock_status"])
      } });
      expect((await client.listTools()).tools).toEqual(starting);
      expect(notices).toBe(0);

      const load = () => client.callTool({ name: "svn_help", arguments: { tool: "svn_delete" } });
      const loaded = await load();
      const after = (await client.listTools()).tools;
      const added = after.find((tool) => tool.name === "svn_delete");
      expect(added).toBeDefined();
      expect(after.filter((tool) => tool.name !== "svn_delete")).toEqual(starting);
      expect(loaded.structuredContent).toMatchObject({ contract: { discovery: {
        inputSchema: added?.inputSchema, newlyAdvertised: true
      } } });
      expect((await load()).structuredContent).toMatchObject({ contract: { discovery: { newlyAdvertised: false } } });
      expect(notices).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps every runtime advanced-input assignment in the shared registry", () => {
    const source = fs.readFileSync(path.resolve("src", "index.ts"), "utf8");
    const validator = source.slice(
      source.indexOf("function validateAdvancedInputs"),
      source.indexOf("function validatedEvidenceToken")
    );
    const assigned = new Set<string>();
    for (const match of validator.matchAll(/extras\.([A-Za-z][A-Za-z0-9]*)\s*=/g)) {
      if (match[1]) assigned.add(match[1]);
    }
    for (const match of validator.matchAll(/copyOptional(?:Boolean|Integer)\(extras,\s*args,\s*"([^"]+)"/g)) {
      if (match[1]) assigned.add(match[1]);
    }
    const registered = new Set(Object.values(advancedInputNames).flat());
    expect([...assigned].filter((name) => !registered.has(name as never))).toEqual([]);
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
    const transport = new StdioClientTransport({
      command: process.execPath, args: [distIndex], stderr: "ignore",
      env: { ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>), SVN_MCP_TOOL_PROFILE: "full" }
    });
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
        arguments: { cwd: path.resolve("sample"), paths: "src/Program.cs", revision: "42" }
      });
      expect(safeCommitPrompt.messages[0]?.content).toMatchObject({
        type: "text",
        text: expect.stringContaining('"revision":"42"')
      });
      expect(JSON.stringify(safeCommitPrompt)).toContain("svn_commit operation:safe");
      const status = tools.tools.find((tool) => tool.name === "svn_status");
      expect(status?.inputSchema.properties?.responseMode?.enum).toEqual([
        "compact", "standard", "full", "receipt", "structured-only"
      ]);
      expect(status?.inputSchema.properties).not.toHaveProperty("humanText");
      expect(status?.inputSchema.properties).not.toHaveProperty("fields");
      expect(status?.inputSchema.properties).toHaveProperty("afterCursor");
      expect(status?.inputSchema.properties).toHaveProperty("conflictCursor");
      const diff = tools.tools.find((tool) => tool.name === "svn_diff");
      expect(diff?.inputSchema.properties).toHaveProperty("operationId");
      expect(diff?.description).toContain("precommit nextAction");
      const precommit = tools.tools.find((tool) => tool.name === "svn_precommit");
      expect(precommit?.description).toContain("autoFixEol safely preserves current edits");
      expect(precommit?.description).toContain("svn_help");
      const snapshot = tools.tools.find((tool) => tool.name === "svn_snapshot");
      expect(snapshot?.description).toContain("captureBaseline:true detects other writers");
      const commit = tools.tools.find((tool) => tool.name === "svn_commit");
      expect(commit?.description).toContain("Commit exact paths with precommit and EOL checks");
      expect(commit?.description).toContain("svn_help");
      for (const name of ["revision", "expectedRemoteHead"]) {
        const types = (commit?.inputSchema.properties?.[name] as { anyOf?: Array<{ type?: string }> } | undefined)
          ?.anyOf?.map((option) => option.type);
        expect(types).toEqual(expect.arrayContaining(["string", "integer"]));
      }
      expect(commit?.inputSchema.properties?.operationId?.description).toContain("omit");
      // A numeric revision and a string HEAD both pass schema validation and reach the tool.
      const numericSafe = await client.callTool({
        name: "svn_commit",
        arguments: {
          operation: "safe", cwd: path.resolve("missing-wc"), paths: ["a.txt"],
          message: "Update a\n\n- Verified: schema test", revision: 42, expectedRemoteHead: "42"
        }
      });
      expect(JSON.stringify(numericSafe)).not.toMatch(/invalid_union|Input validation error|OPERATION_ID_REQUIRED/i);
      expect(status?.description).toContain("includeUnversioned:false");
      expect(tools.tools.find((tool) => tool.name === "svn_help")?.description).toContain("tool:eol");
      for (const [toolName, names] of Object.entries(advancedInputNames)) {
        const advertised = tools.tools.find((tool) => tool.name === toolName);
        expect(advertised).toBeDefined();
        for (const inputName of names) {
          expect(advertised?.inputSchema.properties).toHaveProperty(inputName);
        }
      }
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
