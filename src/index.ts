#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import * as z from "zod/v4";
import { toToolResult } from "./envelope.js";
import { readonlyMode as isReadonlyMode } from "./guards.js";
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

export const serverName = "svn";
export const serverVersion = "1.0.0";
export const readonlyMode = isReadonlyMode();

export function createServer(): McpServer {
  const server = new McpServer({
    name: serverName,
    version: serverVersion
  });

  const cwd = z.string().optional().describe("Absolute working directory. If omitted, absolute paths identify their SVN working copy; relative paths require explicit cwd.");
  const paths = z.array(z.string()).describe("Explicit paths relative to cwd or absolute paths inside one SVN working copy.");
  const optionalPaths = z.array(z.string()).optional().describe("Optional paths relative to cwd or absolute paths inside one SVN working copy.");
  const revision = z.string().regex(/^(?:\d+|HEAD|BASE|COMMITTED|PREV|\{[^}\r\n]+\})$/i).optional();
  const propertyName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/);

  server.registerTool(
    "svn_self_check",
    {
      description: "Report MCP release pointer, bundled runtime payload counts, startup probe, and packaging script health.",
      inputSchema: { cwd }
    },
    async (args) => toToolResult(await svnSelfCheck(compactArgs(args)))
  );

  server.registerTool(
    "svn_diagnose",
    {
      description: "Read-only working-copy diagnostics for local status, remote status, HEAD info, and latest log reachability.",
      inputSchema: { cwd, paths: optionalPaths }
    },
    async (args) => toToolResult(await svnDiagnose(compactArgs(args)))
  );

  server.registerTool(
    "svn_status",
    {
      description: "Run scoped svn status and return structured changed paths and conflicts.",
      inputSchema: { cwd, paths: optionalPaths, includeIgnored: z.boolean().optional(), hideNoise: z.boolean().optional() }
    },
    async (args) => toToolResult(await svnStatus(compactArgs(args)))
  );

  server.registerTool(
    "svn_info",
    {
      description: "Run svn info and detect mixed-revision working-copy state.",
      inputSchema: { cwd, paths: optionalPaths }
    },
    async (args) => toToolResult(await svnInfo(compactArgs(args)))
  );

  server.registerTool(
    "svn_diff",
    {
      description: "Run scoped svn diff; ignore-EOL is enabled by default with internal diff and returns per-file counts.",
      inputSchema: {
        cwd,
        paths,
        ignoreEol: z.boolean().optional(),
        lineLimit: z.number().int().positive().optional()
      }
    },
    async (args) => toToolResult(await svnDiff(compactArgs(args)))
  );

  server.registerTool(
    "svn_log",
    {
      description: "Run svn log and return structured log entries.",
      inputSchema: {
        cwd,
        paths: optionalPaths,
        limit: z.number().int().positive().optional(),
        verbose: z.boolean().optional()
      }
    },
    async (args) => toToolResult(await svnLog(compactArgs(args)))
  );

  server.registerTool(
    "eol_check",
    {
      description: "Inspect EOL kind, BOM, and svn:eol-style for explicit files.",
      inputSchema: { cwd, paths }
    },
    async (args) => toToolResult(await eolCheck(compactArgs(args)))
  );

  server.registerTool(
    "svn_propget",
    {
      description: "Read one working-copy property from explicit paths.",
      inputSchema: {
        cwd,
        paths,
        name: propertyName
      }
    },
    async (args) => toToolResult(await svnPropget(compactArgs(args)))
  );

  server.registerTool(
    "svn_precommit",
    {
      description: "Composite read-only precommit check: status, ignore-EOL diff, EOL check, guard dry-run, and mixed-revision warning.",
      inputSchema: {
        cwd,
        paths,
        lineLimit: z.number().int().positive().optional()
      }
    },
    async (args) => toToolResult(await svnPrecommit(compactArgs(args)))
  );

  server.registerTool(
    "eol_fix_verified",
    {
      description: "Convert one file's EOL with unix2dos/dos2unix inferred from svn:eol-style, then verify the ignored-EOL diff.",
      inputSchema: {
        cwd,
        path: z.string(),
        target: z.enum(["crlf", "lf"]).optional(),
        removeBom: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        allowLarge: z.boolean().optional()
      }
    },
    async (args) => toToolResult(await eolFixVerified(compactArgs(args)))
  );

  server.registerTool(
    "svn_add",
    {
      description: "Guarded svn add for explicit files, adding needed parent directories, or explicitly recursive directories.",
      inputSchema: { cwd, paths, allowRecursive: z.boolean().optional() }
    },
    async (args) => toToolResult(await svnAdd(compactArgs(args)))
  );

  server.registerTool(
    "svn_commit",
    {
      description: "Guarded svn commit using a temp -F message file and explicit paths.",
      inputSchema: {
        cwd,
        paths,
        message: z.string(),
        riskAck: z.boolean().optional()
      }
    },
    async (args) => toToolResult(await svnCommit(compactArgs(args)))
  );

  server.registerTool(
    "svn_move",
    {
      description: "Guarded working-copy svn move with parent directory creation.",
      inputSchema: { cwd, src: z.string(), dest: z.string() }
    },
    async (args) => toToolResult(await svnMove(compactArgs(args)))
  );

  server.registerTool(
    "svn_rename",
    {
      description: "Alias for guarded working-copy svn move/rename with parent directory creation.",
      inputSchema: { cwd, src: z.string(), dest: z.string() }
    },
    async (args) => toToolResult(await svnRename(compactArgs(args)))
  );

  server.registerTool(
    "svn_copy",
    {
      description: "Guarded working-copy svn copy with parent directory creation.",
      inputSchema: { cwd, src: z.string(), dest: z.string() }
    },
    async (args) => toToolResult(await svnCopy(compactArgs(args)))
  );

  server.registerTool(
    "svn_update",
    {
      description: "Guarded svn update with --accept postpone.",
      inputSchema: { cwd, paths: optionalPaths, updateAll: z.boolean().optional() }
    },
    async (args) => toToolResult(await svnUpdate(compactArgs(args)))
  );

  server.registerTool(
    "svn_revert",
    {
      description: "Preview or perform guarded svn revert for explicit paths.",
      inputSchema: {
        cwd,
        paths,
        allowRecursive: z.boolean().optional(),
        dryRun: z.boolean().optional()
      }
    },
    async (args) => toToolResult(await svnRevert(compactArgs(args)))
  );

  server.registerTool(
    "svn_resolved",
    {
      description: "Resolve one conflicted path with an explicit accept mode.",
      inputSchema: {
        cwd,
        path: z.string(),
        accept: z.enum(["working", "mine-full", "theirs-full", "base"])
      }
    },
    async (args) => toToolResult(await svnResolved(compactArgs(args)))
  );

  server.registerTool(
    "svn_cleanup",
    {
      description: "Run svn cleanup without destructive cleanup flags.",
      inputSchema: { cwd, path: z.string().optional() }
    },
    async (args) => toToolResult(await svnCleanup(compactArgs(args)))
  );

  server.registerTool(
    "svn_propset_eol_style",
    {
      description: "Set svn:eol-style only for explicit files whose property is missing or mismatched.",
      inputSchema: {
        cwd,
        paths,
        style: z.enum(["native", "LF", "CRLF"]).optional()
      }
    },
    async (args) => toToolResult(await svnPropsetEolStyle(compactArgs(args)))
  );

  server.registerTool(
    "svn_propset",
    {
      description: "Guarded working-copy svn propset for explicit paths.",
      inputSchema: {
        cwd,
        paths,
        name: propertyName,
        value: z.string().max(16000),
        riskAck: z.boolean().optional()
      }
    },
    async (args) => toToolResult(await svnPropset(compactArgs(args)))
  );

  server.registerTool(
    "svn_export",
    {
      description: "Run explicit svn export.",
      inputSchema: {
        cwd,
        src: z.string(),
        dest: z.string(),
        revision
      }
    },
    async (args) => toToolResult(await svnExport(compactArgs(args)))
  );

  server.registerTool(
    "svn_import",
    {
      description: "Run svn import with a temp -F message file.",
      inputSchema: {
        cwd,
        src: z.string(),
        url: z.string(),
        message: z.string()
      }
    },
    async (args) => toToolResult(await svnImport(compactArgs(args)))
  );

  return server;
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
