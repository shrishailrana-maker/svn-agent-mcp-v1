import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { svnAdminExecutable, svnExecutable, svnVersionExecutable } from "../dist/runner.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = path.join(root, ".response-benchmark");
const repository = path.join(temporaryRoot, "repo");
const workingCopy = path.join(temporaryRoot, "wc");
const cleanWorkingCopy = path.join(temporaryRoot, "clean-wc");
const svn = svnExecutable();
const svnadmin = svnAdminExecutable();
const svnversion = svnVersionExecutable();
const server = path.join(root, "dist", "index.js");
const enforceBudgets = process.argv.includes("--check");
const schemaBudgets = {
  // v1.7.0 publishes guard, recovery, snapshot, and workflow contracts in live descriptions.
  // Keep roughly five percent headroom above the measured canonical 29-tool
  // contract so later growth still fails closed.
  allInputSchemas: 23500,
  selectedInputSchemas: 5500,
  allToolDefinitions: 30800,
  selectedToolDefinitions: 7000
};
const compactBudgets = {
  "clean status": 250,
  "status count only": 250,
  "1,001-path status": 1800,
  "10-revision log": 1500,
  "500-line file diff": 4000,
  "one-file precommit": 1000,
  "self-check": 400,
  "add receipt": 250,
  "safe commit": 2800
};
const receiptBudgets = {
  "clean status": 200,
  "status count only": 200,
  "1,001-path status": 800,
  "one-file precommit": 500,
  "safe commit": 2800
};
const receiptTools = new Set(["svn_status", "svn_snapshot", "svn_precommit", "svn_update", "svn_commit"]);
const profileSchemaBudgets = {
  docs: { toolCount: 8, inputSchemas: 7000, toolDefinitions: 9700 },
  review: { toolCount: 11, inputSchemas: 9700, toolDefinitions: 13300 }
};

fs.rmSync(temporaryRoot, { recursive: true, force: true });
fs.mkdirSync(temporaryRoot, { recursive: true });

const transport = new StdioClientTransport({ command: process.execPath, args: [server], cwd: root });
const client = new Client({ name: "response-benchmark", version: "1.0.0" });

