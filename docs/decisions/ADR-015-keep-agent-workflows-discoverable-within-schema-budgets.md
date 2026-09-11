# ADR-015: Keep Agent Workflows Discoverable Within Schema Budgets

## Status

Accepted

## Date

2026-09-11

## Context

Several useful workflow controls were implemented and accepted by the server but were intentionally
omitted from focused tool schemas to reduce token use. Agents therefore repeated manual EOL, diff,
and update calls because they could not easily discover the shorter workflow.

Advertising every advanced input without profile trimming increased the selected schema from 5,494
to 6,369 characters and the docs profile from 7,000 to 10,603 characters. The final design exposes
the complete interface in `full` while removing advanced fields from focused profiles.

## Decision

Keep the bounded schemas and make normal behavior discoverable at five smaller seams:

- concise tool descriptions state defaults and the preferred normal workflow;
- exceptional results return a copy-ready `nextAction` with all advanced arguments;
- workflow prompts explain multi-step and multi-writer use when deeper guidance is requested.
- a read-only `svn_help(tool)` is advertised in every profile and loads extended rules on demand;
  its one small schema moves detailed contracts off the always-loaded tool definitions.
- the full profile advertises every runtime-supported advanced input; a shared capability registry
  drives full schemas, validation metadata, and generated help lists so they cannot drift.

Tests assert that the important defaults remain present in advertised descriptions. Response-budget
checks continue to cap both tool definitions and normal receipts.

## Consequences

- Agents learn that precommit fixes safe added-file EOL cases without first failing manually.
- A truncated precommit diff gives the exact `svn_diff` continuation call.
- Multi-writer and safe-commit workflows are named where agents select tools.
- The full profile pays about 2,800 input-schema characters to expose all runtime controls.
- Focused profiles avoid that full-interface cost.
- Focused profiles advertise one extra tool and about 250 extra input-schema characters so agents
  can request exact rules without loading every advanced contract.
