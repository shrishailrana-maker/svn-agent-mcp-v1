# ADR-017: Default to the Review Tool Profile

## Status

Accepted. Supersedes ADR-007's full default and profile-based call refusals.

## Date

2026-11-15

## Context

Most agent sessions check, edit, diff against earlier revisions, repair EOL, and commit. Clients
that load every advertised tool definition paid about 33,200 characters for the full 30-tool
surface on every session start, even when most tools were never called.

## Decision

Default `SVN_MCP_TOOL_PROFILE` to `review`. It contains the 9-tool docs workflow, bounded diff,
cat, and blame, plus `svn_info` for revision and HEAD checks and `svn_propset_eol_style` so
recurring EOL failures can be fixed at the property level. `full` and `docs` stay available by
explicit setting. A profile selects the startup tool list to save tokens; it never restricts
which tools a client can call. All SVN guards and host approval settings remain in effect.

## Consequences

- The default tool list drops to about 13,900 characters.
- `svn_help` with `tool:"tools"` lists all canonical names and shows which are already advertised.
  This lookup leaves the list unchanged and returns no schemas.
- `svn_help` with a tool name outside the starting list returns its description and input schema,
  publishes only that tool for the current session, and sends `notifications/tools/list_changed`
  so clients can refresh. A fresh connection starts with the configured profile again.
- Clients that support calls by name can use any registered tool directly. Legacy aliases remain
  callable for compatibility but stay out of discovery. Hosts with fixed tool lists can use `full`.
