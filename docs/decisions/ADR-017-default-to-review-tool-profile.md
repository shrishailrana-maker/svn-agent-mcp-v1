# ADR-017: Default to the Review Tool Profile

## Status

Accepted. Supersedes the "full remains the default" part of ADR-007.

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
explicit setting. Profiles remain a context optimization, not a security policy; every guard is
unchanged.

## Consequences

- The default tool list drops to about 13,900 characters.
- Calls to tools outside `review` (for example `svn_revert`, `svn_delete`, locks, other properties)
  return a typed `TOOL_PROFILE` refusal until the client sets `SVN_MCP_TOOL_PROFILE=full` and
  restarts.
- Legacy aliases are callable only under `full`.
