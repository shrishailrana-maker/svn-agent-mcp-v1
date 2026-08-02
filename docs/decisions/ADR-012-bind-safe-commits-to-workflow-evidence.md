# ADR-012: Bind Safe Commits to Workflow Evidence

## Status

Accepted

## Date

2026-08-02

## Context

Explicit paths, guarded updates, precommit checks, and durable mutation receipts make individual
SVN calls safe, but a multi-client workflow can still change between those calls. A caller may
edit from an old baseline, update across a peer change, or commit files that changed after the
precommit evidence was produced. Repeating status, diff, EOL, update, and snapshot calls also costs
more response tokens than one bounded workflow receipt.

The public tool count must remain stable. Adding separate baseline, safe-commit, and detail tools
would charge every session for rarely used schemas.

## Decision

Use bounded process-local workflow evidence through modes and advanced inputs on existing tools:

- `svn_snapshot captureBaseline:true` captures exact explicit-file state before editing and returns
  an opaque, working-copy-and-path-bound token.
- `svn_update baselineToken` compares the current files with that baseline and reports path-level
  local edits, remote update touches, postponed conflicts, and same-path collisions.
- A READY `svn_precommit` returns a short-lived token bound to exact path status, base revisions,
  content hashes, repository policy, diff identity, and observed remote revision.
- `svn_commit precommitToken` rechecks that binding immediately before mutation while retaining all
  ordinary commit guards.
- `svn_commit operation:"safe"` composes pinned update, collision refusal, EOL repair when needed,
  precommit binding, commit, pinned post-commit update, and a final scoped snapshot under one
  durable operation ID. It accepts a pre-edit baseline or captures current explicit-file state
  internally so the common path remains one call.
- `svn_commit operation:"detail"` pages bounded in-memory stage evidence by opaque ID and cursor.

Baseline and precommit tokens are intentionally process-local and expire. Mutation operation IDs
remain durable and host-local. Tokens are assertions, not permissions: they never bypass path
containment, never-commit rules, conflict postponement, EOL verification, message validation, or
commit risk acknowledgement.

## Alternatives Considered

### Add separate MCP tools

Rejected because three more schemas would increase every full-profile session's context cost. The
existing snapshot, update, precommit, and commit operations already own these lifecycle stages.

### Store full workflow evidence durably

Rejected because diffs and file identities may contain sensitive repository evidence. Only compact
mutation receipts need restart durability. Detailed stage evidence stays bounded in memory and
expires automatically.

### Treat a directory hash as a baseline

Rejected because a directory metadata hash cannot prove which descendant changed. Baselines accept
explicit files only. Callers may first expand a directory scope and then capture those files.

### Automatically rerun a stale safe commit

Rejected. A durable retry replays a completed receipt. An interrupted commit is recovered only when
clean scoped status plus matching post-start history proves the revision; otherwise the operation
fails closed as ambiguous.

## Consequences

- The common guarded commit can be one model round trip with a compact final receipt.
- Same-path clean merges are visible as collisions even when SVN does not create a text conflict.
- A precommit receipt cannot be reused after content, status, policy, scope, or remote state changes.
- Detailed stages remain available without inflating the normal response.
- Tokens cannot be moved between MCP processes or machines; cross-machine coordination remains the
  repository's responsibility.
