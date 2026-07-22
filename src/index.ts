#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import * as z from "zod/v4";
import packageJson from "../package.json" with { type: "json" };
import { failEnvelope } from "./envelope.js";
import { readonlyMode as isReadonlyMode } from "./guards.js";
import { toToolResult, type ResponseMode } from "./response.js";
import { startupProbe, withRequestCancellation } from "./runner.js";
import { eolFixVerified, svnPrecommit, svnSnapshot } from "./tools/composite.js";
import { svnDiagnose } from "./tools/diagnose.js";
import { eolCheck, svnBlame, svnCat, svnDiff, svnInfo, svnLog, svnPropget, svnStatus } from "./tools/readonly.js";
import { svnSelfCheck } from "./tools/selfcheck.js";
import {
  svnAdd,
  svnCleanup,
  svnCommit,
  svnCopy,
  svnDelete,
  svnExport,
  svnImport,
  svnMove,
  svnPropset,
  svnPropsetEolStyle,
  svnRename,
  svnResolve,
  svnResolved,
  svnRevert,
  svnUpdate
} from "./tools/mutating.js";
import type { ToolEnvelope } from "./types.js";

export const serverName = "svn";
export const serverVersion = packageJson.version;
export const readonlyMode = isReadonlyMode();

export function createServer(): McpServer {
  const server = new McpServer({
    name: serverName,
    version: serverVersion
  });

  const noNul = /^[^\x00]*$/;
  const filesystemPath = z.string().min(1).max(4096).regex(noNul, "must not contain NUL");
  const repositoryLocation = z.string().min(1).max(8192).regex(noNul, "must not contain NUL");
  const commitMessage = z.string().min(1).max(16000).regex(noNul, "must not contain NUL");
  const cwd = filesystemPath.optional().describe("Absolute WC directory; required for relative paths.");
  const paths = z.array(filesystemPath).min(1).max(500).describe("Explicit paths inside one WC.");
  const optionalPaths = z.array(filesystemPath).max(500).optional().describe("Optional paths inside one WC.");
  const revision = z.string().max(128).regex(/^(?:\d+|HEAD|BASE|COMMITTED|PREV|\{[^}\r\n\x00]+\})$/i).optional();
  const revisionSelector = z.string().max(257).regex(
    /^(?:\d+|HEAD|BASE|COMMITTED|PREV|\{[^}\r\n\x00]+\})(?::(?:\d+|HEAD|BASE|COMMITTED|PREV|\{[^}\r\n\x00]+\}))?$/i
  ).optional();
  const propertyName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/);
  const responseMode = z.enum(["compact", "standard", "full"]).optional();
  const response = { responseMode };
  const cursor = z.string().max(32).regex(/^\d+$/).optional();
  // svn_log cursors may carry the range floor as "next:floor".
  const logCursor = z.string().max(65).regex(/^\d+(?::\d+)?$/).optional();
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
    async (args, extra) => handleTool("svn_self_check", args, extra.signal, () => svnSelfCheck(compactArgs(args), serverVersion))
  );

  server.registerTool(
    "svn_diagnose",
    {
      description: "Diagnose local and remote working-copy health.",
      inputSchema: { cwd, paths: optionalPaths, ...response }
    },
    async (args, extra) => handleTool("svn_diagnose", args, extra.signal, () => svnDiagnose(compactArgs(args)))
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
        statuses: z.array(z.string().max(64)).max(16).optional(),
        includeUnversioned: z.boolean().optional(),
        countOnly: z.boolean().optional(),
        maxItems: z.number().int().min(1).max(500).optional(),
        cursor,
        ...response
      }
    },
    async (args, extra) => handleTool("svn_status", args, extra.signal, () => svnStatus(compactArgs(args)))
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
    async (args, extra) => handleTool("svn_info", args, extra.signal, () => svnInfo(compactArgs(args)))
  );

  server.registerTool(
    "svn_snapshot",
    {
      description: "Return one compact working-copy status and revision snapshot.",
      inputSchema: {
        cwd,
        paths: optionalPaths,
        includeIgnored: z.boolean().optional(),
        hideNoise: z.boolean().optional(),
        statuses: z.array(z.string().max(64)).max(16).optional(),
        includeUnversioned: z.boolean().optional(),
        countOnly: z.boolean().optional(),
        maxItems: z.number().int().min(1).max(500).optional(),
        cursor,
        ...response
      }
    },
    async (args, extra) => handleTool("svn_snapshot", args, extra.signal, () => svnSnapshot(compactArgs(args)))
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
        revision: revisionSelector,
        ...response
      }
    },
    async (args, extra) => handleTool("svn_diff", args, extra.signal, () => svnDiff(compactArgs(args)))
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
        cursor: logCursor,
        revision: revisionSelector,
        ...response
      }
    },
    async (args, extra) => handleTool("svn_log", args, extra.signal, () => svnLog(compactArgs(args)))
  );

  server.registerTool(
    "svn_cat",
    {
      description: "Return a bounded page of one file at an optional revision.",
      inputSchema: {
        cwd,
        path: filesystemPath,
        revision,
        maxChars: z.number().int().min(256).max(64000).optional(),
        cursor,
        ...response
      }
    },
    async (args, extra) => handleTool("svn_cat", args, extra.signal, () => svnCat(compactArgs(args)))
  );

  server.registerTool(
    "svn_blame",
    {
      description: "Return bounded line attribution for one file.",
      inputSchema: {
        cwd,
        path: filesystemPath,
        revision,
        maxLines: z.number().int().min(1).max(500).optional(),
        cursor,
        ...response
      }
    },
    async (args, extra) => handleTool("svn_blame", args, extra.signal, () => svnBlame(compactArgs(args)))
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
    async (args, extra) => handleTool("eol_check", args, extra.signal, () => eolCheck(compactArgs(args)))
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
    async (args, extra) => handleTool("svn_propget", args, extra.signal, () => svnPropget(compactArgs(args)))
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
    async (args, extra) => handleTool("svn_precommit", args, extra.signal, () => svnPrecommit(compactArgs(args)))
  );

  server.registerTool(
    "eol_fix_verified",
    {
      description: "Normalize and verify one file's EOL.",
      inputSchema: {
        cwd,
        path: filesystemPath,
        target: z.enum(["crlf", "lf"]).optional(),
        removeBom: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        allowLarge: z.boolean().optional(),
        ...response
      }
    },
    async (args, extra) => handleTool("eol_fix_verified", args, extra.signal, () => eolFixVerified(compactArgs(args)))
  );

  server.registerTool(
    "svn_add",
    {
      description: "Guarded add for explicit paths.",
      inputSchema: { cwd, paths, allowRecursive: z.boolean().optional(), ...response }
    },
    async (args, extra) => handleTool("svn_add", args, extra.signal, () => svnAdd(compactArgs(args)))
  );

  server.registerTool(
    "svn_commit",
    {
      description: "Guarded commit with explicit paths and message.",
      inputSchema: {
        cwd,
        paths,
        message: commitMessage,
        riskAck: z.boolean().optional(),
        allowRoot: z.boolean().optional(),
        ...response
      }
    },
    async (args, extra) => handleTool("svn_commit", args, extra.signal, () => svnCommit(compactArgs(args)))
  );

  server.registerTool(
    "svn_move",
    {
      description: "Guarded working-copy move.",
      inputSchema: { cwd, src: filesystemPath, dest: filesystemPath, ...response }
    },
    async (args, extra) => handleTool("svn_move", args, extra.signal, () => svnMove(compactArgs(args)))
  );

  server.registerTool(
    "svn_rename",
    {
      description: "Alias for guarded working-copy move.",
      inputSchema: { cwd, src: filesystemPath, dest: filesystemPath, ...response }
    },
    async (args, extra) => handleTool("svn_rename", args, extra.signal, () => svnRename(compactArgs(args)))
  );

  server.registerTool(
    "svn_copy",
    {
      description: "Guarded working-copy copy.",
      inputSchema: { cwd, src: filesystemPath, dest: filesystemPath, ...response }
    },
    async (args, extra) => handleTool("svn_copy", args, extra.signal, () => svnCopy(compactArgs(args)))
  );

  server.registerTool(
    "svn_update",
    {
      description: "Guarded update with conflicts postponed.",
      inputSchema: { cwd, paths: optionalPaths, updateAll: z.boolean().optional(), ...response }
    },
    async (args, extra) => handleTool("svn_update", args, extra.signal, () => svnUpdate(compactArgs(args)))
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
    async (args, extra) => handleTool("svn_revert", args, extra.signal, () => svnRevert(compactArgs(args)))
  );

  server.registerTool(
    "svn_delete",
    {
      description: "Preview or schedule guarded deletion of explicit paths.",
      inputSchema: {
        cwd,
        paths,
        allowRecursive: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        riskAck: z.boolean().optional(),
        ...response
      }
    },
    async (args, extra) => handleTool("svn_delete", args, extra.signal, () => svnDelete(compactArgs(args)))
  );

  server.registerTool(
    "svn_resolve",
    {
      description: "Resolve one conflict with an explicit mode.",
      inputSchema: {
        cwd,
        path: filesystemPath,
        accept: z.enum(["working", "mine-full", "theirs-full", "base"]),
        ...response
      }
    },
    async (args, extra) => handleTool("svn_resolve", args, extra.signal, () => svnResolve(compactArgs(args)))
  );

  server.registerTool(
    "svn_resolved",
    {
      description: "Deprecated alias for svn_resolve.",
      inputSchema: {
        cwd,
        path: filesystemPath,
        accept: z.enum(["working", "mine-full", "theirs-full", "base"]),
        ...response
      }
    },
    async (args, extra) => handleTool("svn_resolved", args, extra.signal, () => svnResolved(compactArgs(args)))
  );

  server.registerTool(
    "svn_cleanup",
    {
      description: "Run non-destructive WC cleanup.",
      inputSchema: { cwd, path: filesystemPath.optional(), ...response }
    },
    async (args, extra) => handleTool("svn_cleanup", args, extra.signal, () => svnCleanup(compactArgs(args)))
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
    async (args, extra) => handleTool("svn_propset_eol_style", args, extra.signal, () => svnPropsetEolStyle(compactArgs(args)))
  );

  server.registerTool(
    "svn_propset",
    {
      description: "Guarded property write on explicit paths.",
      inputSchema: {
        cwd,
        paths,
        name: propertyName,
        value: z.string().max(16000).regex(noNul, "must not contain NUL"),
        riskAck: z.boolean().optional(),
        ...response
      }
    },
    async (args, extra) => handleTool("svn_propset", args, extra.signal, () => svnPropset(compactArgs(args)))
  );

  server.registerTool(
    "svn_export",
    {
      description: "Export an explicit SVN source.",
      inputSchema: {
        cwd,
        src: repositoryLocation,
        dest: filesystemPath,
        revision,
        externalDestAck: z.boolean().optional(),
        ...response
      }
    },
    async (args, extra) => handleTool("svn_export", args, extra.signal, () => svnExport(compactArgs(args)))
  );

  server.registerTool(
    "svn_import",
    {
      description: "Import with an explicit source, URL, and message.",
      inputSchema: {
        cwd,
        src: filesystemPath,
        url: repositoryLocation,
        message: commitMessage,
        ...response
      }
    },
    async (args, extra) => handleTool("svn_import", args, extra.signal, () => svnImport(compactArgs(args)))
  );

  return server;
}

export async function handleTool(
  tool: string,
  request: Record<string, unknown>,
  signal: AbortSignal,
  operation: () => Promise<ToolEnvelope>
) {
  try {
    return await withRequestCancellation(signal, async () => publicToolResult(tool, await operation(), request));
  } catch {
    const cwd = typeof request.cwd === "string" ? request.cwd : process.cwd();
    const note = signal.aborted ? "svn request cancelled" : "unexpected MCP tool failure";
    return publicToolResult(tool, failEnvelope(tool, cwd, note), request);
  }
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
  if (!probe.svnversion.ok || !probe.svnadmin.ok) {
    console.error("svn-agent starting with an incomplete SVN toolchain; svnversion or svnadmin is unavailable");
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
