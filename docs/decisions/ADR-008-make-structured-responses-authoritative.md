# ADR-008: Make Structured Responses Authoritative

## Status

Accepted

## Date

2026-08-02

## Context

MCP calls previously returned a text summary and the same facts in `structuredContent`. Repeating
field-projection enums inside every tool schema would also consume session context before any tool
ran. Agents normally need a small machine-readable receipt, while raw output and absolute paths
are diagnostic exceptions.

## Decision

Make `structuredContent` authoritative and leave `content` empty by default. `humanText:true`
explicitly adds a short text receipt. Add `structured-only` as an explicit compact spelling and
`receipt` as the smallest contract for status, snapshot, precommit, update, and commit.

Use working-copy-relative paths in compact, receipt, and standard modes. Reserve raw output,
commands, and machine paths for full diagnostics.
Sanitize path-bearing warnings and error diagnostics before returning them outside full mode, and
apply receipt cursors to the bounded changed-path page rather than only reporting continuation.

Validate per-call field projections in the call router before SVN runs. Publish one projection
catalog in the generated API document instead of repeating it in every live tool schema. Keep all
complete internal envelopes and safety stages independent from public shaping.

## Consequences

- Routine wire payloads no longer pay twice for the same result.
- Receipt-mode status and precommit results stay within explicit character budgets.
- The full live input-schema surface remains smaller than before this feature.
- Clients that only read text content must opt in with `humanText:true` or migrate to
  `structuredContent`.
- Projection can skip safe read-only snapshot stages, but never skips commit, conflict, EOL, or
  guard verification.
