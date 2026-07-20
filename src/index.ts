#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import * as z from "zod/v4";
import { readonlyMode as isReadonlyMode } from "./guards.js";
import { toToolResult, type ResponseMode } from "./response.js";
import { startupProbe } from "./runner.js";
import { eolFixVerified, svnPrecommit } from "./tools/composite.js";
import { svnDiagnose } from "./tools/diagnose.js";
import { eolCheck, svnDiff, svnInfo, svnLog, svnPropget, svnStatus } from "./tools/readonly.js";
import { svnSelfCheck } from "./tools/selfcheck.js";
import {
  svnAdd,
  svnCleanup,
  svnCommit,
  svnCopy,
  svnExport,
  svnImport,
  svnMove,
  svnPropset,
  svnPropsetEolStyle,
  svnRename,
  svnResolved,
  svnRevert,
  svnUpdate
} from "./tools/mutating.js";
import type { ToolEnvelope } from "./types.js";

export const serverName = "svn";
export const serverVersion = "1.1.0";
export const readonlyMode = isReadonlyMode();

export function createServer(): McpServer {
  const server = new McpServer({
    name: serverName,
    version: serverVersion
  });

  const cwd = z.string().optional().describe("Absolute WC directory; required for relative paths.");
  const paths = z.array(z.string()).describe("Explicit paths inside one WC.");
  const optionalPaths = z.array(z.string()).optional().describe("Optional paths inside one WC.");
  const revision = z.string().regex(/^(?:\d+|HEAD|BASE|COMMITTED|PREV|\{[^}\r\n]+\})$/i).optional();
  const propertyName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/);
  const responseMode = z.enum(["compact", "standard", "full"]).optional();
  const response = { responseMode };
  const cursor = z.string().regex(/^\d+$/).optional();
  const infoField = z.enum([
    "root", "revision", "url", "repositoryRoot", "mixedRevision", "revisionRange",
    "localModifications", "switched", "partial", "remoteHeadRevision", "staleBase"
  ]);
  const propertyField = z.enum(["path", "name", "value"]);

  server.registerTool(
    "svn_self_check",
    {
      description: "Check package and bundled runtime health.",
      inputSchema: { cwd, detailed: z.boolean().optional(), ...response }
    },
    async (args) => publicToolResult("svn_self_check", await svnSelfCheck(compactArgs(args)), args)
  );

  server.registerTool(
    "svn_diagnose",
    {
      description: "Diagnose local and remote working-copy health.",
      inputSchema: { cwd, paths: optionalPaths, ...response }
    },
    async (args) => publicToolResult("svn_diagnose", await svnDiagnose(compactArgs(args)), args)
  );

  server.registerTool(
    "svn_status",
    {
      description: "Return scoped status, counts, and conflicts.",
      inputSchema: {
        cwd,
        paths: optionalPaths,
        includeIgnored: z.boolean().optional(),
        hideNoise: z.boolean().optional(),
        statuses: z.array(z.string()).max(16).optional(),
        includeUnversioned: z.boolean().optional(),
        countOnly: z.boolean().optional(),
        maxItems: z.number().int().min(1).max(500).optional(),
        cursor,
        ...response
      }
    },
    async (args) => publicToolResult("svn_status", await svnStatus(compactArgs(args)), args)
  );

  server.registerTool(
    "svn_info",
    {
      description: "Return WC revision and mixed-revision state.",
      inputSchema: {
        cwd,
        paths: optionalPaths,
        fields: z.array(infoField).max(11).optional(),
        ...response
      }
    },
    async (args) => publicToolResult("svn_info", await svnInfo(compactArgs(args)), args)
  );

  server.registerTool(
    "svn_diff",
    {
      description: "Return a bounded scoped diff and per-file counts.",
      inputSchema: {
        cwd,
        paths,
        ignoreEol: z.boolean().optional(),
        lineLimit: z.number().int().min(1).max(2000).optional(),
        diffMode: z.enum(["summary", "compact", "full"]).optional(),
        maxChars: z.number().int().min(256).max(64000).optional(),
        maxHunksPerFile: z.number().int().min(1).max(20).optional(),
        maxFiles: z.number().int().min(1).max(500).optional(),
        fileCursor: cursor,
        cursor,
        ...response
      }
    },
    async (args) => publicToolResult("svn_diff", await svnDiff(compactArgs(args)), args)
  );

  server.registerTool(
    "svn_log",
    {
      description: "Return bounded structured history.",
      inputSchema: {
        cwd,
        paths: optionalPaths,
        limit: z.number().int().min(1).max(100).optional(),
        verbose: z.boolean().optional(),
        fullMessage: z.boolean().optional(),
        changedPaths: z.boolean().optional(),
        maxMessageChars: z.number().int().min(32).max(8000).optional(),
        maxChangedPaths: z.number().int().min(1).max(500).optional(),
        cursor,
        ...response
      }
    },
    async (args) => publicToolResult("svn_log", await svnLog(compactArgs(args)), args)
  );

  server.registerTool(
    "eol_check",
    {
      description: "Check EOL, BOM, and svn:eol-style.",
      inputSchema: {
        cwd,
        paths,
        includePassing: z.boolean().optional(),
        countOnly: z.boolean().optional(),
        maxItems: z.number().int().min(1).max(500).optional(),
        cursor,
        ...response
      }
    },
    async (args) => publicToolResult("eol_check", await eolCheck(compactArgs(args)), args)
  );

  server.registerTool(
    "svn_propget",
    {
      description: "Read one property from explicit paths.",
      inputSchema: {
        cwd,
        paths,
        name: propertyName,
        fields: z.array(propertyField).max(3).optional(),
        maxValueChars: z.number().int().min(256).max(64000).optional(),
        countOnly: z.boolean().optional(),
        maxItems: z.number().int().min(1).max(500).optional(),
        cursor,
        ...response
      }
    },
    async (args) => publicToolResult("svn_propget", await svnPropget(compactArgs(args)), args)
  );

  server.registerTool(
    "svn_precommit",
    {
      description: "Run guarded status, diff, EOL, and revision checks.",
      inputSchema: {
        cwd,
        paths,
        lineLimit: z.number().int().min(1).max(2000).optional(),
        includeDiff: z.boolean().optional(),
        maxChars: z.number().int().min(256).max(64000).optional(),
        ...response
      }
    },
    async (args) => publicToolResult("svn_precommit", await svnPrecommit(compactArgs(args)), args)
  );

  server.registerTool(
    "eol_fix_verified",
    {
      description: "Normalize and verify one file's EOL.",
      inputSchema: {
        cwd,
        path: z.string(),
        target: z.enum(["crlf", "lf"]).optional(),
        removeBom: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        allowLarge: z.boolean().optional(),
        ...response
      }
    },
    async (args) => publicToolResult("eol_fix_verified", await eolFixVerified(compactArgs(args)), args)
  );

  server.registerTool(
    "svn_add",
    {
      description: "Guarded add for explicit paths.",
      inputSchema: { cwd, paths, allowRecursive: z.boolean().optional(), ...response }
    },
    async (args) => publicToolResult("svn_add", await svnAdd(compactArgs(args)), args)
  );

  server.registerTool(
    "svn_commit",
    {
      description: "Guarded commit with explicit paths and message.",
      inputSchema: {
        cwd,
        paths,
        message: z.string(),
        riskAck: z.boolean().optional(),
        ...response
      }
    },
    async (args) => publicToolResult("svn_commit", await svnCommit(compactArgs(args)), args)
  );

  server.registerTool(
    "svn_move",
    {
      description: "Guarded working-copy move.",
      inputSchema: { cwd, src: z.string(), dest: z.string(), ...response }
    },
    async (args) => publicToolResult("svn_move", await svnMove(compactArgs(args)), args)
  );

  server.registerTool(
    "svn_rename",
    {
      description: "Alias for guarded working-copy move.",
      inputSchema: { cwd, src: z.string(), dest: z.string(), ...response }
    },
    async (args) => publicToolResult("svn_rename", await svnRename(compactArgs(args)), args)
  );

  server.registerTool(
    "svn_copy",
    {
      description: "Guarded working-copy copy.",
      inputSchema: { cwd, src: z.string(), dest: z.string(), ...response }
    },
    async (args) => publicToolResult("svn_copy", await svnCopy(compactArgs(args)), args)
  );

  server.registerTool(
    "svn_update",
    {
      description: "Guarded update with conflicts postponed.",
      inputSchema: { cwd, paths: optionalPaths, updateAll: z.boolean().optional(), ...response }
    },
    async (args) => publicToolResult("svn_update", await svnUpdate(compactArgs(args)), args)
  );

  server.registerTool(
    "svn_revert",
    {
      description: "Preview or perform a guarded revert.",
      inputSchema: {
        cwd,
        paths,
        allowRecursive: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        ...response
      }
    },
    async (args) => publicToolResult("svn_revert", await svnRevert(compactArgs(args)), args)
  );

  server.registerTool(
    "svn_resolved",
    {
      description: "Resolve one conflict with an explicit mode.",
      inputSchema: {
        cwd,
        path: z.string(),
        accept: z.enum(["working", "mine-full", "theirs-full", "base"]),
        ...response
      }
    },
    async (args) => publicToolResult("svn_resolved", await svnResolved(compactArgs(args)), args)
  );

  server.registerTool(
    "svn_cleanup",
    {
      description: "Run non-destructive WC cleanup.",
      inputSchema: { cwd, path: z.string().optional(), ...response }
    },
    async (args) => publicToolResult("svn_cleanup", await svnCleanup(compactArgs(args)), args)
  );

  server.registerTool(
    "svn_propset_eol_style",
    {
      description: "Set svn:eol-style on explicit files.",
      inputSchema: {
        cwd,
        paths,
        style: z.enum(["native", "LF", "CRLF"]).optional(),
        ...response
      }
    },
    async (args) => publicToolResult("svn_propset_eol_style", await svnPropsetEolStyle(compactArgs(args)), args)
  );

  server.registerTool(
    "svn_propset",
    {
      description: "Guarded property write on explicit paths.",
      inputSchema: {
        cwd,
        paths,
        name: propertyName,
        value: z.string().max(16000),
        riskAck: z.boolean().optional(),
        ...response
      }
    },
    async (args) => publicToolResult("svn_propset", await svnPropset(compactArgs(args)), args)
  );

  server.registerTool(
    "svn_export",
    {
      description: "Export an explicit SVN source.",
      inputSchema: {
        cwd,
        src: z.string(),
        dest: z.string(),
        revision,
        ...response
      }
    },
    async (args) => publicToolResult("svn_export", await svnExport(compactArgs(args)), args)
  );

  server.registerTool(
    "svn_import",
    {
      description: "Import with an explicit source, URL, and message.",
      inputSchema: {
        cwd,
        src: z.string(),
        url: z.string(),
        message: z.string(),
        ...response
      }
    },
    async (args) => publicToolResult("svn_import", await svnImport(compactArgs(args)), args)
  );

  return server;
}

