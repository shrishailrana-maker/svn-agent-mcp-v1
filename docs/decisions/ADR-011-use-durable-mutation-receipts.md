# ADR-011: Use Durable Mutation Receipts

## Status

Accepted

## Date

2026-08-02

## Context

An MCP client can time out or disconnect after a mutation reaches Subversion but before its response
arrives. Blindly retrying update, commit, EOL repair, or conflict resolution can repeat work or hide
an ambiguous outcome. Process-local evidence does not survive an MCP restart.

## Decision

Accept an optional UUID `operationId` on update, commit/prepare, EOL repair, and conflict resolution.
Bind it to a stable fingerprint of normalized inputs and keep a bounded durable receipt outside the
working copy. An identical completed or failed request replays its stored compact result. Concurrent
reuse reports `OPERATION_IN_PROGRESS`; reuse with different inputs reports `OPERATION_ID_CONFLICT`.

Unfinished receipts are never removed automatically. After a bounded stale interval, ordinary
mutations report an ambiguous `OPERATION_STALE` result instead of executing again. Commit may recover
only when scoped status is clean and every explicit path has matching post-start SVN history at one
revision. Unreadable or incomplete receipts fail closed.

The store is machine-local and is not a distributed lock. Operators may relocate it with
`SVN_MCP_OPERATION_DIR`; records are mode-restricted, atomically replaced, size bounded, and contain
compact redacted results rather than raw SVN output. Receipt-file locks cover only synchronous local
file replacement; abandoned locks are reclaimed after a bounded interval and live contention fails
as a typed store error. The physical store location is rejected inside any SVN working copy.
Terminal receipts and stale orphan files are pruned to fixed age, count, and byte limits. Unfinished,
unreadable, and fresh orphan records are retained, and new operations are refused if those protected
records consume store capacity.

## Alternatives Considered

### Keep receipts in process memory

Rejected because a restart loses the evidence precisely when a retry is most likely.

### Automatically retry every stale operation

Rejected because most SVN mutations cannot prove whether the first execution completed.

### Store receipts in each working copy

Rejected because local metadata could appear in status, be committed accidentally, or weaken path
separation between repositories.

## Consequences

- Clients can safely retry an identical operation after transport loss or process restart.
- A caller must use a new operation ID after intentionally changing any bound input.
- Multi-machine coordination still relies on SVN revisions, expected-HEAD checks, and conflict
  handling; local receipts do not coordinate separate hosts.
- Unfinished ambiguous records require inspection or a new deliberate operation rather than an
  automatic duplicate mutation.
