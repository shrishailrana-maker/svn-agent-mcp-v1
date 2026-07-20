# svn-agent MCP

Strict SVN Model Context Protocol server for agent-safe status, diff, EOL diagnosis, precommit checks, and guarded SVN mutations.

The implementation contract lives in `docs/SPEC.md`. The current release is `1.1.1`; each source clone can prepare a local runtime under `releases/v1.1.1`, while npm installations run directly from package-root `dist/`.

Requirements: Node.js 24.18.0 or newer within the Node 24 LTS line, npm 11.16.0 or newer within the npm 11 line, Git, and access to the public npm registry. Windows uses the
bundled SlikSVN and dos2unix payload. On macOS and Linux, `svn`, `svnversion`, `svnadmin`,
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
Ensure the MCP client entry is named "svn" and uses command "svn-agent-mcp", never a source checkout, junction, current pointer, or dist path. Do not add --readonly.
Preserve existing SVN_AGENT_* environment overrides without printing sensitive values, then restart the MCP client.
After restarting, run svn_self_check and report the installed version, executable path, runtime layout, and MCP health. Expected latest for this release is 1.1.1; if npm reports a newer version, report the installed version instead of forcing a downgrade.
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

## Start The MCP

For development from this working copy:

```shell
cd <path-to-svn-agent-mcp-v1>
npm install
npm run prepare:local
node ./current/dist/index.js
```

The source tree includes `bin/` with the Windows SlikSVN and dos2unix payload. Releases copy that
folder to `current/bin`, so Windows clients do not need separate tool installations. On macOS and
Linux, the server ignores those `.exe` files and resolves the native tools from `PATH`. See
`THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_CHECKSUMS.txt` for bundled binary notices and hashes.

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
`SVN_MCP_RESPONSE_MODE` selects `compact`
(default), `standard`, or `full` responses. Compact mode returns bounded structured results and
short text receipts; use `responseMode: "full"` on a call when bounded raw SVN diagnostics are needed.
Errors retain bounded stdout/stderr diagnostics in every mode. Other development/test escape
hatches are `SVN_AGENT_BIN_DIR`, `SVN_AGENT_SVN_PATH`, `SVN_AGENT_DOS2UNIX_DIR`,
`SVN_AGENT_TIMEOUT_MS`, and `SVN_AGENT_MAX_DIFF_LINES`.

High-volume reads are bounded by default. Log messages and changed paths are capped and opt-in
where appropriate. Diff collection defaults to 200 lines, compact excerpts are capped at 3,000
characters, and large file/property/status/EOL collections expose explicit continuation cursors.
Compact mode changes response size only; path containment, mutation guards, EOL checks,
mixed-revision checks, and commit verification run unchanged.

## Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Run the TypeScript entry point during development |
| `npm run check:runtime` | Verify the supported Node 24 LTS and npm 11 toolchain |
| `npm run typecheck` | Check TypeScript without emitting build output |
| `npm run build` | Compile `src/` into `dist/` |
| `npm test` | Run the Jest test suite |
| `npm run test:package` | Pack, install, and self-check the real npm artifact in isolation |
| `npm run benchmark:responses` | Compare compact MCP, full MCP, and equivalent raw SVN output sizes |
| `npm run prepare:local` | Build and prepare the local `current` runtime |
| `npm run release:prepare` | Copy `dist/` and `bin/` into `releases/v<version>` and repoint `current` |
| `npm run clean` | Remove root `dist/` with the Node clean script |

## Operator Diagnostics

Use `svn_self_check` to verify the MCP package, runtime layout, resolved native or bundled tools, and release scripts. Use `svn_diagnose` on a working-copy path when SVN itself is acting strange; it checks local status, remote status, HEAD info, latest log reachability, and returns actionable notes for authentication, network, lock, and working-copy database failures.

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
| `THIRD_PARTY_NOTICES.md` | Notices for bundled binary payloads |
| `docs/` | Spec, local rules, and decisions |
| `releases/` | Generated versioned runtime release payloads, ignored by Git |

## Usage Model

Register one global MCP server and use explicit paths or per-call `cwd` values when working across SVN checkouts. The server does not assume a product name, project name, or fixed working copy.
