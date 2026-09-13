# ADR-014: Normalize Added Text During Safe Precommit

## Status

Superseded in part by ADR-016

## Date

2026-08-27

## Context

ADR-013 permits safe automatic EOL repair only after proving that existing working content matches
repository `BASE` when line endings are ignored. Newly added files have no `BASE`, so a common
documentation commit required a refusal plus separate check, repair, diff, and precommit calls.
Those round trips consumed agent tokens without adding safety when the file was explicit, text, and
already had a declared EOL target.

## Decision

Keep the existing `autoFixEol:"safe"` interface. Do not add another public policy parameter.

For an explicit status-`A` regular file, safe precommit may normalize EOL when all of these hold:

- `svn:eol-style` or `.svn-mcp-policy.json normalizeEol` declares `crlf` or `lf`;
- the file is valid UTF-8 text, has no BOM, is within the normal size limit, and is not excluded;
- normalized content before and after conversion is identical;
- the staged converter and concurrent-edit protections from ADR-013 succeed.

An explicit `svn:eol-style` is authoritative; repository policy is a fallback only when the
property is absent. The implementation never infers policy from neighboring files. Missing policy
fails closed with a short typed refusal. After repair, precommit revalidates once and issues its
normal exact-state token. That token records EOL evidence so commit can report
`passed-via-precommit`; a repair performed in the workflow reports `auto_fixed`.
The selected target is re-read after conversion. A concurrent property or repository-policy change
rolls the converted bytes back only while their guarded hash still matches and returns the rollback
outcome instead of issuing a token.

## Alternatives Considered

### Require explicit `eol_fix_verified`

Rejected because it repeats evidence already available inside precommit and turns a normal added
text file into a multi-call recovery workflow.

### Add `newTextFilePolicy:"infer-and-normalize"`

Rejected because it makes the public interface shallower and encourages ambiguous inference. The
existing safe mode can hide this implementation detail behind one interface.

### Infer from nearby files with the same extension

Rejected because neighboring files can have mixed or intentional policies, and scanning them adds
I/O and response uncertainty.

## Consequences

- A declared-policy added text file normally needs only add, precommit, and commit.
- Binary, BOM-bearing, invalid-encoding, excluded, directory, oversized, or undeclared-policy
  inputs remain untouched.
- Compact responses stay small; detailed diffs remain opt-in.
