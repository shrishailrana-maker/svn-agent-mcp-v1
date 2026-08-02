# svn-agent MCP

Strict SVN Model Context Protocol server for agent-safe status, diff, EOL diagnosis, precommit checks, and guarded SVN mutations.

The implementation contract lives in `docs/SPEC.md`. The current source release is `1.3.0`; each source clone can prepare a local runtime under `releases/v1.3.0`, while npm installations run directly from package-root `dist/`.

Requirements: Node.js 24.18.0 or newer within the Node 24 LTS line, npm 11.16.0 or newer, Git, and access to the public npm registry. Windows uses the
bundled VisualSVN Apache Subversion command-line package and dos2unix payload. On macOS and Linux, `svn`, `svnversion`, `svnadmin`,
`dos2unix`, and `unix2dos` must be available on `PATH`.

## Quick Start

```shell
git clone https://github.com/shrishailrana-maker/svn-agent-mcp-v1.git
cd svn-agent-mcp-v1
npm install
npm run prepare:local
npm test
```

## Agent-Managed Global Install

Give this prompt to Codex, Claude, or another local coding agent:

```text
Install or update the SVN MCP globally with: npm install -g svn-agent-mcp@latest
Verify the package with: npm list -g svn-agent-mcp --depth=0
Resolve the executable with the platform command lookup: where.exe svn-agent-mcp on Windows, or command -v svn-agent-mcp on macOS/Linux.
On macOS/Linux, verify that svn, svnversion, svnadmin, dos2unix, and unix2dos are available on PATH. If any are missing, install Subversion and dos2unix with the host package manager.
Ensure the MCP client entry is named "svn". Use command "svn-agent-mcp" when the client can launch it without a visible window; never use a source checkout, junction, or current pointer. Do not add --readonly.
On Windows, enable the client's hidden/no-window process option. If the npm command shim still opens a console, resolve the global module root with `npm root -g`, then use command "node" with args `["<global-module-root>\\svn-agent-mcp\\dist\\index.js"]`; the server cannot choose its parent process creation flags.
Preserve existing SVN_AGENT_* environment overrides without printing sensitive values, then restart the MCP client.
Query the registry version with: npm view svn-agent-mcp version
After restarting, run svn_self_check and compare its installed version with the registry version. Report the installed version, executable path, runtime layout, and MCP health instead of relying on a remembered version.
```

## Agent Setup From GitHub

Tell an agent:

```text
Get the SVN MCP from https://github.com/shrishailrana-maker/svn-agent-mcp-v1, clone it to a stable absolute path, run npm install, run npm run prepare:local, then configure the MCP command as node <absolute-clone-path>/current/dist/index.js. Use the host platform's native path syntax.
```

The setup commands are:

```shell
git clone https://github.com/shrishailrana-maker/svn-agent-mcp-v1.git
cd svn-agent-mcp-v1
npm install
npm run prepare:local
```

Then configure the MCP client to run:

```text
node <absolute-clone-path>/current/dist/index.js
```

### Claude Desktop Config Example

Add this under `mcpServers`:

```json
{
  "mcpServers": {
    "svn": {
      "command": "node",
      "args": ["<absolute-clone-path>/current/dist/index.js"]
    }
  }
}
```

### Codex Config Example

```toml
[mcp_servers.svn]
command = "node"
args = ["<absolute-clone-path>/current/dist/index.js"]
startup_timeout_sec = 120
```

Restart the MCP client after changing the config.

On Windows, process-window visibility is controlled by the MCP client that spawns the server.
Clients should use a hidden/no-window process option such as Node's `windowsHide:true`. The server
reserves stdout for newline-delimited MCP JSON-RPC and sends startup diagnostics only to stderr.

## Start The MCP

For development from this working copy:

```shell
cd <path-to-svn-agent-mcp-v1>
npm install
npm run prepare:local
node ./current/dist/index.js
```

The source tree includes `bin/` with the Windows VisualSVN Apache Subversion and dos2unix payload. Releases copy that
folder to `current/bin`, so Windows clients do not need separate tool installations. On macOS and
Linux, the server ignores those `.exe` files and resolves the native tools from `PATH`. See
`THIRD_PARTY_NOTICES.md`, `THIRD_PARTY_CHECKSUMS.txt`, and `third_party_licenses/` for bundled
binary notices, hashes, and complete license texts.

## Plug-And-Play Client Config

After `npm install -g svn-agent-mcp@latest`, register the MCP once. Do not set `cwd` or add
environment variables unless an existing installation already needs an explicit override:

Generic client example:

```json
{
  "mcpServers": {
    "svn": {
      "command": "svn-agent-mcp"
    }
  }
}
```

