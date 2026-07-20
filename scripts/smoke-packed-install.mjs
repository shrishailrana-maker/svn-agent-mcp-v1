#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "svn-agent-npm-smoke-"));
let tarball = null;

try {
  const packed = JSON.parse(runNpm(["pack", "--json"], root));
  const metadata = Array.isArray(packed) ? packed[0] : packed["svn-agent-mcp"] ?? Object.values(packed)[0];
  const filename = metadata?.filename;
  if (!filename) {
    throw new Error("npm pack did not report a tarball filename");
  }

  tarball = path.resolve(root, filename);
  assertInside(root, tarball);
  runNpm(["install", "--prefix", installRoot, "--ignore-scripts", "--no-audit", "--no-fund", tarball], root);

  const packageRoot = path.join(installRoot, "node_modules", "svn-agent-mcp");
  const shim = path.join(installRoot, "node_modules", ".bin", process.platform === "win32" ? "svn-agent-mcp.cmd" : "svn-agent-mcp");
  if (!fs.existsSync(shim)) {
    throw new Error(`installed command shim is missing: ${shim}`);
  }

  for (const relative of [
    "third_party_licenses/apache-subversion-windows/Subversion License.txt",
    "third_party_licenses/apache-subversion-windows/Subversion NOTICE.txt",
    "third_party_licenses/dos2unix/COPYING.txt"
  ]) {
    if (!fs.existsSync(path.join(packageRoot, relative))) {
      throw new Error(`installed third-party notice is missing: ${relative}`);
    }
  }
  const staleRuntimeFiles = fs.readdirSync(path.join(packageRoot, "bin"))
    .filter((name) => /Slik|libssl|libcrypto/i.test(name));
  if (staleRuntimeFiles.length > 0) {
    throw new Error(`installed package contains retired runtime files: ${staleRuntimeFiles.join(", ")}`);
  }

  const selfcheckModule = path.join(packageRoot, "dist", "tools", "selfcheck.js");
  const { svnSelfCheck } = await import(pathToFileURL(selfcheckModule).href);
  const check = await svnSelfCheck({ cwd: root });
  if (!check.ok || check.runtime_layout !== "npm-package" || check.runtime_layout_ok !== true) {
    throw new Error(`installed package self-check failed: ${JSON.stringify(check)}`);
  }
  if (check.release_prepare_available !== false) {
    throw new Error("installed package incorrectly reports source-only release preparation as available");
  }

  const client = new Client({ name: "packed-install-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: shim,
    stderr: "ignore"
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (tools.tools.length !== 23) {
      throw new Error(`installed MCP exposed ${tools.tools.length} tools instead of 23`);
    }
    const response = await client.callTool({
      name: "svn_self_check",
      arguments: { responseMode: "compact" }
    });
    const health = response.structuredContent;
    if (!health || health.ok !== true || health.version !== check.package_version) {
      throw new Error(`installed MCP self-check failed: ${JSON.stringify(health)}`);
    }
  } finally {
    await client.close();
  }

  console.log(`Packed install smoke passed: ${filename}`);
  console.log("  MCP handshake: 23 tools, healthy self-check");
  console.log(`  layout: ${check.runtime_layout}`);
  console.log(`  dist files: ${check.dist_file_count}`);
  console.log(`  bin files: ${check.bin_file_count}`);
} finally {
  fs.rmSync(installRoot, { recursive: true, force: true });
  if (tarball && fs.existsSync(tarball)) {
    assertInside(root, tarball);
    fs.rmSync(tarball, { force: true });
  }
}

function runNpm(args, cwd) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : platformNpmCommand();
  const commandArgs = npmExecPath ? [npmExecPath, ...args] : args;
  const result = spawnSync(command, commandArgs, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`npm ${args[0]} failed (${result.status}): ${result.stderr.trim()}`);
  }
  if (/\bEBADENGINE\b/.test(result.stderr)) {
    throw new Error(`npm ${args[0]} reported an engine mismatch: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function platformNpmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function assertInside(base, candidate) {
  const relative = path.relative(base, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`path is outside the project root: ${candidate}`);
  }
}
