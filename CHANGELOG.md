# Changelog

All notable changes to the SVN MCP are recorded here.

## [1.1.1] - 2026-07-20

### Added

- Added macOS and Linux support through native SVN and dos2unix tools resolved from `PATH`, while
  retaining the bundled Windows toolchain.
- Added Windows, macOS, and Linux CI coverage.
- Added an isolated packed-npm installation smoke test on every CI platform.
- Added an MCP protocol handshake and tool-health check to the packed-install smoke test.
- Added a disposable-repository MCP client smoke test covering guarded read and write workflows.
- Standardized development and CI on Node.js 24.18.0 LTS with npm 11.16.0.
- Added strict, version-pinned npm install-script approvals so new dependency lifecycle scripts fail
  CI until reviewed.

### Fixed

- Fixed `svn_self_check` for global and local npm installations, where the valid runtime lives in
  root `bin/` and `dist/` without a generated `current` junction or `releases/` directory.
- Kept unprepared source checkouts invalid while reporting the active runtime layout explicitly.
- Removed Windows-only `.exe` assumptions from explicit SVN and EOL tool overrides.
- Updated compatible dependencies within the Node 24 LTS line and corrected the release label in
  the bundled binary checksum manifest.
- Protected export, import, and generic property operands from being parsed as SVN options.
- Redacted credentials and sensitive query values from compact mutation receipts.
- Returned working-copy-relative paths in compact diff summaries.
- Normalized compact relative paths to forward slashes across operating systems.
- Hardened self-check against running/package version drift and incomplete runtime payloads.

## [1.1.0] - 2026-07-20

### Added

- Added `compact`, `standard`, and `full` MCP response modes with a compact default and the
  `SVN_MCP_RESPONSE_MODE` server override.
- Added bounded status results, diff continuation, log revision cursors, opt-in log changed paths,
  field projection for info/property reads, failure-oriented EOL output, and compact mutation and
  precommit receipts.
- Added response-size coverage for large status/log/diff payloads and compact safety receipts.
- Added a repeatable live MCP protocol response benchmark backed by a disposable local repository
  and equivalent raw SVN commands.

### Changed

- Successful compact/standard calls no longer duplicate raw SVN stdout when parsed fields already
  represent it; failures keep bounded diagnostics.
- Changed `svn_log` changed-path collection from opt-out to opt-in and reduced the default diff
  excerpt from 800 to 200 lines, with a hard 2,000-line maximum.
- Capped stdout/stderr summaries at 16,000 characters in addition to the existing 200-line cap.
- Bounded opt-in log details, diff file summaries, property reads, conflicts, and precommit failure
  lists with explicit truncation or continuation metadata.
- Compact precommit now distinguishes an evaluated guard refusal from an early diagnostic failure.
- Compact precommit diff totals count only paths with content, binary, or property changes.
- Preserved numeric-looking log authors/messages as strings and named ignored, external, and
  property-only statuses consistently.
- Redacted credential-like URL content in compact log/property values and projected repository URLs.

## [1.0.0] - 2026-07-08

### Changed

- Declared the first public open-source release.
- Bumped the package and MCP server version to `1.0.0`.
- Added the GitHub clone and `npm run prepare:local` setup flow so automation can install the MCP
  from the repository and configure `current\dist\index.js`.

### Packaging

- Generated release payloads remain ignored; publish the source tree, root `bin/` runtime payload,
  and third-party notices, then let each clone prepare its own local `current` runtime.

## [0.1.15] - 2026-07-08

### Added

- Added read-only `svn_propget` for explicit working-copy paths.
- Added guarded `svn_propset` for explicit working-copy paths, with readonly refusal,
  never-commit target checks, bounded property names/values, and `riskAck` for high-risk
  properties such as `svn:ignore`, `svn:global-ignores`, `svn:externals`, and `svn:auto-props`.

### Changed

- Documented generic SVN property operations so callers do not fall back to raw `svn propget` /
  `svn propset` for routine property-only work.

## [0.1.14] - 2026-07-07

### Added

- CLI failsafe mode (SPEC §15.7): if the MCP fails mechanically (server down, protocol-level
  tool errors, broken bundled runtime), callers fall back to scoped raw `svn` CLI for the rest of
  the session under the same policy rules. Guard refusals are explicitly not failsafe triggers
  and must never be bypassed via CLI; read-only instances stay read-only.
- `noteFromRun` now reports executable-launch failures (`ENOENT`/`EACCES`/`EPERM`) as
  "MCP svn runtime unavailable" with the failsafe hint, and `svn_diagnose` includes the failsafe
  suggestion when the bundled SVN toolchain is unavailable.