function publicToolResult(tool: string, payload: ToolEnvelope, request: Record<string, unknown>) {
  const requestedMode = request.responseMode;
  const responseMode: ResponseMode | undefined = requestedMode === "compact" || requestedMode === "standard" || requestedMode === "full"
    ? requestedMode
    : undefined;
  return toToolResult(tool, payload, {
    ...(responseMode ? { responseMode } : {}),
    request
  });
}

type CompactArgs<T extends Record<string, unknown>> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

function compactArgs<T extends Record<string, unknown>>(args: T): CompactArgs<T> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)) as CompactArgs<T>;
}

export async function main(): Promise<void> {
  const probe = await startupProbe();
  if (!probe.svn.ok) {
    console.error(`svn-agent starting with unavailable svn: ${probe.svn.note}`);
  }
  if (!probe.dos2unix.ok || !probe.unix2dos.ok) {
    console.error("svn-agent starting with unavailable EOL converter; eol_fix_verified may fail");
  }

  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(`svn MCP ${serverVersion} running on stdio${isReadonlyMode() ? " (READONLY)" : ""}`);
}

// Node resolves the ESM entry module through junctions/symlinks, so when the
// server is launched via the documented `current` junction, import.meta.url
// points at releases\v<version>\... while argv[1] keeps the junction path.
// Compare real paths so both launch forms start the server.
const launchedDirectly = (() => {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  if (import.meta.url === pathToFileURL(entry).href) {
    return true;
  }
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync.native(entry)).href;
  } catch {
    return false;
  }
})();

if (launchedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
