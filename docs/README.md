# Documentation

- `SPEC.md` is the complete implementation contract.
- `MCP_API.json` is generated from the registered MCP tool schemas and shipped with npm.
- `svnrules.md` contains the SVN workflow and commit policy the MCP encodes.
- `toolrules.md` contains local command and PowerShell rules.
- `decisions/` contains architecture decision records, including plug-and-play global registration,
  compact MCP responses, authoritative structured receipts, bounded tool profiles, the bundled
  Windows runtime, and the external SVN MCP comparison decision.
- `../CHANGELOG.md` records release history.

The current source release is `1.3.0`; query `npm view svn-agent-mcp version` for the registry
release. Release history is recorded in `../CHANGELOG.md`.
Run `npm run prepare:local` after cloning to create the
local ignored `current` release pointer, then use `svn_self_check` to verify it and the bundled
runtime. Global npm installations use package-root `dist/` and `bin/` directly and do not require
`current`; self-check marks the pointer as not applicable for that layout. Windows uses the bundled VisualSVN Apache Subversion and dos2unix toolchain; macOS and Linux resolve native SVN and dos2unix
commands from `PATH`. Use `svn_diagnose` for read-only SVN working-copy health checks.