- Failsafe rules documented in `docs/svnrules.md`.

## [0.1.13] - 2026-07-07

### Fixed

- **Critical:** the server never started when launched through the documented `current`
  junction path — Node resolves the ESM entry module through junctions, so the
  launched-directly check failed and the process exited silently. The check now compares real
  paths; both `current\dist\index.js` and `releases\v<version>\dist\index.js` launches work.
- `svn_update` parsing no longer reports SVN informational trailers ("Updated to revision N.",
  "At revision N.", "Updating '.':", "Restored ...") as phantom changed paths.
- `eol_check` and `svn_precommit` return a structured `kind:"not-a-file"` result for directory
  targets instead of rejecting with a raw filesystem error.
- Streamed stdout/stderr (including the `svn_diff` hot path) now use the same latin1 fallback as
  buffered output for non-UTF8 bytes.
- Working-copy containment now verifies physical paths, so a junction or symlink under a working
  copy cannot redirect tools to files outside it.
- Repository-local policy globs are additionally capped on total wildcard count to bound regex
  backtracking.
- Removed the residual MCP-launch-directory fallback from the read-only working-copy probe.

### Verification

- Deep audit pass over the v0.1.12 baseline: all 27 accepted audit fixes re-verified in
  source; typecheck, build, 52 Jest tests, and `npm audit` green. Live MCP smoke test over
  stdio (initialize, tools/list, readonly banner) through both junction and real release paths.

## [0.1.12] - 2026-07-07

### Fixed

- Fixed all accepted deep-audit items: credential redaction, non-interactive SVN execution,
  stable locale, streaming timeout/stderr caps, latin1 fallback, parser correctness, ignored-path
  precommit guards, secure message files, split recursive reverts, import/export guards, property
  status/conflict parsing, update tree-conflict parsing, policy validation/caching, nullable
  working-copy roots, and ambiguous no-context read-only calls.
- `svn_import` now scans source trees for never-commit descendants before invoking SVN.
- `svn_precommit` and `svn_commit` now treat ignored paths as uncommittable instead of reaching
  later SVN failures.

### Performance

- Batched `eol_check` property lookup, parallelized independent `svn_diagnose` checks, reduced
  repeated `svn_info` process spawns, and replaced synchronous EOL sniffing and recursive
  directory scans in hot paths.

### Documentation

- Updated the spec for the v0.1.12 audit fixes.

## [0.1.11] - 2026-07-07

### Fixed

- Repository-local never-commit `deny` rules now override broad repository-local `allow`
  exceptions.
- Envelope `stdout_summary` and `stderr_summary` now redact URL userinfo and sensitive query
  parameters, not only displayed command strings.

### Documentation

- Updated docs for the v0.1.11 baseline and recorded the audit fixes.

## [0.1.10] - 2026-07-07

### Added

- Added `svn_diagnose`, a read-only working-copy diagnostic tool for local status, remote status, HEAD info, and latest log reachability.
- Added regression coverage for successful temp-repository diagnosis and structured non-working-copy diagnosis.

### Changed

- Expanded SVN error classification for common authentication, network/repository, working-copy lock, and SQLite working-copy database failures.
- Documented the external SVN MCP comparison: borrow diagnostics and error taxonomy ideas, but keep this MCP's bundled runtime, zero end-user env config, explicit-path commits, readonly mode, no-shell execution, and guarded mutating surface.

### Verification

- Added targeted tests for the borrowed diagnostic/error-classification behavior.

## [0.1.9] - 2026-07-07

### Added

- Added repo-local `.svn-mcp-policy.json` support for strict never-commit defaults with explicit per-repository allow/deny exceptions.
- Added streaming diff parsing so `svn_diff` keeps complete per-file counts while capping only `diff_excerpt`.
- Added URL userinfo and sensitive query-parameter redaction for displayed command strings.
- Added `allowLarge` to `eol_fix_verified`; oversized files are refused unless the caller explicitly opts in.

### Changed

- Never-commit generated-folder guards are now segment-aware, blocking nested `bin`, `obj`, `dist`, `node_modules`, `coverage`, `.vs`, and `.cache` folders, including descendants of recursive directory adds.
- `svn_precommit` now treats `svn_diff` failure as a trust-gate verdict: recoverable EOL failures become `EOL_FIX_NEEDED`, other diff failures become `DIFF_FAILED`.
- `eol_fix_verified` now returns structured refusals for missing paths, non-files, binary files, and too-large files.

### Verification