The MCP is not tied to one SVN checkout. If a tool call supplies absolute paths and omits `cwd`, the server finds the nearest SVN working copy for those paths. Relative paths require explicit per-call `cwd`.

Client registration is static: configure the MCP once, and working-copy discovery happens per tool call. The server does not rewrite client configuration at runtime.

Environment variables are not required when the toolchain is bundled or available on `PATH`.
`SVN_MCP_TOOL_PROFILE` controls the advertised schema surface: `full` (default) exposes 25
canonical tools, `docs` exposes the 8-tool edit/commit workflow, and `review` adds bounded diff,
cat, and blame for 11 tools total. Focused profiles reduce tool-definition context without changing
any guard. A call to a hidden tool returns a typed `TOOL_PROFILE` refusal; use `full` when the
workflow needs another operation.
`SVN_MCP_RESPONSE_MODE` selects `compact` (default), `receipt`, `structured-only`, `standard`, or
`full` responses. `structuredContent` is authoritative and `content` is empty by default; pass
`humanText:true` when a client needs a short text receipt. `structured-only` makes that intent
explicit. `receipt` is the smallest stable contract for status, snapshot, precommit, update, and
commit. Use `responseMode:"full"` only when bounded raw SVN diagnostics and machine paths are
needed.
Non-guard failures retain bounded path-sanitized stdout/stderr diagnostics outside full mode;
compact guard refusals return only a typed guard code, one-line reason, and affected-path count.
Other development/test escape hatches are `SVN_AGENT_BIN_DIR`, `SVN_AGENT_SVN_PATH`, `SVN_AGENT_DOS2UNIX_DIR`,
`SVN_AGENT_TIMEOUT_MS`, and `SVN_AGENT_MAX_DIFF_LINES`.

High-volume reads are bounded by default. Log messages and changed paths are capped and opt-in
where appropriate. Diff collection defaults to 200 lines, compact excerpts are capped at 3,000
characters, and compact diff results retain transport headroom below a 32 KiB JSON-RPC record.
`maxChars` and `maxFiles` are upper requests: the response may return less with independent
`nextCursor` and `nextFileCursor` values. Large file/property/status/EOL collections expose
explicit continuation cursors.
Buffered SVN commands fail with a scoped diagnostic above 20 MB. Streamed diff lines are capped at
1 MiB each, and per-file diff summaries are capped at 20,000 entries; either truncation is reported.
Public path arrays accept at most 500 entries, and individual filesystem paths are capped at 4,096
characters.
Compact mode changes response size only; path containment, mutation guards, EOL checks,
mixed-revision checks, and commit verification run unchanged.

Use `svn_diff diffMode:"counts"` for totals only or `"hunk-headings"` for one meaningful line per
file plus omitted-hunk counts. A returned `operationId` binds later cursor pages to the same bounded
process-local evidence, so continuation does not rerun SVN against a changing working copy. Evidence
expires after 10 minutes and is limited to 2 MiB per operation, 32 operations, and 16 MiB total.
`svn_log messageContains` performs a bounded server-side scan; `changedPathsSummary:true` returns
per-revision action counts and top-level directories without listing every path. Large updates can
use `maxItems`, `taskPaths`, and `targetOverlapOnly` to keep unrelated paths out of the receipt while
making complete conflict evidence available through bounded `conflictCursor` pages.
Runner-level line/output truncation is carried into the operation evidence, so a final retained page
cannot be mistaken for the complete source diff.

Normal responses use working-copy-relative paths. High-use tools accept a validated `fields`
array; the allowed names are published once under `globalResponseControls.fieldProjections` in
`docs/MCP_API.json` so the live MCP does not repeat those lists in every tool schema. Invalid
fields are rejected before any SVN process starts. Focused `docs` and `review` profiles advertise
only `compact`, `receipt`, and `structured-only`; known callers may still explicitly request
standard/full diagnostics, but switching to the full profile is clearer for diagnostic work.

High-volume controls are likewise published once under
`globalResponseControls.advancedInputs` in `docs/MCP_API.json`, rather than repeated in every live
tool schema. They include `afterCursor` for status/snapshot polling, diff `file`/`operationId`,
bounded log filtering and summaries, and update paging/overlap controls. Snapshot tokens are opaque,
working-copy and query bound, process-local, and expire after 15 minutes. Repeating the same status
or snapshot with `afterCursor` returns a minimal `NO_CHANGE` receipt; changed or safety-relevant
state returns the current bounded result and a replacement token.
Conflict lists use independent pages of at most 100 paths; `conflictCount`, `conflictsTruncated`, and
`nextConflictCursor` make omitted pages explicit without inflating every status or update response.

