import { describe, expect, it } from "@jest/globals";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import packageJson from "../package.json" with { type: "json" };
import {
  advancedInputNames, configuredToolProfile, handleTool, serverVersion, toolNamesForProfile
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
