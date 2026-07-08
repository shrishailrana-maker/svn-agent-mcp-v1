# ADR-003: Use Plug-And-Play Global Registration

## Status

Accepted

## Date

2026-07-07

## Context

The MCP may be used on machines with many SVN working copies. Tying the MCP client registration to
a fixed launch `cwd`, or requiring end-user environment variables, creates avoidable setup friction
and causes clients to spend setup time locating tools or reconfiguring per project.

The runtime already bundles SVN and EOL converter binaries, so the remaining friction was
working-copy selection and read-only client configuration.

## Decision

Register the SVN MCP once globally without a project-specific launch `cwd` and without normal-use
environment variables. Tool calls that provide absolute paths infer the nearest SVN working copy
for those paths. Relative paths continue to resolve against explicit per-call `cwd`, or the MCP
process cwd when no `cwd` is provided.

Read-only clients use the `--readonly` launch argument. `SVN_AGENT_*` variables remain only
as development/test escape hatches.

## Consequences

- One MCP registration can serve many SVN repositories on the same machine.
- End users do not need to locate `svn`, `svnadmin`, `dos2unix`, `unix2dos`, or configure PATH.
- Clients should prefer absolute paths for zero-friction multi-repo tool calls.
- Client registration remains static; the MCP does not rewrite client configuration at runtime.
- Relative-path-only workflows still need either a meaningful client process cwd or explicit
  per-call `cwd`.
- `svn_self_check` verifies the local release pointer and bundled runtime; `svn_diagnose` verifies
  read-only working-copy health without adding repo-specific client configuration.
