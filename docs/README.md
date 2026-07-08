# Documentation

- `SPEC.md` is the complete implementation contract.
- `svnrules.md` contains the SVN workflow and commit policy the MCP encodes.
- `toolrules.md` contains local command and PowerShell rules.
- `decisions/` contains architecture decision records, including plug-and-play global registration and the external SVN MCP comparison decision.
- `../CHANGELOG.md` records release history.

Current shipped MCP release is `1.0.0`. Run `npm run prepare:local` after cloning to create the
local ignored `current` release pointer, then use `svn_self_check` to verify it and the bundled
runtime. Use `svn_diagnose` for read-only SVN working-copy health checks.
