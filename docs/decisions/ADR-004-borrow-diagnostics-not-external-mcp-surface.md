# ADR-004: Borrow Diagnostics, Not External SVN MCP Semantics

## Status

Accepted

## Date

2026-07-07

## Context

Existing public SVN MCP projects contain useful operator ideas: health checks, command
diagnostics, and clearer categorization for common SVN errors. Some also expose behavior that
conflicts with this MCP's purpose: PATH-based setup, end-user environment variables for
credentials and working directory, permissive force/update options, optional broad commit scope,
shell/string command execution, and plain-text-oriented responses.

This MCP is meant to be plug-and-play, multi-working-copy, bundled, no-shell, explicit-path,
guarded, and safe for separate write-capable and read-only clients.

## Decision

Use external SVN MCPs as reference material only. Borrow read-only diagnostics, error taxonomy,
and documentation lessons when they fit the guard model. Do not fork or import mutating semantics,
credential configuration, launch configuration, or shell execution patterns that increase setup
friction or weaken commit/update safety.

The v0.1.10 implementation applies this by adding `svn_diagnose` and expanding SVN error
classification while preserving bundled runtime binaries, zero normal-use environment variables,
explicit-path commits, readonly mode, and structured envelopes.

## Consequences

- Future comparisons should produce a small "borrow/reject" list, not a rewrite.
- Diagnostics may improve without expanding the mutating surface.
- End users still configure the MCP once globally and do not set SVN credential env vars.
- The MCP remains opinionated about safety even when generic SVN tools expose more permissive
  flags.
