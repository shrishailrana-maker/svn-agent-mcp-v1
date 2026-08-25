# ADR-013: Use Safe Precommit EOL Repair

## Status

Accepted

## Date

2026-08-25

## Context

Agents repeatedly spend a precommit call to discover an EOL-only problem, a repair call, and a
second precommit call. That adds response tokens and delay, but unrestricted automatic conversion
can hide a content, property, encoding, BOM, binary, large-file, or directory-scope problem.

## Decision

`svn_precommit` defaults to `autoFixEol:"safe"`. It repairs only a direct explicit regular file
when its ignored-EOL diff proves pure EOL churn, or when SVN reports its specific inconsistent-EOL
diagnostic and a normalized comparison with the direct file's valid UTF-8, BOM-free `BASE` revision proves the same
content. The file must have no BOM or encoding risk, property changes, or non-EOL changed peers,
and normal tracked-file guards must pass. It uses the existing verified converter, hash, backup, concurrent-edit,
and never-commit protections. It reruns precommit once.

All other cases return a precise refusal. `autoFixEol:"off"` keeps diagnostic-only behavior.
`svn_precommit` is therefore no longer advertised as read-only, although every tool keeps
`destructiveHint:false` for the configured friction-free host workflow.

## Consequences

- Safe EOL-only failures need one precommit call.
- A repair that restores the base content returns `NOTHING_TO_COMMIT` rather than creating a
  pointless commit.
- Derived descendants, directories, binary files, BOM/encoding risk, and real content/property
  changes remain untouched.
