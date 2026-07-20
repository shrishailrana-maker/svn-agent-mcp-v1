# ADR-005: Use Bounded Public Response Modes

## Status

Accepted.

## Context

SVN XML and unified diffs can be much larger than the structured facts agents need. Returning raw
stdout beside parsed fields duplicated successful results and consumed avoidable MCP context. The
internal envelopes are also used by composite and mutation checks, so removing data inside tool
implementations would risk weakening safety behavior.

## Decision

Keep complete internal tool envelopes and shape only the public MCP result. Compact mode is the
default, standard mode keeps parsed envelopes without successful raw stdout, and full mode retains
the legacy bounded diagnostic shape. High-volume lists, property values, log details, and excerpts
are bounded and return explicit continuation or truncation markers. Failures keep bounded raw
diagnostics in every mode.

## Consequences

- Routine calls use substantially less response context.
- Safety checks see the same complete internal data in every response mode.
- Compact output never reports a safety check as passed when that check did not run.
- Clients that parse the legacy default shape must request `responseMode: "full"` or set
  `SVN_MCP_RESPONSE_MODE=full` while migrating.
- Tool schemas grow slightly because response and pagination controls are explicit.
