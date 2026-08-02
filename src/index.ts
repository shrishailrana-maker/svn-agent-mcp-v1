#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
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
  svnPathChange,
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
export type ToolProfile = "full" | "docs" | "review";

const docsToolNames = [
  "svn_update", "svn_status", "svn_log", "svn_add", "eol_check", "eol_fix_verified", "svn_precommit", "svn_commit"
] as const;
const reviewToolNames = [...docsToolNames, "svn_diff", "svn_cat", "svn_blame"] as const;
const hiddenLegacyToolNames = new Set(["svn_move", "svn_rename", "svn_copy", "svn_resolved"]);

export function configuredToolProfile(value = process.env.SVN_MCP_TOOL_PROFILE): ToolProfile {
  const normalized = value?.trim().toLowerCase() || "full";
  if (normalized === "full" || normalized === "docs" || normalized === "review") {
    return normalized;
  }
  throw new Error(`invalid SVN_MCP_TOOL_PROFILE=${value}; allowed full, docs, review`);
}

export function toolNamesForProfile(profile: ToolProfile): ReadonlySet<string> | null {
  if (profile === "docs") {
    return new Set(docsToolNames);
  }
  if (profile === "review") {
    return new Set(reviewToolNames);
  }
  return null;
}

function boundedIntegerSchema(name: string, minimum: number, maximum: number, example: number) {
  const message = (value: unknown) =>
    `${name}=${String(value)}; allowed ${minimum}..${maximum}; example ${name}:${example}`;
  return z.number()
    .int({ error: (issue) => message(issue.input) })
    .min(minimum, { error: (issue) => message(issue.input) })
    .max(maximum, { error: (issue) => message(issue.input) });
}