- Added regression coverage for segment-aware guards, policy exceptions, recursive add refusals, redaction, streaming diff counts, precommit diff-failure verdicts, and structured EOL repair refusals.

## [0.1.8] - 2026-07-07

### Added

- `svn_info` now returns parsed `svnversion` details: revision range, local modification flag, switched/partial flags, remote HEAD revision, and stale-base status.
- `svn_status` now accepts `hideNoise:true` to filter common local runtime clutter such as `node_modules`, `dist`, `current`, `.cache`, and `coverage`.
- `svn_status` now accepts `includeIgnored:true` for explicit ignored-path audits without making that the daily default.
- Added `svn_self_check` to report package/runtime version, `current` release pointer, bundled payload counts, startup probe, and packaging-script health.
- Added a Node `scripts/clean.mjs` and changed `npm run clean` to avoid PowerShell filesystem deletion.

### Changed

- `npm run release:prepare` now validates release payload counts before repointing `current`.
- Updated docs to separate MCP-solvable SVN pain points from semantic workflow responsibilities.

### Verification

- Added regression coverage for mixed-revision metadata, status noise filtering, and self-check output.

## [0.1.7] - 2026-07-07

### Added

- `svn_log` now resolves working-copy paths to repository URLs and queries HEAD when possible, avoiding mixed-revision root log gaps.
- `svn_diff` now returns EOL diagnostics and `recovery_tool: "eol_fix_verified"` when SVN reports inconsistent line endings.
- Added `npm run release:prepare`, a Node release packager that copies `dist/` and `bin/` into `releases/v<version>` and repoints `current` without PowerShell copy/junction commands.

### Changed

- Updated the spec and README for repository-URL log behavior, EOL diff recovery, and the release preparation command.

### Verification

- Added temp-repository regression tests for mixed-revision root log history and inconsistent-EOL diff recovery.

## [0.1.6] - 2026-07-07

### Changed

- Expanded never-commit guards to block root generated/dependency/cache artifacts: `dist/**`, `node_modules/**`, `coverage/**`, `.cache/**`, and `*.tsbuildinfo`.
- Tightened `/**` never-commit matching so directory globs do not block unrelated same-prefix files such as `binary.txt`.
- Updated the spec and SVN rules so the executable guard matrix matches the documented generated-output policy.

### Verification

- Added a guard regression test that failed before the change and passed after the guard expansion.

## [0.1.5] - 2026-07-07

### Added

- Plug-and-play global client registration: one MCP config can serve multiple SVN working copies.
- Working-copy inference from absolute path inputs when `cwd` is omitted.
- `--readonly` launch argument for read-only clients.
- Regression coverage for absolute-path multi-working-copy use.

### Changed

- End-user configuration no longer requires environment variables or project-specific launch `cwd`.
- `SVN_AGENT_*` variables are documented as development/test escape hatches only.
- README, spec, and ADR docs now describe zero-env setup and multi-working-copy behavior.

## [0.1.4] - 2026-07-07

### Added

- Versioned source-tree `bin/` folder containing the full SlikSVN `bin` payload and full dos2unix `bin` payload.
- Release `bin/` payload beside `dist/`, including `svn`, `svnadmin`, `svnversion`, `dos2unix`, `unix2dos`, and required DLLs.
- Bundled executable resolution for SVN and EOL tools, with dev/test overrides.

### Changed

- Runtime startup and EOL repair no longer depend on PATH for normal use.
- Tests use bundled SVN binaries for temp-repository setup.

## [0.1.3] - 2026-07-07

### Added

- Guarded `svn_move`, `svn_rename`, and `svn_copy` tools for working-copy paths.
- Parent-directory creation for move/copy destinations.
- Integration coverage for move, rename, copy, readonly refusal, and never-commit destination refusal.

## [0.1.2] - 2026-07-07

### Changed

- EOL repair is fully MCP-owned through `unix2dos`/`dos2unix`.
- `svn_diff` uses `svn diff --internal-diff -x --ignore-eol-style` by default.
- PowerShell EOL hook guidance was removed from the workflow.

## [0.1.1] - 2026-07-07

### Fixed

- `svn_add` now schedules needed parent directories for explicit nested file paths.
- `svn_commit` includes scheduled-added parent directories needed for explicit nested file commits.

## [0.1.0] - 2026-07-07

### Added

- Initial generic SVN MCP implementation.
- Guarded SVN runner, structured envelopes, XML/text parsers, EOL helpers, and guard logic.
- Read-only, composite, and mutating SVN tool families.
- Versioned release layout under `releases/v<version>` with a `current` junction.
