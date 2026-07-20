# ADR-003: Use Plug-And-Play Global Registration

## Status

Accepted

## Date

2026-07-07

## Context

The MCP may be used on machines with many SVN working copies. Tying the MCP client registration to
a fixed launch `cwd`, or requiring end-user environment variables, creates avoidable setup friction
and causes clients to spend setup time locating tools or reconfiguring per project.

The Windows runtime bundles SVN and EOL converter binaries. Other supported platforms resolve
their native tools from `PATH`, so the remaining friction was working-copy selection and
read-only client configuration.

## Decision

Register the SVN MCP once globally without a project-specific launch `cwd` and without normal-use
environment variables. Tool calls that provide absolute paths infer the nearest SVN working copy
for those paths. Relative paths continue to resolve against explicit per-call `cwd`, or the MCP
process cwd when no `cwd` is provided.

Read-only clients use the `--readonly` launch argument. `SVN_AGENT_*` variables remain only
as development/test escape hatches.

## Consequences

- One MCP registration can serve many SVN repositories on the same machine.
- Windows users do not need separate SVN or EOL converter installations.
- macOS and Linux users install the native SVN and dos2unix packages once; the MCP resolves them
  from `PATH` without per-client path configuration.
- Clients should prefer absolute paths for zero-friction multi-repo tool calls.
- Client registration remains static; the MCP does not rewrite client configuration at runtime.
- Relative-path-only workflows still need either a meaningful client process cwd or explicit
  per-call `cwd`.
- `svn_self_check` verifies the runtime layout and resolved toolchain; `svn_diagnose` verifies
  read-only working-copy health without adding repo-specific client configuration.
