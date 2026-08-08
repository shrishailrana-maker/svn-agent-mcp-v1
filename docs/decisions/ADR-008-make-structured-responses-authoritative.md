# ADR-008: Make Structured Responses Authoritative

## Status

Accepted

## Date

2026-08-08

## Context

MCP calls previously returned a text summary and the same facts in `structuredContent`. Repeating
field-projection enums inside every tool schema would also consume session context before any tool
ran. Agents normally need a small machine-readable receipt, while raw output and absolute paths
are diagnostic exceptions. Harness or transport failures can also drop both result forms.

## Decision

Make `structuredContent` authoritative and return exactly one bounded text summary in every response
mode except `structured-only`; that mode returns no text block. Keep `humanText` accepted for input
compatibility without changing this bound. Add `structured-only` as an explicit compact spelling and
`receipt` as the smallest contract for status, snapshot, precommit, update, and commit.

Use working-copy-relative paths in compact, receipt, and standard modes. Reserve raw output,
commands, and machine paths for full diagnostics.
Sanitize path-bearing warnings and error diagnostics before returning them outside full mode, and
apply receipt cursors to the bounded changed-path page rather than only reporting continuation.

Validate per-call field projections in the call router before SVN runs. Publish one projection
catalog in the generated API document instead of repeating it in every live tool schema. Keep all
complete internal envelopes and safety stages independent from public shaping.

When both usable text and structured content are absent, classify the result as a harness or
transport drop. Disclose `SVN MCP empty`, preserve explicit path scope, use bounded native `svn`
fallback steps for that operation, and retry or prefer the MCP again after it returns a usable result.
This fallback never bypasses a guard refusal and does not claim internal telemetry.

## Consequences

- Non-`structured-only` modes provide one bounded summary text block, capped at 1,024 characters,
  while `structuredContent` remains the authoritative machine-readable result.
- Receipt-mode status and precommit results stay within explicit character budgets.
- The full live input-schema surface remains smaller than before this feature.
- Clients that only read text content can use the bounded summary in non-`structured-only` modes or
  migrate to `structuredContent`.
- A missing text block and missing structured result is reported as `SVN MCP empty`; clients may use
  the bounded native-SVN fallback while preserving the original scope.
- Projection can skip safe read-only snapshot stages, but never skips commit, conflict, EOL, or
  guard verification.
