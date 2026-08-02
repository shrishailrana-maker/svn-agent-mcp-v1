# ADR-007: Use Focused Tool Profiles

## Status

Accepted

## Date

2026-08-02

## Context

MCP clients can load every advertised tool definition into model context. The full SVN surface is
useful for administration and recovery, but documentation and review sessions repeatedly use a
small subset. Four public schemas also represented aliases for behavior already available through
canonical operations.

Removing tools would break existing configured clients. Treating a profile as authorization would
also duplicate and weaken the established READONLY and mutation-guard boundaries.

## Decision

Add `SVN_MCP_TOOL_PROFILE=full|docs|review`. Full remains the default and advertises 25 canonical
tools. Docs advertises the eight-tool update, status, log, add, EOL, precommit, and commit workflow.
Review adds bounded diff, cat, and blame for 11 tools total.

Focused profiles return a typed `TOOL_PROFILE` refusal for hidden calls. They never bypass or
replace READONLY, containment, EOL, conflict, mixed-revision, or commit guards.

Advertise one `svn_path_change` operation with an explicit move, rename, or copy action. Keep
`svn_move`, `svn_rename`, `svn_copy`, and `svn_resolved` callable in full mode for compatibility,
but omit those aliases from discovery.

## Consequences

- Docs sessions load about 66% fewer tool-definition characters than the former full surface;
  review sessions load about 52% fewer.
- Existing direct legacy calls continue working in the default full profile.
- Clients that need a hidden operation while using a focused profile must switch to full and
  restart the MCP process.
- Tool profiles remain a context optimization, not a security policy.
