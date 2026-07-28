import { describe, expect, it } from "@jest/globals";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { handleTool, serverVersion } from "../src/index.js";

const distIndex = path.resolve("dist", "index.js");

describe("server entrypoint launch detection", () => {
  it("uses the package version as the MCP server version", () => {
    expect(serverVersion).toBe(packageJson.version);
  });

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
