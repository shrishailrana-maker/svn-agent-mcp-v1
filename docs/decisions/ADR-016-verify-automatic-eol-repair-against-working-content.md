# ADR-016: Verify Automatic EOL Repair Against Working Content

## Status

Accepted

## Date

2026-09-13

## Context

The original safe-precommit rule compared normalized working content with SVN `BASE`. That proved
pure EOL churn, but it refused the common case where an explicit text file contained both intended
code edits and accidental mixed line endings. Agents then repeated a manual EOL repair even though
the converter could be verified independently of repository history.

## Decision

For each explicit authorized text file that fails EOL policy, `svn_precommit` snapshots the current
working bytes and hash, converts a temporary copy with `unix2dos` or `dos2unix`, and compares the two
after canonicalizing line endings only. Automatic repair proceeds only when content is identical and
the current BOM, encoding, and final-newline presence are preserved.

For mixed profiles, the staged conversion must also preserve the lone-CR count. This prevents a raw
CR embedded in a string or payload from being treated as a line ending. A genuine CR-only
classic-Mac profile is the narrow exception and is converted through `mac2unix` before the requested
target converter.

Immediately before replacement, the working hash must still match the snapshot. After replacement,
precommit checks the applied hash again, rechecks EOL policy, and reruns the full precommit once. A
concurrent edit is preserved and reported. The normal SVN diff against `BASE` remains visible for
review; it is not used to authorize the converter.

## Alternatives Considered

### Continue comparing with BASE

Rejected because intended content and property changes are unrelated to whether EOL conversion
preserves the current working file.

### Run the converter directly on the working file

Rejected because it cannot prove content, BOM, final-newline, or concurrent-edit preservation before
mutation.

## Consequences

- Mixed EOL plus intended edits normally reaches `READY` in one precommit call.
- Binary, invalid-encoding, oversized, excluded, derived-scope, and undeclared-policy inputs still
  fail closed.
- Compact receipts report repaired files, target EOL, preservation checks, and remaining failures.
- Ambiguous lone CR in a mixed profile fails with `EOL_LONE_CR_CHANGED` and no automatic retry.
- ADR-013's BASE-comparison restriction and ADR-014's BOM-free added-file restriction are superseded.