export function createServer(): McpServer {
  const profile = configuredToolProfile();
  const enabledNames = toolNamesForProfile(profile);
  const server = new McpServer({
    name: serverName,
    version: serverVersion
  });
  const profileRegistrations = new Map<string, { config: unknown; callback: unknown }>();
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: unknown, callback: unknown) => {
    profileRegistrations.set(name, { config, callback });
    const tool = register(name, config as never, callback as never);
    const advertised = enabledNames ? enabledNames.has(name) : !hiddenLegacyToolNames.has(name);
    if (!advertised) {
      tool.disable();
    }
    return tool;
  }) as typeof server.registerTool;

  const noNul = /^[^\x00]*$/;
  const filesystemPath = z.string().min(1).max(4096).regex(noNul, "must not contain NUL");
  const repositoryLocation = z.string().min(1).max(8192).regex(noNul, "must not contain NUL");
  const commitMessage = z.string().min(1).max(16000).regex(noNul, "must not contain NUL");
  const cwd = filesystemPath.optional().describe("Absolute WC directory; required for relative paths.");
  const paths = z.array(filesystemPath).min(1).max(500, {
    error: (issue) => `paths count ${Array.isArray(issue.input) ? issue.input.length : "invalid"}; allowed 1..500`
  }).describe("One to 500 explicit paths inside one WC.");
  const optionalPaths = z.array(filesystemPath).max(500, {
    error: (issue) => `paths count ${Array.isArray(issue.input) ? issue.input.length : "invalid"}; allowed 0..500`
  }).optional().describe("Zero to 500 optional paths inside one WC.");
  const allowRootCommit = z.boolean().optional().describe("Acknowledge a working-copy-root commit target.");
  const allowDirectoryTargets = z.boolean().optional().describe(
    "Acknowledge that an existing directory target commits only the directory node; descendants require explicit paths."
  );
  const revision = z.string().max(128).regex(/^(?:\d+|HEAD|BASE|COMMITTED|PREV|\{[^}\r\n\x00]+\})$/i).optional();
  const revisionSelector = z.string().max(257).regex(
    /^(?:\d+|HEAD|BASE|COMMITTED|PREV|\{[^}\r\n\x00]+\})(?::(?:\d+|HEAD|BASE|COMMITTED|PREV|\{[^}\r\n\x00]+\}))?$/i
  ).optional();
  const propertyName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/);
  const responseMode = z.enum(["compact", "standard", "full"]).optional();
  const response = { responseMode };
  const cursor = z.string().max(32).regex(/^\d+$/, "cursor must be a decimal offset with at most 32 digits").optional();
  // svn_log cursors may carry the range floor as "next:floor".
  const logCursor = z.string().max(65).regex(/^\d+(?::\d+)?$/).optional();
  const infoField = z.enum([
    "root", "revision", "url", "repositoryRoot", "mixedRevision", "revisionRange",
    "localModifications", "switched", "partial", "remoteHeadRevision", "staleBase"
  ]);
  const propertyField = z.enum(["path", "name", "value"]);
  const maxItems = boundedIntegerSchema("maxItems", 1, 500, 100).optional();
  const lineLimit = boundedIntegerSchema("lineLimit", 1, 2000, 200).optional();
  const maxChars = boundedIntegerSchema("maxChars", 256, 64000, 3000).optional();
  const maxHunksPerFile = boundedIntegerSchema("maxHunksPerFile", 1, 20, 3).optional();
  const maxFiles = boundedIntegerSchema("maxFiles", 1, 500, 100).optional();
  const logLimit = boundedIntegerSchema("limit", 1, 100, 10).optional();
  const maxMessageChars = boundedIntegerSchema("maxMessageChars", 32, 8000, 240).optional();
  const maxChangedPaths = boundedIntegerSchema("maxChangedPaths", 1, 500, 100).optional();
  const maxLines = boundedIntegerSchema("maxLines", 1, 500, 100).optional();
  const maxValueChars = boundedIntegerSchema("maxValueChars", 256, 64000, 4096).optional();

  server.registerTool(
    "svn_self_check",
    {
      description: "Check package and bundled runtime health.",
      inputSchema: { cwd, detailed: z.boolean().optional(), ...response }
    },
    async (args, extra) => handleTool("svn_self_check", args, extra.signal, async () => ({
      ...await svnSelfCheck(compactArgs(args), serverVersion),
      tool_profile: profile,
      advertised_tool_count: enabledNames?.size ?? 25
    }))
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
        maxItems,
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
        maxItems,
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
        showEolChanges: z.boolean().optional().describe("Include EOL-only changes; default false."),
        lineLimit,
        diffMode: z.enum(["summary", "compact", "full"]).optional(),
        maxChars,
        maxHunksPerFile,
        maxFiles,
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
        limit: logLimit,
        verbose: z.boolean().optional(),
        fullMessage: z.boolean().optional(),
        changedPaths: z.boolean().optional(),
        maxMessageChars,
        maxChangedPaths,
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
        maxChars,
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
        maxLines,
        cursor,
        showEolChanges: z.boolean().optional().describe("Include EOL-only attribution churn; default false."),
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
        maxItems,
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
        maxValueChars,
        countOnly: z.boolean().optional(),
        maxItems,
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
        lineLimit,
        includeDiff: z.boolean().optional(),
        maxChars,
        allowRoot: allowRootCommit,
        allowDirectoryTargets,
        requireUniformRevision: z.boolean().optional().describe(
          "Refuse READY while the working copy spans more than one revision; intended for release handoffs."
        ),
        ...response
      }
    },
    async (args, extra) => handleTool("svn_precommit", args, extra.signal, () => svnPrecommit(compactArgs(args)))
  );

  server.registerTool(
    "eol_fix_verified",
    {
      description: "Normalize and verify one or a bounded batch of explicit files.",
      inputSchema: {
        cwd,
        path: filesystemPath.optional().describe("One explicit file; use either path or paths."),
        paths: paths.optional().describe("One to 500 explicit files; directories are refused."),
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
        allowRoot: allowRootCommit,
        allowDirectoryTargets,
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
    "svn_path_change",
    {
      description: "Move, rename, or copy one working-copy path.",
      inputSchema: {
        cwd,
        action: z.enum(["move", "rename", "copy"]),
        src: filesystemPath,
        dest: filesystemPath,
        ...response
      }
    },
    async (args, extra) => handleTool("svn_path_change", args, extra.signal, () => svnPathChange(compactArgs(args)))
  );

  server.registerTool(
    "svn_update",
    {
      description: "Guarded update with conflicts postponed.",
      inputSchema: {
        cwd,
        paths: optionalPaths,
        updateAll: z.boolean().optional(),
        revision: revision.describe("Exact revision to update to; ranges are refused."),
        expectedRemoteHead: boundedIntegerSchema("expectedRemoteHead", 0, Number.MAX_SAFE_INTEGER, 123).optional().describe(
          "With a numeric revision, refuse before updating unless repository HEAD still equals this revision."
        ),
        ...response
      }
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

  installProfileCallHandler(server, profile, enabledNames, profileRegistrations);
  return server;
}

function installProfileCallHandler(
  server: McpServer,
  profile: ToolProfile,
  enabledNames: ReadonlySet<string> | null,
  registrations: Map<string, { config: unknown; callback: unknown }>
): void {
  server.server.removeRequestHandler("tools/call");
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    if (enabledNames && !enabledNames.has(name)) {
      const note = `tool ${name} is not exposed by the ${profile} profile; set SVN_MCP_TOOL_PROFILE=full`;
      return {
        isError: true,
        content: [{ type: "text", text: `ERROR ${name}: ${note}` }],
        structuredContent: {
          ok: false,
          code: "TOOL_PROFILE",
          tool: name,
          activeProfile: profile,
          note,
          remediation: "use the full profile and restart the MCP client"
        }
      };
    }

    const registration = registrations.get(name);
    if (!registration) {
      throw new McpError(ErrorCode.InvalidParams, `Tool ${name} not found`);
    }
    const config = registration.config as { inputSchema?: z.ZodRawShape };
    const parsed = z.object(config.inputSchema ?? {}).safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
      throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for tool ${name}: ${details}`);
    }
    const callback = registration.callback as (args: Record<string, unknown>, callbackExtra: typeof extra) => Promise<unknown>;
    return await callback(parsed.data, extra) as never;
  });
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
