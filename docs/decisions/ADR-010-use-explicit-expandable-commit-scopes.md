# ADR-010: Use Explicit Expandable Commit Scopes

## Status

Accepted

## Date

2026-08-02

## Context

Directory targets are convenient but ambiguous in Subversion. The product deliberately commits
with `--depth empty`, so a directory target commits its node and not its changed descendants. Agents
then have to assemble long path arrays by hand. Release preparation also needs a pinned update of
only intended paths; a working-copy-root update can touch unrelated work from concurrent writers.

## Decision

Keep directory-node commits refused by default. Add `expandDescendants:true` to precommit and
commit as an explicit alternative. Expansion includes only current SVN changes under the named
directories, is capped at 500 paths, is physically rechecked for working-copy containment, and
runs every ordinary commit guard against every result. The exact sorted expansion is returned.

Add preparation as `svn_commit operation:"prepare"`. It requires explicit paths and an exact
numeric revision, performs only a conflict-postponing pinned update, optionally verifies the
expected remote HEAD, refuses unexpected touched paths, and then runs precommit. It never commits
and is refused in READONLY mode. Keep `svn_prepare_commit` as an unadvertised compatibility route.
Preparation runs the commit-scope guards before any update. Node-only directory preparation uses
`--depth empty`; expanded directories update recursively and are expanded and guarded again after
the update.

## Alternatives Considered

### Make directory commits recursive by default

Rejected because it silently widens established commit scope and can include unrelated work.

### Update the working-copy root before each commit

Rejected because concurrent working copies can contain unrelated local edits and remote changes.

### Combine preparation and commit immediately

Deferred. A later safe-commit operation may consume these primitives, but preparation remains
independently inspectable and resumable.

## Consequences

- Existing clients retain the current safe directory refusal and node-only acknowledgement.
- Agents can request one bounded directory expansion without manually listing every descendant.
- Release preparation can pin only intended paths and prove the final commit scope.
- No additional schema is advertised; full/docs/review stay at 25/8/11 tools.
