#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, serverName, serverVersion } from "../dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(root, "docs", "MCP_API.json");
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createServer();
const client = new Client({ name: "svn-agent-contract-generator", version: serverVersion });

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  const content = `${JSON.stringify({
    schemaVersion: 1,
    server: { name: serverName, version: serverVersion },
    tools: listed.tools
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
