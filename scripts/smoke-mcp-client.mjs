#!/usr/bin/env node

import { execFileSync } from "node:child_process";
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

try {
  run(svnadmin, ["create", repository], temporaryRoot);
  run(svn, ["checkout", pathToFileURL(repository).href, workingCopy], temporaryRoot);

  const client = new Client({ name: "svn-agent-client-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "dist", "index.js")],
    stderr: "ignore"
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert(tools.tools.length === 23, `expected 23 tools, received ${tools.tools.length}`);
    passed.push("handshake");

    const statusTool = tools.tools.find((tool) => tool.name === "svn_status");
    assert(statusTool?.inputSchema?.properties?.paths?.maxItems === 500, "status paths are not publicly bounded");
    passed.push("input-bounds");

    const selfCheck = await call(client, "svn_self_check", { cwd: workingCopy, responseMode: "compact" });
    assert(selfCheck.ok === true && selfCheck.available === true, "self-check was not healthy");
    passed.push("self-check");

    fs.writeFileSync(path.join(workingCopy, "client-smoke.txt"), "one\r\n", "utf8");
    await callOk(client, "svn_add", { cwd: workingCopy, paths: ["client-smoke.txt"] });
    passed.push("add");

    const status = await callOk(client, "svn_status", { cwd: workingCopy });
    assert(status.items.some((item) => item.path === "client-smoke.txt" && item.status === "added"), "status omitted added file");
    passed.push("status");

    const precommit = await callOk(client, "svn_precommit", { cwd: workingCopy, paths: ["client-smoke.txt"] });
    assert(precommit.ready === true, "precommit did not report ready");
    passed.push("precommit");

    const committed = await callOk(client, "svn_commit", {
      cwd: workingCopy,
      paths: ["client-smoke.txt"],
      message: "MCP client smoke\n\n- Exercise the public protocol\n- Verify guarded commit behavior\n"
    });
    assert(Number.isInteger(committed.revision), "commit omitted its revision");
    passed.push("commit");

    fs.writeFileSync(path.join(workingCopy, "client-smoke.txt"), "one\r\ntwo\r\n", "utf8");
    const diff = await callOk(client, "svn_diff", { cwd: workingCopy, paths: ["client-smoke.txt"] });
    assert(
      diff.files.some((item) => item.path === "client-smoke.txt" && item.added === 1),
      `diff summary was incorrect: ${JSON.stringify(diff)}`
    );
    passed.push("diff");

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
