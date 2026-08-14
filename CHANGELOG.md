# Changelog

All notable changes to the SVN MCP are recorded here.

## [Unreleased]

### Fixed

- Streamed `svn_cat` pages so large text files are bounded before the child-process buffer
  limit, while preserving character cursors and binary detection.
- Streamed `svn_blame` XML entries so bounded line pages do not require retaining the full
  blame document in memory.

## [1.6.0] - 2026-08-08

### Fixed

- Fixed path-scoped `svn_info` remote-head evidence and kept root-scoped behavior unchanged (#48).
- Fixed standard EOL responses so successful and refused `eol_check` and `eol_fix_verified` calls
  retain a bounded outcome and next action (#49).
- Distinguished out-of-date paths from valid mixed-revision working copies in guarded commit
  diagnostics without weakening the refusal (#50).
- Fixed scoped update evidence for newly added companion files, pinned revisions, missing versioned
  files, incomplete exact-file scopes, and unclassifiable target metadata (#51).
- Clarified that `postStatusClean` covers only the committed path scope, not the full working copy
  (#52).
- Documented the empty-reply disclosure and bounded native-SVN fallback for harness failures (#53).
- Exposed the exact commit-message contract in `svn_commit` and `svn_import` descriptions (#54).
- Exposed the `svn_commit` path threshold and `riskAck:true` requirement for more than 8 paths (#55).
- Documented `workingCopyMixed`, nullable `baseRevision`, and `baseRevisionRange` for parallel
  working-copy updates (#56).
- Documented the verified `eol_check` → `eol_fix_verified` → `svn_diff(ignoreEol:true)` recovery
  workflow, including LF and BOM evidence (#57).

### Changed

- Bumped the package and lockfile version to 1.6.0. The full profile remains at 29 canonical tools
  and all registered tools continue to advertise `destructiveHint:false`.
- Rebased tool-definition budget guardrails around the published 1.6.0 descriptions while keeping
  roughly five percent growth headroom.
- Pinned the patched `js-yaml` 3.x legacy line for the Jest toolchain advisory.

## [1.5.0] - 2026-08-04

### Added

- Added guarded `svn_lock`, `svn_unlock`, and read-only `svn_lock_status` tools for same-user
  multi-working-copy workflows. Lock comments include a validated workstation label, durable
  operation receipts bind normalized paths and force state, and lock tokens never enter public
  responses.
- Added guarded `svn_needs_lock` for explicit regular versioned files. Setting uses `*`; removal
  requires `riskAck:true`.
- Added lock diagnostics for held-elsewhere, orphaned-token, and seven-day stale-candidate states.
- Added explicit `destructiveHint:false` annotations to every registered tool and accurate central
  read-only annotations. Host Codex approval configuration remains outside the npm package.

### Changed

- Bumped the package, lockfile, and generated MCP contract to 1.5.0. The full profile now exposes
  29 canonical tools; focused docs/review profiles remain unchanged.

### Fixed

- Updated transitive dependency overrides for `brace-expansion`, `fast-uri`, `hono`, and
  `ip-address` to versions that resolve the current npm security advisories.

## [1.4.0] - 2026-08-02

### Added

- Added GitHub bug-report and feature-request templates with SVN MCP-specific environment,
  reproduction, safety, and sanitization fields.
- Added `receipt` and `structured-only` response modes. Receipt mode defines bounded minimal
  contracts for status, snapshot, precommit, update, and commit.
- Added validated field projection for high-use tools. Allowed fields are published once in the
  generated API contract rather than repeated in every live tool schema.
- Added explicit `humanText:true` opt-in for clients that need a short text content block.
- Added server-level `full`, `docs`, and `review` tool profiles through
  `SVN_MCP_TOOL_PROFILE`; the focused profiles advertise only 8 or 11 tools and return a typed
  refusal when a client calls a hidden tool.
- Added canonical `svn_path_change` with an explicit `move`, `rename`, or `copy` action.
- Added repository-driven `normalizeEol` handling to `svn_add`; configured text files are
  transactionally normalized and verified before scheduling, while binary and policy-excluded
  byte-exact files are reported as skipped.
- Added bounded multi-file `eol_fix_verified` input with aggregate counts, per-file failures, and
  normalized-content SHA256 proof.
- Added actionable numeric-limit validation and a CI response/schema budget gate.
- Added process-local snapshot tokens for status/snapshot `NO_CHANGE` polling, with bounded TTL,
  query and working-copy binding, tamper rejection, and replacement tokens after a change.
- Added bounded process-local diff evidence. Continuation calls reuse an opaque operation ID so
  later pages are stable even when the working copy changes between requests.
- Added bounded log message filtering, per-revision changed-path summaries, update overlap/top-folder
  summaries, and diff `counts`/`hunk-headings` modes with complete total and omitted-hunk metadata.
- Added `eolCheckComplete` and an EOL-policy identity to compact precommit receipts.
- Added independent 100-item conflict pages for status, snapshot, and update so complete conflict
  evidence remains reachable without allowing one receipt to grow without bound.
- Added `expandDescendants:true` to precommit and commit. Explicit directories can now expand to a
  fully guarded, visible changed-descendant scope while node-only behavior remains opt-in.
- Added `svn_commit operation:"prepare"`, which performs a pinned explicit-path update with conflict
  postponement, optional remote-HEAD guarding, unexpected-path refusal, and a final precommit
  receipt without committing. A hidden `svn_prepare_commit` route preserves explicit compatibility
  without adding an advertised schema.
- Added durable UUID operation receipts for update, commit/prepare, EOL repair, and conflict
  resolution. Identical retries replay compact results across MCP restarts; concurrent, mismatched,
  corrupt, and ambiguous stale operations fail closed instead of repeating a mutation. Abandoned
  receipt locks are reclaimed after a bounded interval while active lock contention returns a typed
  failure.
- Added explicit-file pre-edit baselines through `svn_snapshot captureBaseline:true`. A later
  `svn_update baselineToken` reports local edits, remote touches, postponed conflicts, and
  same-path collisions without requiring a full update transcript.
- Added READY precommit tokens bound to exact status, base revisions, content and SVN property hashes, repository
  policy, diff identity, scope, and remote revision. `svn_commit precommitToken` refuses if any
  bound evidence changed after verification.
- Added `svn_commit operation:"safe"` as one durable guarded workflow: pinned scoped update,
  collision refusal, verified EOL repair when needed, precommit binding, commit, pinned final
  update, and a clean scoped snapshot. Bounded stage detail is paged later through
  `operation:"detail"` instead of inflating the normal receipt.
- Safe mode omits only scheduled-added operands from its pinned update while still checking the
  expected repository HEAD and retaining those files in the exact precommit and commit scope.

### Changed

- GitHub Issues is now the canonical public tracker. The 31 completed historical SVNMCP tasks were
  migrated as closed issues with 33 distinct notes, condensed completion evidence, and four
  relations, without private tracker metadata.
- Reworked setup documentation around the globally installed npm command and added generic,
  platform-neutral install and source-development prompts.
- Prepared releases now carry their own package manifest, and API-contract generation always uses
  the full canonical tool profile regardless of the caller's environment.
- Buffered and streamed child processes now share bounded UTF-8 byte accounting, sticky
  truncation, cancellation, timeout escalation, and process-tree termination.
- Compact diff shaping bounds per-file previews before redaction and serialization. Streamed diff
  callbacks have independent line/byte work budgets and report when aggregate totals are lower
  bounds.
- Workflow and commit hashes now use cancellable asynchronous streams, and test runs use isolated
  operation-receipt stores instead of the live user store.
- Workflow hashing now uses a bounded worker pool plus a configurable aggregate-byte ceiling;
  receipt-lock retries yield to the MCP event loop instead of blocking every request.
- Large verified EOL repairs now use streaming sniff/hash verification and disk-backed backups.
  Rollback refuses to overwrite a file changed by another writer after normalization.
- Structured content is now authoritative by default; successful and failed calls omit duplicate
  `content.text` unless explicitly requested.
- Compact, receipt, and standard responses use working-copy-relative paths; absolute paths and
  raw commands remain full-diagnostic output only.
- Compact guard refusals now return a typed guard code, one actionable detail, and an affected-path
  count without echoing the complete submitted path list.
- High-volume advanced inputs are validated centrally and published once in `MCP_API.json` instead
  of being repeated across live tool schemas. This preserves schema-token budgets while keeping
  snapshot, evidence, log-filter, and update-overlap controls available to known callers.
- Diff aggregate file, hunk, addition, removal, binary, and property counts remain complete after
  detailed per-file summaries reach their 20,000-entry cap; terminal evidence truncation is explicit.
- Runner line/output truncation now propagates into stored diff evidence, and nonzero/past-end update
  pages retain total, offset, and bounded top-folder context.
- Check-style responses report pass counts and failures by default; passing details require
  `includePassing:true` and remain paginated.
- The full profile now advertises 25 canonical tools. Legacy `svn_move`, `svn_rename`,
  `svn_copy`, and `svn_resolved` routes remain callable for existing clients but are omitted from
  tool discovery to reduce schema context.
- `svn_blame` now ignores EOL-only churn by default, matching the existing `svn_diff` default;
  both tools expose `showEolChanges:true` for diagnostics, and pure EOL diffs return `eolOnly:true`.
- Commit-message format validation now blocks before `svn commit` and returns a typed failed rule
  plus a bounded suggested message.
- Successful commit receipts now separate exact committed paths from post-commit residue and add
  bounded revision, remote-head, mixed-state, EOL-availability, and content-hash evidence.
- Baseline, precommit, collision, and safe-commit controls are published once as advanced inputs;
  the full profile remains at 25 advertised tools and compact safe-commit receipts stay
  structured-only by default.

### Fixed

- Fixed prepared `current/dist/index.js` launches that could fail module/package resolution while
  self-check still reported the layout healthy.
- Fixed delete commit and safe-commit receipts so removed targets no longer cause false residue or
  final-verification failures.
- Fixed multi-path repository logs, exact numeric/whitespace property values, revision diffs for
  literal `@` paths, observed update-HEAD receipts, added-parent guard rechecks, and lock-status
  parsing.
- Bounded evidence metadata, operation-receipt reads, workflow hashing, and diff evidence summaries;
  snapshot tokens now use one canonical state across compact and receipt modes.
- Durable stale commit outcomes now fail closed instead of inferring success from matching message
  text, and operation-lock cleanup refuses to break locks owned by live processes.
- Fixed receipt-store contention and abandoned breaker recovery, prepared-pointer validation by
  physical path, cross-mode status snapshot tokens, independent stdout/stderr overflow handling,
  and explicit buffered-output truncation receipts.
- Enforced absolute `cwd` values and refused credential-bearing repository URLs at both schema and
  runtime boundaries.
- Bounded compact log serialization to 24 KiB, rejected unsafe numeric cursors, removed anonymous
  tree-conflict placeholders, and required `riskAck:true` for destructive revert execution.
- Applied never-commit guards to verified EOL repair and commit-message validation to `svn_import`.
- Fixed receipt continuation so a supplied cursor advances to the next changed-path page instead of
  repeating page one.
- Removed remaining absolute working-copy paths from non-full warnings, detailed self-check output,
  standard diagnostics, and batch EOL failure receipts.
- Embedded a Windows UTF-8 active-code-page manifest in the bundled VisualSVN `svn.exe`, preserving
  Greek, accented, CJK, and spaced path arguments without a shell or machine-wide locale change.
- Added a post-large-diff client call to prove oversized SVN output cannot corrupt the next MCP
  JSON-RPC frame.
- Prepare mode now checks root, directory, never-commit, and expansion scope before updating;
  node-only directory preparation uses `--depth empty`, and expanded precommit risk signals are
  calculated from the expanded files.
- Compact and receipt prepare failures retain up to 25 unexpected paths plus explicit total and
  truncation metadata; ordinary non-expanded calls no longer emit empty expansion fields.

## [1.3.0] - 2026-07-31

### Added

- Added exact revision pinning and an optional `expectedRemoteHead` guard to `svn_update`, with
  resulting revision/range metadata, bounded changed-path receipts, and the existing explicit-scope
  and conflict-postpone safety.
- Added opt-in `requireUniformRevision:true` release gating to `svn_precommit`; ordinary precommit
  calls remain backward compatible and continue to report mixed revisions without blocking.

### Fixed

- Preserved successful SVN warnings and recovered exact existing paths beneath ignored directories
  as ignored entries with their covering ancestor instead of returning an empty status for
  VisualSVN/Subversion `W155010`.
- Made multi-entry `svn_log` envelopes unambiguous with `revision:null`, `revision_range`, and
  `entry_count`, while retaining per-entry changed paths and single-revision behavior.
- Marked the prepared-release `current` pointer as inapplicable for direct npm-package layouts;
  healthy npm self-checks now return `current_matches_package:null` without reducing health.

## [1.2.2] - 2026-07-28

### Fixed

- Refuse existing directory targets in `svn_precommit` and `svn_commit` unless
  `allowDirectoryTargets:true` explicitly acknowledges node-only `--depth empty` behavior and
  excluded descendants; precommit now also mirrors the commit root acknowledgement.
- Document that the spawning MCP client controls Windows process-window visibility, and add a
  regression test proving startup diagnostics use stderr while stdout remains protocol-only.

## [1.2.1] - 2026-07-27

### Fixed

- Bounded compact `svn_diff` JSON-RPC results even when callers request `diffMode:"full"` and
  large `maxChars`/`maxFiles` values. Oversized excerpts and file summaries now expose independent
  continuation cursors instead of producing multi-megabyte stdio records.
- Updated the test-only coverage/glob dependency chain to patched releases after new registry
  advisories affected the Jest development graph.

## [1.2.0] - 2026-07-22

### Added

- Added guarded `svn_delete` with dry-run-by-default behavior, explicit paths, root refusal,
  recursive acknowledgement, `riskAck`, and post-delete status verification.
- Added canonical `svn_resolve` while retaining `svn_resolved` as a deprecated compatibility alias.
- Added `svn_snapshot`, bounded `svn_cat`, and paginated `svn_blame` for common audit workflows.
- Added exact/range revision selectors to `svn_log` and `svn_diff`.
- Added request-cancellation propagation from MCP calls to buffered and streaming SVN processes.

### Changed

- Working-copy-root commits now require `allowRoot:true`, and whitespace-only commit messages are
  refused before SVN runs.
- Agent install instructions now compare the installed version with `npm view` instead of pinning a
  remembered latest version.
- Builds and typechecks now run on native TypeScript 7 (`tsc` 7.0.2), while the Jest `ts-jest`
  transform keeps the TypeScript 6 compiler through the `@typescript/typescript6` shim (`tsc6`)
  until tooling gains TypeScript 7 API support.

### Fixed

- Compact revert receipts now identify the default dry-run behavior even when `dryRun` is omitted.
- Blocked direct imports of files beneath sensitive `.ssh`, `.git`, and `.svn` directories by
  preserving ancestor path segments during guard evaluation.
- Refused conflicted, obstructed, external, and unknown working-copy states during precommit and
  commit instead of reporting them as committable.
- Distinguished colons inside date revisions from revision-range separators.
- Kept the requested lower revision bound across paginated numeric `svn_log` ranges.
- Contained NUL-byte process launch failures and unexpected tool exceptions in structured MCP
  error envelopes.
- Kept arbitrary `svn_propset` values out of displayed process commands by passing them through a
  mode-0600 temporary `-F` file.
- Bounded retained streamed stdout and diff excerpts independently of line and file-summary caps.

### Security

- Updated transitive dependencies and the MCP HTTP adapter override; `npm audit` reports no known
  vulnerabilities at the moderate threshold.
- Added regressions for sensitive import ancestors and end-to-end conflicted working-copy refusal.

### Packaging

- npm artifacts now include `docs/SPEC.md` and a generated `docs/MCP_API.json` tool contract.

## [1.1.3] - 2026-07-20

### Security

- Replaced the SlikSVN payload and its outdated OpenSSL 3.0.16 DLLs with the July 2026
  redistributable VisualSVN Apache Subversion 1.14.5 command-line package.
- Added complete upstream license and Subversion notice files for the bundled Windows runtime.
- Redacted secret-like URL values from parsed fields in standard and full MCP responses.
- Rejected repository policy files larger than 64 KiB and non-regular policy paths before reading
  or parsing them.
- Made `.git`, `.hg`, `.svn`, and `.ssh` directory contents immutable never-commit paths.
- Bounded XML entity expansion in all SVN XML parsers and continued to reject external entities.
- Pinned GitHub Actions to immutable commit hashes.

### Fixed

- Treated literal `@` characters safely according to each SVN subcommand's operand semantics,
  including VisualSVN's distinct move and copy destination parsing.
- Refused symbolic links and Windows directory junctions in recursive import/add scans so SVN
  cannot follow them into unscanned external content.
- Made batched EOL property writes skip already-correct paths while updating the remaining paths.
- Allowed `eol_fix_verified` dry runs in read-only mode because they do not modify the working copy.
- Redacted identity-like URL query values including usernames, email addresses, and client IDs.
- Reported unknown future SVN status values explicitly instead of synthesizing a potentially
  misleading known status code.
- Required self-check package-root discovery to match the `svn-agent-mcp` package name.
- Replaced inline benchmark commit messages with temporary `-F` message files.
- Derived the MCP server version from `package.json` so release version bumps cannot leave the
  running server on stale metadata.
- Prevented compact self-check from reporting an incomplete runtime layout as available.
- Removed the per-file fallback process fan-out when a batched EOL property query returns partial
  XML alongside SVN's expected missing-property exit code.
- Failed EOL checks on genuine property-query errors or malformed XML rather than treating them as
  paths without an EOL property.
- Built `dist/` automatically before npm packing and made the packed-install smoke test launch the
  installed `svn-agent-mcp` command shim.

### Performance

- Ran independent startup tool probes concurrently.

## [1.1.2] - 2026-07-20

### Fixed

- Prevented repository policy allow rules from overriding private-key, `.env*`, and `.npmrc`
  never-commit guards.
- Bounded individual streamed diff lines and per-file summaries, with explicit truncation signals.
- Mapped buffered SVN output overflow to a scoped diagnostic instead of a generic failure.
- Added consistent `--` operand separators to SVN commands as defense in depth.
- Added finite public limits for path arrays, path strings, repository locations, messages, and cursors.
- Accepted npm 12 and newer without an engine warning while keeping npm 11.16.0 as the minimum.
- Required `externalDestAck:true` before exporting outside a working copy.
- Checked mixed revisions at the working-copy root during precommit and commit flows.
- Based EOL repair proof on complete per-file summaries and applied never-commit guards to EOL props.
- Skipped `.svn` administrative directories during recursive add/import guard scans.

### Documentation

- Documented import/export filesystem reach, immutable credential guards, and output-size limits.

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
