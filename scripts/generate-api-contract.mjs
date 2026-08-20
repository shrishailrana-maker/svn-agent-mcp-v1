#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { advancedInputNames, createServer, fieldProjectionNames, serverName, serverVersion } from "../dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(root, "docs", "MCP_API.json");
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createServer("full");
const client = new Client({ name: "svn-agent-contract-generator", version: serverVersion });

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  const prompts = await client.listPrompts();
  const content = `${JSON.stringify({
    schemaVersion: 1,
    server: { name: serverName, version: serverVersion },
    globalResponseControls: {
      humanText: "boolean; compatibility input; every mode except structured-only returns one bounded text block",
      responseBudgets: {
        textContentChars: 1024,
        compactLogBytes: 24576,
        compactDiffBytes: 28672
      },
      runtimeLimits: {
        hashConcurrency: "SVN_MCP_HASH_CONCURRENCY; default 4; range 1..32",
        aggregateHashBytes: "SVN_MCP_MAX_HASH_BYTES; default 1073741824; minimum 1048576",
        receiptLockWait: "asynchronous; default 5000 ms"
      },
      fieldProjections: fieldProjectionNames,
      advancedInputs: {
        names: advancedInputNames,
        limits: {
          afterCursor: "opaque string; max 64 chars",
          operationId: "UUID",
          baselineToken: "opaque UUID; process-local and exact-scope bound",
          precommitToken: "opaque UUID; process-local and exact-state bound",
          detailOperationId: "opaque UUID; process-local safe-operation evidence",
          file: "path; max 4096 chars",
          messageContains: "1..256 chars",
          scanLimit: "1..500",
          maxTopLevelDirectories: "1..50",
          maxItems: "1..500",
          cursor: "decimal string; 0..9007199254740991",
          maxChars: "256..64000",
          conflictCursor: "decimal string; 0..9007199254740991; conflict pages contain at most 100 items",
          taskPaths: "1..500 paths; each max 4096 chars"
        }
      }
    },
    tools: listed.tools,
    prompts: prompts.prompts
  }, null, 2)}\n`;

  if (process.argv.includes("--check")) {
    if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== content) {
      throw new Error("docs/MCP_API.json is stale; run npm run generate:api-contract");
    }
  } else {
    fs.writeFileSync(outputPath, content, "utf8");
  }
} finally {
  await client.close();
  await server.close();
}
