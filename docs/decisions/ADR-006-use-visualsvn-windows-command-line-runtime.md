# ADR-006: Use the VisualSVN Windows Command-Line Runtime

## Status

Accepted

## Date

2026-07-20

## Context

Windows users need a self-contained Subversion client because the global MCP registration should
not depend on a separately installed `svn` command. The previous SlikSVN payload bundled OpenSSL
3.0.16 DLLs. That patch level was no longer current, while SlikSVN had no newer public build.

Replacing individual cryptographic DLLs would combine binaries from different builds without an
upstream compatibility guarantee. Removing the Windows runtime entirely would also break the
project's plug-and-play installation decision.

## Decision

Bundle VisualSVN's standalone Apache Subversion command-line archive for Windows. VisualSVN
publishes this archive as a lightweight redistributable package. The selected build contains
Apache Subversion 1.14.5, was compiled in June 2026, and does not ship separate OpenSSL runtime
DLLs.

Retain the archive SHA256, every bundled file's SHA256, the archive's complete license directory,
and the Apache Subversion notice in the source and npm package. Keep dos2unix 7.5.6 as the EOL
converter payload under its own reproduced license.

Embed the standard Windows UTF-8 active-code-page application manifest in `svn.exe`. The selected
upstream executable otherwise converts non-ASCII argv through the system ANSI code page, which can
turn Greek and CJK working-copy paths into question marks. Keep the source manifest and maintenance
script in `scripts/`, record the modification in third-party notices, and checksum the resulting
distributed executable.

macOS and Linux continue to resolve package-managed Subversion and dos2unix commands from `PATH`.

## Consequences

- Windows remains self-contained without carrying the obsolete SlikSVN OpenSSL DLLs.
- Runtime provenance and redistribution terms are auditable from the repository and npm package.
- A future binary refresh must replace the complete upstream archive payload, regenerate checksums,
  reapply the UTF-8 manifest, rerun the Unicode/client/package smoke tests, and update checksums,
  the archive hash, and notices.
- Individual DLL substitution remains prohibited because it would create an unsupported mixed
  runtime.
