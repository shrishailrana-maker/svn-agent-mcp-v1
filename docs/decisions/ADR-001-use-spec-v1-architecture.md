# ADR-001: Use The SPEC v1.0 Architecture

## Status

Accepted

## Date

2026-07-07

## Context

The project needs a new SVN MCP that reduces agent SVN housekeeping, prevents line-ending churn, and exposes guarded SVN operations. The existing plan in `docs/SPEC.md` already captures pain points, rejected alternatives, the process model, tool contracts, guard rules, and phased verification gates.

## Decision

Implement the project from scratch as an ESM TypeScript/Node stdio MCP server following `docs/SPEC.md` version 1.0. Keep the server small and auditable, with process execution isolated in a runner module, structured response envelopes, explicit guard logic, parser modules, and separated read-only/composite/mutating tool families.

## Consequences

- The implementation has one written source of truth.
- Future changes that affect tool behavior should update the spec deliberately.
- Release layout and registration should follow the `releases/v<version>` plus `current` junction convention from the spec.
- This ADR records the initial v1.0 architecture decision; the current spec version may be newer
  and remains authoritative for tool contracts and release status.