`svn_commit` refuses existing directory targets by default because its deliberate `--depth empty`
behavior commits only the directory node and excludes changed descendants. Prefer explicit file
paths. Set `allowDirectoryTargets:true` only when intentionally committing directory properties
or another directory-node-only change; remaining descendants are reported as post-commit residue.
`svn_precommit` accepts the same `allowDirectoryTargets` and `allowRoot` acknowledgements so its
readiness verdict matches those target-scope guards.

Release workflows can pin `svn_update` with an exact `revision`; it still requires explicit paths
or `updateAll:true` and always postpones conflicts. Add `expectedRemoteHead` with a numeric revision
to refuse if repository HEAD moved since the caller's probe. Use
`svn_precommit requireUniformRevision:true` when a release handoff must not proceed from a
mixed-revision working copy. The default remains backward compatible and reports mixed revisions
without blocking ordinary precommit work.

Repositories can make EOL handling automatic for new files:

```json
{
  "normalizeEol": "crlf",
  "eolExclude": ["**/*.patch", "**/*.diff"]
}
```

With this in `.svn-mcp-policy.json`, `svn_add` normalizes and verifies new text files in the same
call, skips binaries and excluded byte-exact fixtures, and refuses before scheduling if verification
fails. `eol_fix_verified` also accepts a bounded explicit `paths` batch for tracked-file repairs.
`svn_diff` and `svn_blame` ignore EOL-only churn by default; use `showEolChanges:true` only for EOL
diagnostics.

## Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Run the TypeScript entry point during development |
| `npm run check:runtime` | Verify the supported Node 24 LTS and minimum npm version |
| `npm run typecheck` | Check TypeScript without emitting build output |
| `npm run build` | Compile `src/` into `dist/` |
| `npm run generate:api-contract` | Generate `docs/MCP_API.json` from the registered MCP tools |
| `npm run check:api-contract` | Fail when the generated MCP API contract is stale |
| `npm test` | Run the Jest test suite |
| `npm run test:package` | Pack, install, and self-check the real npm artifact in isolation |
| `npm run benchmark:responses` | Compare compact MCP, full MCP, and equivalent raw SVN output sizes |
| `npm run check:response-budgets` | Fail when representative compact responses or schemas exceed token budgets |
| `npm run prepare:local` | Build and prepare the local `current` runtime |
| `npm run release:prepare` | Copy `dist/` and `bin/` into `releases/v<version>` and repoint `current` |
| `npm run clean` | Remove root `dist/` with the Node clean script |

## Operator Diagnostics

Use `svn_self_check` to verify the MCP package, runtime layout, resolved native or bundled tools, and release scripts. Use `svn_diagnose` on a working-copy path when SVN itself is acting strange; it checks local status, remote status, HEAD info, latest log reachability, and returns actionable notes for authentication, network, lock, and working-copy database failures.

Use `svn_snapshot` for a one-call status and revision summary. Exact ignored descendants are reported with their covering ignored ancestor instead of disappearing behind SVN's `W155010` warning. `svn_log` and `svn_diff` accept exact or ranged revision selectors; multi-entry log envelopes report an explicit revision range and entry count. Bounded `svn_cat` and `svn_blame` calls support historical file inspection without raw SVN output. Mutations include dry-run-first `svn_delete`, canonical `svn_resolve`, and `svn_path_change` with an explicit `move`, `rename`, or `copy` action. Legacy direct calls to `svn_resolved`, `svn_move`, `svn_rename`, and `svn_copy` remain callable in the full profile for compatibility but are no longer advertised.

For SVN property work, use `svn_propget` and guarded `svn_propset` instead of raw `svn propget`/`svn propset`. `svn_propset_eol_style` remains the safer shortcut for `svn:eol-style` normalization.

## Changelog

Release history is maintained in `CHANGELOG.md`.

## Layout

| Path | Purpose |
| --- | --- |
| `src/` | MCP server implementation |
| `src/parse/` | SVN XML/text parsers |
| `src/tools/` | MCP tool families |
| `tests/` | Unit and temp-repository integration tests |
| `.svn-mcp-policy.json` | Repo-local guard exceptions for this MCP's intentional runtime payloads |
| `bin/` | Versioned Windows SVN and EOL converter runtime binaries |
| `third_party_licenses/` | License and notice texts shipped with the bundled runtime |
| `THIRD_PARTY_NOTICES.md` | Notices for bundled binary payloads |
| `docs/` | Spec, generated MCP API contract, local rules, and decisions |
| `releases/` | Generated versioned runtime release payloads, ignored by Git |

## Usage Model

Register one global MCP server and use explicit paths or per-call `cwd` values when working across SVN checkouts. The server does not assume a product name, project name, or fixed working copy.
