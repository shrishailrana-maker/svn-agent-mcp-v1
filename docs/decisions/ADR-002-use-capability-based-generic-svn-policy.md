# ADR-002: Use Capability-Based Generic SVN Policy

## Status

Accepted

## Date

2026-07-07

## Context

The MCP must describe SVN safety in terms of client capabilities instead of deployment-specific
tool names. The same SVN problems occur across many projects, and write-capable or read-only
capabilities can be assigned to different clients in different deployments.

## Decision

Make the MCP specification generic and capability-based. The implementation will refer to
write-capable clients, read-only clients, project working copies, and deployment-provided paths. It will not
hard-code deployment-specific names, hostnames, paths, or product names into behavior or
documentation.

## Consequences

- One MCP can serve multiple SVN projects with the same safety model.
- Read-only safety is enforced by launching that MCP instance with `--readonly`, independent of
  which client is assigned read-only behavior. The legacy/dev `SVN_AGENT_READONLY=1` override remains
  available for tests.
- Project-specific path, hook, auto-props, build, and allowlist examples must remain templates or
  deployment notes.
