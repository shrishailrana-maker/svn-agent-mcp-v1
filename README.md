# svn-agent MCP

Strict SVN Model Context Protocol server for agent-safe status, diff, EOL diagnosis, precommit checks, and guarded SVN mutations.

The implementation contract lives in `docs/SPEC.md`. Version `1.0.0` is the first public open-source release and can prepare a self-contained local runtime bundle under `releases/v1.0.0`.

Requirements: Windows, Node.js 20 or newer, Git, and access to the public npm registry. The bundled
SlikSVN and dos2unix runtime payload is Windows-only.

## Quick Start

```powershell
git clone https://github.com/shrishailrana-maker/svn-agent-mcp-v1.git
cd svn-agent-mcp-v1
npm install
npm run prepare:local
npm test
```

## Agent Setup From GitHub

Tell an agent:

```text
Get the SVN MCP from https://github.com/shrishailrana-maker/svn-agent-mcp-v1, clone it to C:\MCP\svn-agent-mcp-v1, run npm install, run npm run prepare:local, then configure the MCP command as node C:\MCP\svn-agent-mcp-v1\current\dist\index.js.
```

The setup commands are:

```powershell
git clone https://github.com/shrishailrana-maker/svn-agent-mcp-v1.git C:\MCP\svn-agent-mcp-v1
cd C:\MCP\svn-agent-mcp-v1
npm install
npm run prepare:local
```

Then configure the MCP client to run:

```text
node C:\MCP\svn-agent-mcp-v1\current\dist\index.js
```

### Claude Desktop Config Example

Add this under `mcpServers`:

```json
{
  "mcpServers": {
    "svn": {
      "command": "node",
      "args": ["C:\\MCP\\svn-agent-mcp-v1\\current\\dist\\index.js"]
    }
  }
}
```

### Codex Config Example

```toml
[mcp_servers.svn]
command = "node"
args = ["C:\\MCP\\svn-agent-mcp-v1\\current\\dist\\index.js"]
startup_timeout_sec = 120
```

Restart the MCP client after changing the config.

## Start The MCP

For development from this working copy:

```powershell
cd <path-to-svn-agent-mcp-v1>
npm install
npm run prepare:local
node .\current\dist\index.js
```

The source tree includes `bin/` with the full SlikSVN `bin` payload plus the full dos2unix `bin` payload. Releases copy that folder to `current/bin`, so normal Windows clients do not need to locate or install `svn`, `svnversion`, `svnadmin`, `dos2unix`, `unix2dos`, or their required DLLs. See `THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_CHECKSUMS.txt` for bundled binary notices and SHA256 hashes.

## Plug-And-Play Client Config

Register the MCP once globally. Do not set `cwd` and do not set environment variables:

Generic client example:

```json
{
  "mcpServers": {
    "svn": {
      "command": "node",
      "args": ["C:\\MCP\\svn-agent-mcp-v1\\current\\dist\\index.js"]
    }
  }
}
```

The MCP is not tied to one SVN checkout. If a tool call supplies absolute paths and omits `cwd`, the server finds the nearest SVN working copy for those paths. Relative paths require explicit per-call `cwd`.

Client registration is static: configure the MCP once, and working-copy discovery happens per tool call. The server does not rewrite client configuration at runtime.

Environment variables are not required for normal use. They are development/test escape hatches only: `SVN_AGENT_BIN_DIR`, `SVN_AGENT_SVN_PATH`, `SVN_AGENT_DOS2UNIX_DIR`, `SVN_AGENT_TIMEOUT_MS`, and `SVN_AGENT_MAX_DIFF_LINES`.

## Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Run the TypeScript entry point during development |
| `npm run typecheck` | Check TypeScript without emitting build output |
| `npm run build` | Compile `src/` into `dist/` |
| `npm test` | Run the Jest test suite |
| `npm run prepare:local` | Build and prepare the local `current` runtime |
| `npm run release:prepare` | Copy `dist/` and `bin/` into `releases/v<version>` and repoint `current` |
| `npm run clean` | Remove root `dist/` with the Node clean script |

## Operator Diagnostics

Use `svn_self_check` to verify the MCP package, `current` release pointer, bundled binaries, and release scripts. Use `svn_diagnose` on a working-copy path when SVN itself is acting strange; it checks local status, remote status, HEAD info, latest log reachability, and returns actionable notes for authentication, network, lock, and working-copy database failures.

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
