# ADR-009: Use Bounded Process-Local Evidence

## Status

Accepted.

## Context

Large status, diff, log, and update results must be paged to control agent token usage. Rerunning SVN
for every page can return inconsistent evidence when another process edits or updates the working
copy between requests. Persisting repository content to disk would add cleanup, privacy, and path
scope risks.

## Decision

Keep continuation evidence in MCP process memory behind opaque identifiers.

- Status and snapshot use query- and working-copy-bound tokens with a 15-minute lifetime and a
  maximum of 512 live tokens. An unchanged query returns a minimal `NO_CHANGE` receipt.
- Diff stores at most 2 MiB per operation for 10 minutes, with at most 32 operations and 16 MiB
  total. Operation IDs are bound to the tool kind and normalized request scope.
- Invalid, expired, wrong-kind, and wrong-scope identifiers return typed errors.
- A process restart intentionally invalidates all identifiers. Nothing is written to the working
  copy, temporary files, or user profile.
- Full detail remains bounded. Truncation and unavailable omitted detail are explicit.
- Status, snapshot, and update conflict evidence uses independent 100-item cursor pages; total count
  and truncation are always explicit.

## Consequences

Continuation pages are stable and substantially smaller than rerunning full SVN commands. The
server has deterministic memory limits and no evidence-file lifecycle. Clients must restart a read
after expiry or server restart, and strict-schema clients must use the generated advanced-input
catalog because these uncommon controls are not repeated in every live tool schema.