try {
  run(svnadmin, ["create", repository]);
  run(svn, ["checkout", pathToFileURL(repository).href, workingCopy]);

  const seed = path.join(workingCopy, "seed.txt");
  const commitMessageFile = path.join(temporaryRoot, "commit-message.txt");
  fs.writeFileSync(seed, "revision 1\r\n", "utf8");
  run(svn, ["add", seed], workingCopy);
  fs.writeFileSync(commitMessageFile, "Add benchmark seed\n", "utf8");
  run(svn, ["commit", seed, "-F", commitMessageFile], workingCopy);
  for (let revision = 2; revision <= 10; revision += 1) {
    fs.writeFileSync(seed, `revision ${revision}\r\n`, "utf8");
    fs.writeFileSync(commitMessageFile, `Benchmark revision ${revision}\n`, "utf8");
    run(svn, ["commit", seed, "-F", commitMessageFile], workingCopy);
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
  const profileSchemas = {
    docs: await measureProfileSchemas("docs"),
    review: await measureProfileSchemas("review")
  };

  const rawPrecommit = [
    raw(svn, ["status", seed], workingCopy),
    raw(svn, ["diff", "--internal-diff", "-x", "--ignore-eol-style", seed], workingCopy),
    raw(svnversion, [workingCopy], workingCopy)
  ].join("\n");
  const cases = [
    ["clean status", "svn_status", { cwd: cleanWorkingCopy }, raw(svn, ["status"], cleanWorkingCopy)],
    ["status count only", "svn_status", { cwd: workingCopy, countOnly: true }, raw(svn, ["status"], workingCopy)],
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
    const receipt = receiptTools.has(name) ? await callSize(name, { ...args, responseMode: "receipt" }) : null;
    measurements.push(measurement(label, compact, full, rawOutput, receipt));
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
  measurements.push(measurement("add receipt", compactAdd, fullAdd, rawAdd, null));

  const safeSizes = {};
  for (const mode of ["compact", "full", "receipt"]) {
    const relative = `safe-${mode}.txt`;
    fs.writeFileSync(path.join(workingCopy, relative), `${mode}\r\n`, "utf8");
    run(svn, ["add", relative], workingCopy);
    const head = Number(raw(svn, ["info", "-r", "HEAD", "--show-item", "revision", pathToFileURL(repository).href], workingCopy));
    safeSizes[mode] = await callSize("svn_commit", {
      operation: "safe",
      cwd: workingCopy,
      paths: [relative],
      message: `Benchmark safe ${mode}\n\n- Measure bounded workflow receipt\n- Preserve response budgets\n`,
      revision: String(head),
      expectedRemoteHead: head,
      operationId: randomUUID(),
      responseMode: mode
    });
  }
  measurements.push(measurement("safe commit", safeSizes.compact, safeSizes.full, null, safeSizes.receipt));

  const failures = budgetFailures(schemaSizes, profileSchemas, measurements);
  process.stdout.write(`${JSON.stringify({ schemaChars: schemaSizes, profileSchemas, measurements, budgetFailures: failures }, null, 2)}\n`);
  if (enforceBudgets && failures.length > 0) {
    process.exitCode = 1;
  }
} finally {
  await client.close().catch(() => undefined);
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

async function callSize(name, args) {
  const result = await client.callTool({ name, arguments: args });
  return JSON.stringify(result).length;
}

function measurement(label, compact, full, rawOutput, receipt) {
  const rawChars = typeof rawOutput === "string" ? rawOutput.length : null;
  return {
    case: label,
    compactChars: compact,
    ...(typeof receipt === "number" ? { receiptChars: receipt } : {}),
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

function budgetFailures(schemaSizes, profileSchemas, measurements) {
  const failures = [];
  for (const [name, maximum] of Object.entries(schemaBudgets)) {
    if (schemaSizes[name] > maximum) {
      failures.push(`schema ${name}: ${schemaSizes[name]} > ${maximum}`);
    }
  }
  for (const [profile, maximums] of Object.entries(profileSchemaBudgets)) {
    const measured = profileSchemas[profile];
    for (const [name, maximum] of Object.entries(maximums)) {
      if (measured[name] > maximum) {
        failures.push(`${profile} profile ${name}: ${measured[name]} > ${maximum}`);
      }
    }
  }
  for (const result of measurements) {
    const maximum = compactBudgets[result.case];
    if (maximum !== undefined) {
      result.compactBudgetChars = maximum;
      if (result.compactChars > maximum) {
        failures.push(`${result.case}: ${result.compactChars} > ${maximum}`);
      }
    }
    const receiptMaximum = receiptBudgets[result.case];
    if (receiptMaximum !== undefined && typeof result.receiptChars === "number") {
      result.receiptBudgetChars = receiptMaximum;
      if (result.receiptChars > receiptMaximum) {
        failures.push(`${result.case} receipt: ${result.receiptChars} > ${receiptMaximum}`);
      }
    }
  }
  return failures;
}

async function measureProfileSchemas(profile) {
  const profileTransport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    cwd: root,
    env: {
      ...stringEnvironment(process.env),
      SVN_MCP_TOOL_PROFILE: profile
    },
    stderr: "ignore"
  });
  const profileClient = new Client({ name: `response-benchmark-${profile}`, version: "1.0.0" });
  try {
    await profileClient.connect(profileTransport);
    const listed = await profileClient.listTools();
    const hidden = await profileClient.callTool({ name: "svn_delete", arguments: { paths: ["unused"] } });
    const refusal = hidden.structuredContent ?? {};
    if (refusal.code !== "TOOL_PROFILE" || refusal.tool !== "svn_delete" || refusal.activeProfile !== profile) {
      throw new Error(`${profile} profile did not return a typed hidden-tool refusal`);
    }
    return {
      toolCount: listed.tools.length,
      inputSchemas: JSON.stringify(listed.tools.map((tool) => tool.inputSchema)).length,
      toolDefinitions: JSON.stringify(listed.tools).length
    };
  } finally {
    await profileClient.close().catch(() => undefined);
  }
}

function stringEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter((entry) => typeof entry[1] === "string"));
}
