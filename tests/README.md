# Tests

Use unit tests for guards, parsers, envelopes, and startup probe behavior.

Use throwaway temp SVN repositories for integration tests that mutate SVN state. Never point mutating tests at a real project working copy.

Diagnostic coverage should prove both sides of `svn_diagnose`: healthy temp working copies and
structured failure envelopes for non-working-copy paths or classified SVN errors. Runtime smoke
checks against this MCP working copy must stay read-only.
