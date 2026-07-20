import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = path.join(root, ".response-benchmark");
const repository = path.join(temporaryRoot, "repo");
const workingCopy = path.join(temporaryRoot, "wc");
const cleanWorkingCopy = path.join(temporaryRoot, "clean-wc");
const svn = path.join(root, "bin", "svn.exe");
const svnadmin = path.join(root, "bin", "svnadmin.exe");
const server = path.join(root, "dist", "index.js");

fs.rmSync(temporaryRoot, { recursive: true, force: true });
fs.mkdirSync(temporaryRoot, { recursive: true });

const transport = new StdioClientTransport({ command: process.execPath, args: [server], cwd: root });
const client = new Client({ name: "response-benchmark", version: "1.0.0" });

try {
  run(svnadmin, ["create", repository]);
  run(svn, ["checkout", pathToFileURL(repository).href, workingCopy]);

  const seed = path.join(workingCopy, "seed.txt");
  fs.writeFileSync(seed, "revision 1\r\n", "utf8");
  run(svn, ["add", seed], workingCopy);
  run(svn, ["commit", seed, "-m", "Add benchmark seed"], workingCopy);
  for (let revision = 2; revision <= 10; revision += 1) {
    fs.writeFileSync(seed, `revision ${revision}\r\n`, "utf8");
    run(svn, ["commit", seed, "-m", `Benchmark revision ${revision}`], workingCopy);
  }
  run(svn, ["checkout", pathToFileURL(repository).href, cleanWorkingCopy]);

  fs.writeFileSync(seed, Array.from({ length: 500 }, (_, index) => `changed line ${index}\r\n`).join(""), "utf8");
  const changes = path.join(workingCopy, "changes");
  fs.mkdirSync(changes);
  for (let index = 0; index < 1000; index += 1) {
    fs.writeFileSync(path.join(changes, `file-${String(index).padStart(4, "0")}.txt`), "new\r\n", "utf8");
  }
  run(svn, ["add", changes], workingCopy);

  await client.connect(transport);
  const listed = await client.listTools();
  const selectedNames = new Set([
    "svn_log", "svn_diff", "svn_diagnose", "svn_precommit", "svn_self_check", "svn_status"
  ]);
  const schemaSizes = {
    allInputSchemas: JSON.stringify(listed.tools.map((tool) => tool.inputSchema)).length,
    selectedInputSchemas: JSON.stringify(
      listed.tools.filter((tool) => selectedNames.has(tool.name)).map((tool) => tool.inputSchema)
    ).length,
    allToolDefinitions: JSON.stringify(listed.tools).length,
    selectedToolDefinitions: JSON.stringify(listed.tools.filter((tool) => selectedNames.has(tool.name))).length
  };

  const rawPrecommit = [
    raw(svn, ["status", seed], workingCopy),
    raw(svn, ["diff", "--internal-diff", "-x", "--ignore-eol-style", seed], workingCopy),
    raw(path.join(root, "bin", "svnversion.exe"), [workingCopy], workingCopy)
  ].join("\n");
  const cases = [
    ["clean status", "svn_status", { cwd: cleanWorkingCopy }, raw(svn, ["status"], cleanWorkingCopy)],
    ["1,001-path status", "svn_status", { cwd: workingCopy, maxItems: 25 }, raw(svn, ["status"], workingCopy)],
    ["10-revision log", "svn_log", { cwd: workingCopy, limit: 10 }, raw(svn, ["log", "-l", "10", pathToFileURL(repository).href], workingCopy)],
    ["500-line file diff", "svn_diff", { cwd: workingCopy, paths: ["seed.txt"], lineLimit: 200 }, raw(svn, ["diff", "--internal-diff", "-x", "--ignore-eol-style", seed], workingCopy)],
    ["one-file precommit", "svn_precommit", { cwd: workingCopy, paths: ["seed.txt"], lineLimit: 200 }, rawPrecommit],
    ["self-check", "svn_self_check", {}, null]
  ];

  const measurements = [];
  for (const [label, name, args, rawOutput] of cases) {
    const compact = await callSize(name, { ...args, responseMode: "compact" });
    const full = await callSize(name, { ...args, responseMode: "full" });
    measurements.push(measurement(label, compact, full, rawOutput));
  }

  const rawAddPath = path.join(workingCopy, "add-raw.txt");
  const fullAddPath = path.join(workingCopy, "add-full.txt");
  const compactAddPath = path.join(workingCopy, "add-compact.txt");
  fs.writeFileSync(rawAddPath, "raw\r\n", "utf8");
  fs.writeFileSync(fullAddPath, "full\r\n", "utf8");
  fs.writeFileSync(compactAddPath, "compact\r\n", "utf8");
  const rawAdd = raw(svn, ["add", rawAddPath], workingCopy);
  const fullAdd = await callSize("svn_add", { cwd: workingCopy, paths: ["add-full.txt"], responseMode: "full" });
  const compactAdd = await callSize("svn_add", { cwd: workingCopy, paths: ["add-compact.txt"], responseMode: "compact" });
  measurements.push(measurement("add receipt", compactAdd, fullAdd, rawAdd));

  process.stdout.write(`${JSON.stringify({ schemaChars: schemaSizes, measurements }, null, 2)}\n`);
} finally {
  await client.close().catch(() => undefined);
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

async function callSize(name, args) {
  const result = await client.callTool({ name, arguments: args });
  return JSON.stringify(result).length;
}

function measurement(label, compact, full, rawOutput) {
  const rawChars = typeof rawOutput === "string" ? rawOutput.length : null;
  return {
    case: label,
    compactChars: compact,
    fullChars: full,
    rawCliChars: rawChars,
    reductionVsFullPercent: percentReduction(full, compact),
    ...(rawChars && rawChars > 0 ? { reductionVsRawCliPercent: percentReduction(rawChars, compact) } : {})
  };
}

function percentReduction(baseline, candidate) {
  return Number((((baseline - candidate) / baseline) * 100).toFixed(1));
}

function raw(executable, args, cwd = root) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.error) {
    throw result.error;
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd();
}

function run(executable, args, cwd = root) {
  execFileSync(executable, args, { cwd, encoding: "utf8", windowsHide: true, stdio: "pipe" });
}
