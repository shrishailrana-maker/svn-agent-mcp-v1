# svn-agent — Generic Implementation Spec

**Spec version 1.36 — public implementation contract. Single source of truth.**
This document describes the current generic SVN MCP design without deployment-specific paths,
hostnames, or product-specific role assignments. Date: 2026-08-08.

**What this is:** one document containing the pain points, the resolution strategy, the full
architecture and tool contracts for a strict SVN MCP server, companion operational guidance, and
the historical development plan with verification gates. A maintainer should be able to implement
or review the server from this document and the source tree.

---

## 1. Pain points (why this exists)

Automated clients working SVN checkouts across multiple projects waste large amounts of time on SVN
housekeeping. The workflow usually has write-capable clients that may mutate SVN state and
read-only clients that may inspect but must not mutate. Deployments choose which client fills
each capability. The MCP must enforce permissions by configuration, not by product name.

Common SVN automation friction splits into three buckets:

**P1 — The client loop (dominant, ~70–80%).** A single commit-prep today costs 5–8 separate
shell calls (status → diff → EOL check → EOL fix → re-diff → commit → post-status). Every call
is a full model round trip; every shell call can hit a permission prompt, and in an unattended
session one prompt stalls the run until a human returns. Clients also re-derive the SVN policy
(exact diff flags, `-F` rule, never-commit list) from `docs/svnrules.md` every session —
repeated reasoning overhead, and each hand-composed command is a chance to get policy wrong.

**P2 — EOL damage that shouldn't exist.** Many Windows SVN source trees require CRLF +
`svn:eol-style=native`, no BOM. Automated file-creation tools can create new files with bare LF (`\n` in the
content string goes to disk as-is); shell heredocs/redirects do the same. The repo property only
normalizes at commit, so the working file stays LF, `svn diff` shows whole-file churn, and the
client burns a detect → `unix2dos` → re-diff loop. All of it is remediation for damage that is
preventable at write time. (Patch-based edits often preserve EOL; the damage paths are new-file writes and
shell output.)

**P3 — Raw `svn.exe` speed on Windows.** `svn status/diff` stat thousands of files plus the
`.svn` pristine store; Microsoft Defender real-time scanning taxes each of those file
operations (typically 2–10× on file-heavy svn work). Unscoped status/diff over the whole
working copy multiplies the cost.

## 2. Resolution strategy (pain → fix mapping)

| Pain | Fix | Where in this doc |
|---|---|---|
| P1: 5–8 round trips per commit | `svn_precommit` + `svn_commit` = 2 calls; bound `operation:"safe"` = 1 call | §8.3, §8.4 |
| P1: permission-prompt stalls | Publish explicit read-only and non-destructive tool annotations; host policy controls approvals | §10.4 |
| P1: policy re-derivation + drift | Policy baked into the MCP as defaults & guards; read-only clients hard-READONLY | §7 |
| P1: raw-diff dumping into context | Structured JSON envelope, per-file ± counts, line-capped excerpts | §6.4, §8.3 |
| P2: LF files born from file-creation tools | Repo policy makes `svn_add` normalize and verify new text files | §8.4 |
| P2: new files missing eol-style prop | Repo-root inherited `svn:auto-props` (SVN ≥1.8) | §10.2 |
| P2: remediation loop when it does happen | `eol_fix_verified`: fix + proof re-diff in one call | §8.3 |
| P3: Defender tax | Optional path exclusion for a chosen working-copy root (operator decision) | §10.3 |
| P3: unscoped commands | Tools require/target explicit paths structurally | §7 |

Rejected options (so maintainers do not re-litigate them): **forking an existing permissive SVN
MCP** (optional commit paths, dangerous update accept-modes, PATH/env setup, credentials in
environment variables; the safety layer is most of the code, so write from scratch). Safe ideas
from external projects may be borrowed only when they preserve this MCP's guard model; the current
baseline borrows the read-only diagnose/error-taxonomy pattern, not permissive mutating or
configuration semantics.
**`exclusive-locking=true`** in the svn runtime config
(write-capable clients, read-only clients, and GUI SVN tools may share the WC; exclusive SQLite locking
makes them error on each other); **pristine-less checkout `--store-pristine=no`** (needs SVN ≥1.15, and makes `diff` —
the hottest path — hit the network); **svn client upgrade** (no measurable win for this
workflow).

## 3. Reference environment assumptions

- The Windows SVN and EOL converter payload is bundled under `<MCP_HOME>/svn-agent/bin` and copied
  into every release under `releases/v<version>/bin`. On macOS and Linux, the runtime ignores the
  Windows executables and resolves native `svn`, `svnversion`, `svnadmin`, `dos2unix`, and
  `unix2dos` commands from `PATH`. The implementation targets SVN 1.14+ behavior and probes the
  exact client at startup.
- Normal end-user configuration needs no environment variables and no project-specific `cwd`.
  `SVN_AGENT_BIN_DIR`, `SVN_AGENT_SVN_PATH`, and `SVN_AGENT_DOS2UNIX_DIR` are development/test
  overrides; compatible bundled tools are preferred, with `PATH` as the native fallback.
- Each tool call operates against a caller-provided `cwd` or an inferred working copy from absolute
  paths. Relative paths require explicit per-call `cwd`. A single MCP registration may service many
  SVN working copies on the same machine.
- Project text policy is discovered from `.svn-mcp-policy.json`, SVN properties, and local bytes.
  A repository may set `normalizeEol` to `crlf`, `lf`, or `none` and exclude byte-exact fixtures.
- MCP installation home is chosen by the deployer, for example `<MCP_HOME>\svn-agent`.
- Node 24.18.0 or newer within the Node 24 LTS line and npm 11.16.0 or newer are required.

## 4. Locked decisions (no open questions)

| # | Decision | Rationale |
|---|---|---|
| D1 | Write from scratch in TypeScript/Node; do **not** fork an existing SVN MCP | Safety layer is the product; forking inherits a permissive surface |
| D2 | Read-only safety = launch with `--readonly` (legacy/dev env `SVN_AGENT_READONLY=1` also works); every mutating tool refuses | Simple, unbypassable, matches "read-only clients never change SVN state" |
| D3 | Mixed-revision WC on commit → **warn in `note`, proceed** | Caller decides; refusing blocks legitimate scoped commits |
| D4 | `riskAck:true` required for mechanically detectable risky slices (§7 G6); undetectable risk categories remain caller decisions | Encodes the risky-slice gate without pretending to detect the undetectable |
| D5 | Branch/switch/merge/relocate remain out of scope; guarded delete is supported with dry-run, explicit paths, and risk acknowledgement | Delete is needed for normal scoped maintenance; the other operations still require separate guard designs |
| D6 | Versioning: **semver**, first release `v0.1.0`; `current` junction → `releases\v0.1.0` | One pin, easy rollback |
| D7 | Env overrides win; use compatible bundled tools next and native `PATH` tools otherwise | Windows stays self-contained while macOS/Linux use their normal package-managed toolchain |
| D8 | Commit message format is validated before SVN and invalid messages are refused with typed remediation | Prevent successful commits followed by unusable warnings |
| D9 | Commit message via temp **`-F` file outside the WC**, never `-m` | Encodes the shared SVN policy |
| D10 | `svn_update` needs explicit `paths[]` or `updateAll:true`; optional exact `revision`; always `--accept postpone` | Update is operator-gated and can be release-pinned; conflicts must surface, never auto-resolve |
| D11 | XML output (`--xml`) for status/info/log parsing with finite entity-expansion limits; regex only where svn has no XML (diff, update, commit) | Locale-proof, stable parsing without unbounded entity expansion |
| D12 | ESM TypeScript, strict mode; deps only `@modelcontextprotocol/sdk`, `zod`, `fast-xml-parser` | Small, auditable |
| D13 | Server registered under the name **`svn`**; tools named `svn_*` / `eol_*` | Short, unambiguous |
| D14 | External SVN MCPs are reference material, not the base implementation | Borrow diagnostics/docs lessons; reject force flags, optional broad commits, shell execution, credential env vars, and repo-specific registration |
| D15 | Cross-call safety evidence uses expiring path-bound tokens; durable mutation IDs remain host-local and fail closed | Detect concurrent changes without persisting repository content or adding advertised tool schemas |

## 5. Generic SVN policy inlined

These are restated here so the implementer does not need deployment-specific rule files:

1. Scoped commands only; commit prep = scoped MCP `svn_status` + scoped MCP `svn_diff` on
   intended paths. `svn_diff` owns the internal ignored-EOL diff command by default.
2. `svn update` only on explicit operator request; **never** as a default preflight.
3. Commit: message file + explicit file list — `svn commit -F <msgfile> <path1> <path2>`;
   never bare inline `-m`. After commit, report the revision and clean scoped status.
4. Risky slices (large, destructive, schema-changing, version-bumping, build-system-changing,
   delete-heavy, security-sensitive, scope-unclear) stop for operator approval before commit.
5. Read-only instances never commit, stage, revert, update, or change SVN state. They
   may report the intended fix or commit plan for a write-capable client.
6. EOL: preserve tracked files unless explicitly repaired. A repository may configure automatic
   normalization for files explicitly passed to `svn_add`; binary and excluded byte-exact files
   are never converted. EOL-only churn is not a code change.
7. For managed project working copies, never commit: `bin/`, `obj/`, `.vs/`, generated output,
   `*.db`, `scratch/**`, secrets, keys, certificates, tool caches, or unrelated drive-by changes.
   These guards are segment-aware so nested build output such as `src/App/bin/Debug/**` is also
   blocked. A repository may version an optional `.svn-mcp-policy.json` to allow intentional
   payloads; the MCP repository uses that to allow its root `bin/` runtime toolchain and
   versioned release payloads without weakening normal project defaults. Policy exceptions cannot
   override credential-file guards for private keys, `.env*`, or `.npmrc`.
8. Commit message format:
   ```
   <short summary>

   - <logical change group>
   - <verification performed>
   - <behavior impact, or "No behavior changes">
   ```

## 6. Architecture

### 6.1 Process model & layout

Stdio MCP server, one process per client instance. Write-capable clients launch normally;
read-only clients launch with `--readonly`. Thin wrapper: every tool call launches `svn` (or
`unix2dos`/`dos2unix`) through `execFile` or streaming `spawn` with `shell:false` — **no shell**,
no quoting pitfalls, and never an in-process rewrite of tracked file bytes.

```
<MCP_HOME>\svn-agent\
  src\
    index.ts          # server bootstrap, tool registration, READONLY gate
    runner.ts         # no-shell process wrappers: timeout, bundled-bin lookup, streaming, redaction
    envelope.ts       # Envelope type + builders (ok/fail)
    guards.ts         # G1–G7 guard framework (§7)
    evidenceStore.ts  # bounded process-local cursor and workflow evidence
    operationStore.ts # durable host-local idempotency receipts
    workflowState.ts  # canonical status/revision/content identity binding
    parse\
      statusXml.ts, infoXml.ts, logXml.ts   # --xml parsers (fast-xml-parser)
      diffText.ts     # unified-diff → per-file {added, removed}; lineLimit excerpting
      updateText.ts   # U/G/C/E line parser + "Summary of conflicts"
      commitText.ts   # /Committed revision (\d+)\./
    eol.ts            # byte sniffing (EOL kind, BOM, binary), dos2unix/unix2dos invocation
    tools\
      readonly.ts     # status/info, diff/log/cat/blame, EOL, properties, lock status
      composite.ts    # svn_snapshot, svn_precommit, commit workflows, eol_fix_verified
      mutating.ts     # svn_add, svn_commit, svn_path_change,
                      # svn_update, svn_revert, svn_delete, svn_resolve, svn_cleanup,
                      # svn_propset_eol_style, svn_propset, svn_lock, svn_unlock,
                      # svn_needs_lock, svn_export, svn_import
  tests\              # jest: unit + integration (temp file:// repo)
  bin\                # versioned full Windows SVN and dos2unix runtime payloads
  dist\               # tsc output (committed into releases\, not into src tree)
  releases\v<version>\dist\index.js
  releases\v<version>\bin\...
  current -> releases\v<version>        (directory junction)
  docs\SPEC.md                          (this file)
  package.json, tsconfig.json
```

Launch write-capable clients: `node <MCP_HOME>\svn-agent\current\dist\index.js`.
Launch read-only clients: `node <MCP_HOME>\svn-agent\current\dist\index.js --readonly`.

### 6.2 Environment variables

No environment variable is required for normal end-user operation. These variables are retained
only as development/test escape hatches:

| Var | Normal user? | Meaning |
|---|---:|---|
| `SVN_AGENT_READONLY` | No | Legacy/dev equivalent of `--readonly`; mutating tools return `ok:false`, `note:"READONLY instance"` |
| `SVN_AGENT_BIN_DIR` | No | Dev/test override for directory containing bundled svn/EOL tools |
| `SVN_AGENT_SVN_PATH` | No | Dev/test full path or command override for the platform-native SVN executable |
| `SVN_AGENT_DOS2UNIX_DIR` | No | Dev/test directory override containing platform-native dos2unix/unix2dos executables |
| `SVN_AGENT_MAX_DIFF_LINES` | No | Dev/test default diff excerpt cap; tools also accept `lineLimit` |
| `SVN_AGENT_TIMEOUT_MS` | No | Dev/test per-process timeout |
| `SVN_MCP_TOOL_PROFILE` | No | Advertised tool surface: `full` (default, 29 canonical tools), `docs` (8), or `review` (11) |
| `SVN_MCP_RESPONSE_MODE` | No | Default public response mode: `compact`, `receipt`, `structured-only`, `standard`, or `full` |
| `SVN_MCP_OPERATION_DIR` | No | Optional host-local directory for bounded durable mutation receipts |
| `SVN_MCP_WORKSTATION_LABEL` | No | Default lock workstation label; one to 64 `[A-Za-z0-9._-]` characters |

### 6.3 Path & cwd rules

Every tool accepts optional `cwd` (absolute). For plug-and-play global registration, clients do
not set a launch `cwd`; when a tool call supplies absolute paths and omits `cwd`, the MCP locates
the nearest SVN working copy for those paths. Relative paths still resolve against explicit `cwd`
when provided; without `cwd` or absolute path hints, the call is refused. Resolved paths **must stay inside one working
copy root** (found via `.svn` ancestor discovery + `svn info --xml`) — anything outside → guard
refusal. Empty `paths: []` where paths are required → refusal (`note:"explicit paths required"`),
never silently `.`.

### 6.4 Response modes and internal envelope

Every tool accepts optional `responseMode: "compact" | "receipt" | "structured-only" |
"standard" | "full"`. The server default is `compact`, overridable with
`SVN_MCP_RESPONSE_MODE`. Compact mode returns bounded tool-specific structured results.
`structured-only` is an explicit compact alias. Receipt mode is smaller still for status,
snapshot, precommit, update, and commit: verdict/success, relative changed paths, revisions,
conflict and line totals, operation ID when available, and continuation only. Other tools treat
receipt as compact.

`structuredContent` is authoritative. Every mode except `structured-only` returns exactly one bounded
text block by default; `structured-only` returns no text block. The text block is a short summary and
never replaces structured data. `humanText` remains accepted for compatibility but does not change
this bound. Standard mode preserves the parsed envelope without raw successful stdout, commands, or
absolute working-copy roots. Full mode preserves the bounded legacy diagnostic envelope, including
raw successful output and machine paths. Non-full failures retain actionable bounded diagnostics with
working-copy paths made relative, except typed
guard refusals omit redundant raw submitted path lists. Response shaping never bypasses path
validation, guards, EOL checks, mixed-revision checks, or post-mutation verification.

If both usable text and structured content are absent, classify the result as a harness or transport
drop. Disclose `SVN MCP empty`, preserve the same explicit path scope, and use bounded native `svn`
fallback steps for the operation. Retry the MCP later and prefer it again after a usable response;
never use this fallback to bypass a guard refusal.

Compact, receipt, and standard paths are working-copy-relative. High-use tools accept a validated
`fields` projection. The one shared allowed-field catalog is generated under
`globalResponseControls.fieldProjections` in `MCP_API.json`; it is intentionally not repeated in
every live tool schema. The call router validates projection names before invoking a tool. Snapshot
also skips its status or info subprocess group when the requested fields prove that group is not
needed. Safety checks in precommit and mutations never skip work because of projection.

High-volume controls that are useful only after an initial receipt are validated by the same call
router and published once under `globalResponseControls.advancedInputs` in `MCP_API.json`. They are
not repeated in every live tool schema. This catalog includes snapshot cursors, stable diff evidence,
bounded log filtering/summaries, and update overlap/paging controls. A client that rejects unknown
input properties must construct calls from the generated contract or use an MCP client that forwards
these validated extension fields.

Status/snapshot tokens are opaque, process-local, working-copy and query bound, valid for 15 minutes,
and capped at 512 live tokens. Diff evidence is process-local, bound to operation kind and request
scope, valid for 10 minutes, capped at 2 MiB per operation, 32 operations, and 16 MiB total. Invalid,
expired, wrong-scope, or wrong-kind identifiers return typed errors. Neither token family survives a
server restart or stores repository evidence outside server memory.
Workflow evidence uses the same bounded process-local store but distinct kinds and scope binding.
An explicit-file baseline records status, base revision, kind, SHA256 content identity, and a
canonical hash of all SVN properties before editing. A READY precommit token additionally binds
repository policy, diff identity, EOL policy,
and observed remote revision. Invalid, expired, wrong-kind, wrong-scope, changed-policy, changed-file,
or changed-remote evidence is refused before commit. Directory baselines are refused because they
cannot prove descendant identity. Safe-operation stage detail is paged from bounded memory and is
not included in the normal receipt.
Conflict evidence uses an independent `conflictCursor`, pages at most 100 explicit paths, and always
reports total count and truncation. This keeps safety evidence reachable without unbounded receipts.

Mutation `operationId` values are distinct from process-local read evidence. Update, commit/prepare,
EOL repair, and conflict resolution accept an optional UUID that is bound to normalized request
inputs and persisted in a bounded host-local store outside every working copy. Identical terminal
requests replay their compact receipt after process restart. Concurrent reuse, changed inputs,
unreadable records, and incomplete receipts fail closed. Every unfinished stale mutation remains
explicitly ambiguous and is never inferred from similar repository history or re-executed
automatically. Unfinished receipts are retained for inspection.
Abandoned receipt-file locks are reclaimed after 30 seconds; live contention waits asynchronously
for at most five seconds, then returns a typed `OPERATION_STORE_FAILED` refusal without blocking
unrelated MCP requests or throwing through the MCP boundary.
The physical receipt directory is refused under any `.svn` working-copy ancestor. Terminal receipts
and stale orphan lock/temp files are pruned within the configured fixed record, byte, age, and
per-record caps. In-progress, unreadable, and fresh orphan records are retained; if they exhaust a
cap, a new operation is refused rather than deleting ambiguity evidence.
These records coordinate retries on one host only and are not a distributed lock between machines.

### 6.5 Tool profiles

Tool profiles reduce session schema context; they are not a permission boundary. `full` advertises
29 canonical tools. `docs` advertises `svn_update`, `svn_status`, `svn_log`, `svn_add`,
`eol_check`, `eol_fix_verified`, `svn_precommit`, and `svn_commit`. `review` adds `svn_diff`,
`svn_cat`, and `svn_blame`. A call to an unadvertised tool in a focused profile returns a typed
`TOOL_PROFILE` refusal with remediation. READONLY checks and every mutation guard still run
independently.

The full profile omits legacy `svn_move`, `svn_rename`, `svn_copy`, and `svn_resolved` from tool
discovery. Existing clients may continue calling those routes in full mode, while new clients use
`svn_path_change` and `svn_resolve`. This retains wire compatibility without charging every agent
for four redundant schemas.

Internally, tools retain this complete envelope so composite and mutation safety logic does not
depend on the selected public response mode:

```ts
interface Envelope {
  ok: boolean;
  command: string;          // argv joined for display; credentials redacted (flags, URL userinfo/query secrets)
  cwd: string;
  revision: number | null;  // resulting/queried revision when meaningful
  changed_paths: { status: string; path: string }[];
  conflicts: { path: string; type: "text" | "tree" | "prop" }[];
  stdout_summary: string;   // capped at 200 lines/16,000 chars; "truncated" set if capped
  stderr_summary: string;
  truncated: boolean;
  note: string;             // one-liner: guard fired / warning / verdict
}
```

Tools add tool-specific fields beside these (documented per tool). Public compact responses map
those fields to smaller camel-case receipts; `responseMode:"full"` returns the envelope above.
Internally, errors are always envelopes and never thrown raw stacks; the public tool boundary
converts unexpected parser, filesystem, and runtime exceptions into a generic failure envelope.
Compact public errors retain
`ok:false`, the actionable note, bounded diagnostics, conflicts, and recovery hints while omitting
empty legacy fields. Redaction applies to `command`, `stdout_summary`, `stderr_summary`, compact
log/property values, and projected repository URLs: `--password`/`--username` values, inline
`--password=...`/`--username=...`
values, URL userinfo (including malformed userinfo with raw `@`), and sensitive URL query
parameters are replaced with `***` (the server itself never passes credentials; svn uses its
cached auth).

### 6.5 Startup probe

All SVN child processes run without a shell, with `--non-interactive`, a stable `C` locale, bounded
stderr capture, timeout settlement, and latin1 fallback for non-UTF8 bytes. On boot: resolve
overridden, compatible bundled, or `PATH` SVN (`--version --quiet`) and dos2unix/unix2dos
(`--version`), then detect READONLY. Failures don't kill the server — the affected
tools return `ok:false` with an explanatory `note` (e.g. `eol_*` unavailable when dos2unix
missing).
The server reserves stdout for newline-delimited MCP JSON-RPC and writes startup diagnostics to
stderr. On Windows, the spawning MCP client controls process-window visibility and should use its
hidden/no-window process option.

### 6.6 Error taxonomy (svn stderr → structured notes)

| svn error | Mapping |
|---|---|
| `E155004`/`E155036` (WC locked) | `note:"working copy locked - run svn_cleanup"` |
| `E170001`/`E215004`/auth | `note:"authentication failed - fix svn cached auth outside the MCP"` |
| `E175002`/connection failures | `note:"network or repository connection failed"` |
| `E155007` (not a WC) | `note:"path is not inside a working copy"` |
| `E135000` / inconsistent EOL | `note:"inconsistent line endings - run eol_fix_verified on affected files"` plus EOL diagnostics where available |
| `E200009` / unversioned target | `note:"target not versioned"` |
| `E200030`/SQLite database failures | `note:"working copy database problem - run svn_cleanup"` |
| timeout | `ok:false`, `note:"svn timed out after <ms>"`, process killed |
| non-UTF8 output bytes | decode lossy (`latin1` fallback), never crash |

## 7. Guard framework (applies across tools)

- **G1 explicit targets:** mutating path-list tools require non-empty `paths[]`; source/destination tools require explicit `src` and `dest` (exceptions: `svn_update` with `updateAll:true`; `svn_cleanup` takes one `path`). No implicit `.`, no recursive default anywhere. Public path arrays are capped at 500 entries, filesystem paths at 4,096 characters, and repository locations at 8,192 characters.
- **G2 READONLY:** `--readonly` (or legacy/dev `SVN_AGENT_READONLY=1`) → all §8.4 tools + `eol_fix_verified` refuse.
- **G3 WC containment:** resolved paths must be inside the working copy (§6.3).
- **G4 never-commit globs** (block in `svn_add`, `svn_path_change`, and `svn_commit`; case-insensitive, match on repo-relative path): `**/bin/**`, `**/dist/**`, `**/node_modules/**`, `**/coverage/**`, `**/obj/**`, `**/.vs/**`, `**/.cache/**`, `**/*.db`, `**/*.tsbuildinfo`, `scratch/**`, `packages/**`, `tags/**`, `.graphify/**`, `graphify-out/**`, `**/*.pfx`, `**/*.key`, `**/*.pem`, `**/*.p12`, `**/*.snk`, `**/.env*`, `**/.npmrc`, `**/.git/**`, `**/.hg/**`, `**/.svn/**`, `**/.ssh/**`. Optional repo-local `.svn-mcp-policy.json` may add strict allow/deny exceptions for generated payloads, for example to version a toolchain payload in the MCP repository itself. Credential and VCS-metadata guards cannot be overridden. ("Unrelated drive-by changes" cannot be a glob — mitigated by G1 + G5; stays agent judgment.)
  Policy shape:
  ```json
  { "neverCommit": { "allow": ["bin/**"], "deny": ["custom-generated/**"] } }
  ```
  Defaults stay strict when no policy file is present; policy is read from the working-copy root and never from an environment variable. Policy files must be regular files, are capped at 64 KiB, cached by working-copy root and mtime/size, and malformed or pathological policy globs fail with a `policy-error:` guard note.
  Repository-local `deny` rules are evaluated before repository-local `allow` rules, so a broad
  allow exception cannot bypass a stricter project-specific deny or the immutable credential-file guards.
- **G5 must-be-changed:** `svn_commit` verifies every listed path is actually modified/added/deleted per scoped status; unknown/clean path → refusal naming the path.
- **G6 risky-slice ack:** `svn_commit` requires `riskAck:true` when any mechanical signal is present: a delete-scheduled path (status `D`), **more than 8 paths**, `version.ver` among the paths, or a build-system file among the paths (`*.sln`, `*.csproj`, `Directory.Build.props`, `Directory.Build.targets`, `*.props`, `*.targets`, `packages.config`). Exactly 8 paths does not trigger the path-count signal. Refusal lists the triggered signals. Schema-changing / security-sensitive / scope-unclear risk is **not detectable** — the calling client's responsibility (§5.4).
- **G7 no dangerous flags:** `--force` is emitted only by `svn_lock` or `svn_unlock` when
  `force:true`, `forceAck:true`, and a valid UUID `operationId` are all present. `svn_update`
  always gets `--accept postpone`. `svn_cleanup` never gets
  `--remove-unversioned`/`--remove-ignored`/`--vacuum-pristines`. `svn_resolve` requires an
  explicit `accept` value from the caller.

## 8. Tool contracts

All inputs are validated with zod. Tool implementations produce Envelope plus the extra fields
listed; the public response mode then shapes that complete internal result. "argv" shows the exact
svn invocation (before path resolution).

### 8.1 Read-only tools (allowed under READONLY)

**`svn_status`** — `{ cwd?, paths?: string[], statuses?, includeUnversioned?, countOnly?, maxItems?, cursor?, afterCursor? }`
argv: `svn status --xml [--no-ignore] [paths…]` (default target: `.` of explicit `cwd`;
when both `cwd` and absolute path hints are absent, the MCP refuses instead of falling back to
its launch directory). Inputs also accept
`includeIgnored?: boolean` for explicit ignored-path audits and `hideNoise?: boolean` to remove
common local runtime clutter (`node_modules`, `dist`, `current`, `.cache`, `coverage`)
from `changed_paths` while reporting filtered paths in `filtered_paths`. Parses `wc-status` into
`changed_paths` (status letters `M A D R C ? ! ~ I X`, plus `_M` for property-only changes),
property conflicts into `{type:"prop"}`, and tree/text conflicts into `conflicts`. Compact output
returns status counts plus bounded working-copy-relative items; `truncated` and `nextCursor`
identify continuation without silently dropping entries.
The first compact/receipt response includes `snapshotToken`. Repeating the same scoped query with
`afterCursor` returns only `verdict:"NO_CHANGE"` plus a replacement token when revision, status,
conflict, or guard-relevant state is unchanged. Query and working-copy mismatches are refused.
An unchanged conflict or guarded status is still `NO_CHANGE`; the receipt retains its conflict count
instead of falsely reporting a state transition.
Successful SVN warnings remain visible. With `includeIgnored:true`, an exact existing path hidden
below an ignored directory is recovered from `W155010` by checking its contained parent chain; the
result is status `I` with `covered_by_ignored_ancestor:true` and the working-copy-relative
`ignored_ancestor`. Missing and ordinary unversioned paths are not synthesized as ignored.

**`svn_info`** — `{ cwd?, paths?: string[], fields?: InfoField[] }`
argv: `svn info --xml [paths…]`. Extra fields: `url`, `repo_root`, `wc_root`.
Mixed-revision detection: additionally run `svnversion <wc-root>` once; output containing
`:` → `mixed_revision:true` (+ `note`), suffix `M`→modified, `S`→switched, `P`→partial reported
in `note`. The MCP also returns `svnversion`, `revision_range:{min,max}`, `local_modifications`,
`switched`, `partial`, `remote_head_revision`, and `stale_base` so clients can distinguish a
mixed-revision working copy from dirty local edits. Compact callers may project the corresponding
camel-case fields instead of receiving every metadata field.

Mixed revision is valid evidence during parallel-agent work. A `workingCopyMixed:true` commit
receipt is not a failure by itself. `baseRevision` is `null` when the committed paths do not share
one base revision; `baseRevisionRange` carries the useful minimum and maximum. Out-of-date paths,
unresolved conflicts, and stale-base conditions remain separate diagnostics and must be handled
before retrying a guarded commit.

Example: agent A edits `src/a.cs` at revision 40 while agent B commits `docs/b.md` at revision 41.
Agent A's receipt can report `workingCopyMixed:true`, `baseRevision:null`, and
`baseRevisionRange:{"min":40,"max":41}`. If the receipt has no out-of-date paths or conflicts,
the mixed state alone does not block the scoped commit.

**`svn_diff`** — `{ cwd?, paths: string[], file?, revision?: RevisionSelector, ignoreEol?: boolean = true, showEolChanges?: boolean = false, lineLimit?: number = 200, diffMode?: "summary"|"counts"|"hunk-headings"|"compact"|"full", maxChars?, maxHunksPerFile?, maxFiles?, fileCursor?, cursor?, operationId? }`
argv (default): `svn diff --internal-diff -x --ignore-eol-style -- <paths…>` — the generic
commit-prep standard. `ignoreEol:false` → `svn diff --internal-diff -- <paths…>` (raw, for EOL
diagnosis); `showEolChanges:true` is the clearer diagnostic opt-out. A pure EOL working change
returns `eol_only:true` with no diff body. Extra fields: `per_file: [{path, added, removed, binary}]` (parsed from unified
diff; `binary:true` when svn prints "Cannot display"), `diff_excerpt` (first `lineLimit`
lines), `truncated`, `ignore_eol:boolean`. Property-only changes set `property_changed:true` and
do not inflate source line counts. `lineLimit` is capped at 2,000. Compact response mode supports
summary-only output or bounded hunks, with a 3,000-character default. Compact `svn_diff` shaping
also enforces a 28 KiB structured-result budget, leaving JSON-RPC framing headroom below 32 KiB;
`maxChars` and `maxFiles` are upper requests rather than guarantees. `cursor` pages the streamed
excerpt; `fileCursor` pages file summaries independently, including when the transport budget
reduces either requested page. Complete per-file counts are computed before public response
shaping, up to 20,000 file summaries. `per_file_truncated:true` reports when that internal cap is
reached. A single streamed line is capped at 1 MiB and visibly marked.
An exact `revision` uses `svn diff -c`; a `start:end` selector uses `svn diff -r`, preserving the
same bounded summary/excerpt behavior for committed revisions.
Every fresh compact diff returns total files, lines, characters, and hunks plus an `operationId` for
the bounded detail. `counts` (and legacy `summary`) omits hunks; `hunk-headings` returns each file's
first hunk/meaningful line and explicit omitted-hunk/line counts. Optional `file` selects one path
inside the original explicit scope. A continuation with `operationId` reads the stored evidence and
does not rerun SVN, so the page is stable if the working copy changes between calls.
Aggregate additions, removals, binary files, and property files continue counting after the bounded
per-file detail map is full. If retained operation evidence reaches its byte cap, every page reports
`evidenceTruncated`; the final available page adds `evidenceTerminalTruncation` and no unusable cursor.
Runner-level over-limit lines/output contribute to the same terminal state as evidence-store and
detail-capture limits.

**`svn_log`** — `{ cwd?, paths?: string[], revision?: RevisionSelector, limit?: number = 10, verbose?: boolean = false, fullMessage?, changedPaths?, changedPathsSummary?, maxTopLevelDirectories?, maxMessageChars?, maxChangedPaths?, messageContains?, messageCaseSensitive?, scanLimit?, cursor? }`
argv: `svn log --xml -l <limit+1> [-v] [targets…]`; the extra entry determines whether a
continuation exists and is not returned. For working-copy targets, the MCP
resolves target URLs and queries repository URLs at HEAD when possible. This avoids the common
mixed-revision working-copy peg problem where `svn log <wc-root>` only shows history through the
root directory's older BASE revision. If URL resolution fails, the MCP falls back to the original
working-copy paths. Extra: `entries: [{rev, author, date, msg, changed_paths}]`,
`target_mode: "repository-url"|"working-copy-path"`. Compact entries contain revision, author,
date, and the first message line. Full messages and changed paths require explicit flags and remain
bounded; truncation is marked per entry. `nextCursor` continues from an older revision.
An exact or ranged `revision` performs a direct lookup; `revision` and `cursor` are mutually exclusive.
One returned entry keeps the top-level numeric `revision`. Multiple returned entries instead use
`revision:null`, `revision_range:{min,max}`, and `entry_count`; changed paths remain bounded within
their entries and are not aggregated at the top level.
`messageContains` performs a bounded server-side scan (case-insensitive unless
`messageCaseSensitive:true`) and reports scanned/matched counts plus continuation even when a page
contains zero matches. `scanLimit` is capped at 500. `changedPathsSummary:true` returns per-entry
action counts and bounded top-level directory names without emitting the full path list.

**`svn_cat`** — `{ cwd?, path: string, revision?: Revision, maxChars?: number = 16000, cursor? }`
Returns one character-bounded page of one contained working-copy file at an optional revision.
`hasMore` and `nextCursor` make truncation explicit; binary content is identified and omitted.

**`svn_blame`** — `{ cwd?, path: string, revision?: Revision, maxLines?: number = 100, cursor?, showEolChanges?: boolean = false }`
Runs XML blame with `-x --ignore-eol-style` by default so historical EOL rewrites do not steal line
attribution. `showEolChanges:true` explicitly includes that churn.
Runs XML blame for one contained path and returns bounded `{line, revision, author, date}` entries.
It omits file text by design; callers use `svn_cat` only for the file page they actually need.

**`eol_check`** — `{ cwd?, paths: string[], includePassing?: boolean = false, countOnly?, maxItems?, cursor? }`
Pure read: batched `svn propget svn:eol-style --xml` + async byte sniff (cap 5 MB, larger →
`sniff:"skipped-too-large"`; NUL byte in first 8 KB → `kind:"binary"`; directory or other
non-file target → `kind:"not-a-file"`, never a thrown error). Extra per file:
`{ path, kind: "crlf"|"lf"|"mixed"|"none"|"binary"|"not-a-file", eol_style: string|null,
has_bom: boolean, mismatch: boolean }`. `mismatch` = text file whose working EOL does not match `svn:eol-style`
(`native` resolves to platform-native CRLF on Windows and LF elsewhere; explicit `LF`/`CRLF`
resolve literally). Files with no line breaks (`kind:"none"`) are not mismatches. Compact output
returns counts and failing paths only unless `includePassing:true` is requested. Result pages
default to 100 items and expose `nextCursor` when more remain.

**`svn_propget`** — `{ cwd?, paths: string[], name: string, fields?: ("path"|"name"|"value")[], maxValueChars?, countOnly?, maxItems?, cursor? }`
Pure read: `svn propget --xml -- <name> <paths…>`. Property names are bounded to ordinary SVN
property-name characters (`A-Za-z0-9_.:-`, starting with a letter/underscore). Extra:
`properties:[{path,name,value}]` and `missing_paths:string[]`; absent properties are
successful reads with missing targets listed in `missing_paths`, not fatal SVN failures.
When a batch has mixed presence, `properties` contains the found values and `missing_paths`
contains only the absent targets. Purpose:
let clients inspect property-only slices without dropping to raw SVN or special-casing only
`svn:eol-style`. Compact property values default to a 4,096-character cap, redact credential-like
URL content, and page found/missing results with explicit counts and continuation.

**`svn_self_check`** — `{ cwd?, detailed?: boolean = false }`
Pure read/self-diagnostic tool. Reports MCP package/runtime version, `current` junction target,
whether `current` matches the package version, release `bin` and `dist` payload counts, startup
probe results for bundled tools, whether the bundled SVN/EOL toolchain is healthy, and whether
release/clean scripts use the Node-based paths. Compact output normally returns only version,
availability, and short diagnostics; `detailed:true` includes counts and capabilities without
machine paths. Request full mode when executable and release-layout paths are required.
Prepared source clones use `current -> releases/v<version>`; npm installations are valid with
package-root `dist/` and `bin/` and no generated junction. For npm-package layouts,
`current_pointer_applicable:false` and `current_matches_package:null`; pointer state does not reduce
health. Prepared-release layouts continue to require a matching, complete `current` target.
Unprepared source trees remain invalid.
The live toolchain probe remains authoritative: Windows normally resolves bundled executables,
while macOS and Linux resolve native commands from `PATH`. Purpose: avoid manual checks for ignored
`current` drift, npm layout false alarms, and noisy release payload adds.

**`svn_diagnose`** — `{ cwd?, paths?: string[] }`
Pure read working-copy diagnostic tool. Runs startup SVN availability, then local status, remote
status with `--show-updates`, `svn info -r HEAD`, and latest-log reachability checks against the
resolved working copy/targets in parallel. Extra fields: `health:"healthy"|"warning"|"error"`,
`svn_available`, `working_copy_valid`, `wc_root`, `remote_accessible`,
`checks:[{name, ok, command, note}]`, and `suggestions:string[]`. Purpose: collapse common
SVN failure triage into one structured call without changing the working copy or clearing
credentials.

**`svn_lock_status`** — `{ cwd?, paths: string[], maxItems?: number = 100, cursor? }`
Read-only lock inspection. It runs local `svn info --xml` for token possession and repository URL
`svn info --xml` for current lock state. Each bounded row contains a working-copy-relative path,
repository-relative path, `repository_locked`, owner, created, expires, bounded comment, optional
workstation label, `local_token_possession`, and a state. Tokens are compared internally and never
returned. States include `unlocked`, `held-local`, `held-elsewhere`, `orphaned-token`, and
`stale-candidate`; a stale candidate is a lock at least seven days old. Pages contain at most 500
rows and expose `next_cursor` when more paths remain. This tool is available in READONLY mode.

### 8.2 (reserved)

### 8.3 Composite tools (the P1 killers)

**`svn_snapshot`** — `{ cwd?, paths?: string[], includeIgnored?, hideNoise?, statuses?, includeUnversioned?, countOnly?, maxItems?, cursor?, afterCursor?, captureBaseline?: boolean = false }`
Combines working-copy revision metadata with bounded status counts, conflicts, and relative changed
items in one response. It performs no mutation and is available under READONLY. Snapshot tokens use
the same `afterCursor`/`NO_CHANGE` contract as status and additionally bind revision/head/range state.
`captureBaseline:true` requires one to 500 explicit files and returns `baseline_token`, expiry, and
path count. The opaque token binds exact status, base revision, file kind, SHA256 content identity,
repository policy, remote revision, working copy, and scope. Directories are refused.

**`svn_precommit`** — `{ cwd?, paths: string[], lineLimit?: number = 200, includeDiff?: boolean = false, allowRoot?: boolean = false, allowDirectoryTargets?: boolean = false, expandDescendants?: boolean = false, requireUniformRevision?: boolean = false, baselineToken?: UUID }` *(read-only; allowed under READONLY)*
One call = scoped status + scoped ignore-EOL diff + `eol_check` + G4/G5/G6 dry evaluation +
mixed-revision check. Extra fields:

```jsonc
{
  "verdict": "READY" | "EOL_FIX_NEEDED" | "GUARD_BLOCKED" | "NOTHING_TO_COMMIT" | "DIFF_FAILED" | "REVISION_NORMALIZATION_NEEDED",
  "per_file": [{ "path": "...", "status": "M", "added": 12, "removed": 3,
                 "binary": false, "property_changed": false,
                 "eol": "crlf", "eol_style": "native", "bom": false,
                 "pure_eol_churn": false, "guard": null }],
  "risk_signals": ["build-system file touched"],   // what svn_commit will demand riskAck for
  "diff_excerpt": "...", "truncated": true
}
```

Verdict rules (first match): any G3/G4 hit, ignored path, or listed-but-clean path → `GUARD_BLOCKED` (offender
named in `guard`); `svn_diff` failure with `recovery_tool:"eol_fix_verified"` →
`EOL_FIX_NEEDED`; other `svn_diff` failure → `DIFF_FAILED`; any text file with `mismatch` or
`pure_eol_churn` → `EOL_FIX_NEEDED`; no path with a real change → `NOTHING_TO_COMMIT`; else
`READY`. `pure_eol_churn` = file shows as modified in status but its ignore-EOL diff is empty.
When `requireUniformRevision:true`, an otherwise ready mixed-revision working copy returns
`REVISION_NORMALIZATION_NEEDED`, `ok:false`, its revision range, and remediation to run a pinned
`svn_update` from the working-copy root before repeating precommit. The default remains
non-blocking for compatibility.
Intended flow: **precommit → (review summary; fetch full per-file diff only if a count looks
wrong) → commit.** Two round trips.

For EOL failures, use the verified recovery sequence **`eol_check` → `eol_fix_verified` →
`svn_diff(ignoreEol:true)`** before repeating precommit. `eol_check` records LF, mixed-EOL, and BOM
evidence. `eol_fix_verified` applies the repository target, verifies canonical LF/no-BOM content,
preserves a concurrent edit instead of overwriting it, and runs an ignored-EOL diff. A final
`svn_diff(ignoreEol:true)` must show no unintended content or property change before commit.

Compact mode returns one authoritative receipt: path count, status counts, diff totals, EOL and
mixed-revision verdicts, guard failures, and `ready`. It omits the diff excerpt unless
`includeDiff:true` is requested. An early setup/status failure returns a compact diagnostic instead
of implying that diff or EOL checks passed.
It also returns `eolCheckComplete:true` and a SHA256 `eolPolicyIdentity` over the checked target and
exclude policy, allowing a caller to avoid a redundant standalone EOL check for the same slice.
Working-copy-root and existing-directory targets use the same `allowRoot` and
`allowDirectoryTargets` acknowledgements as `svn_commit`, so `READY` does not contradict those
target-scope guards for the same requested slice.
With `expandDescendants:true`, each explicit existing directory is replaced by all changed paths
under that directory. The expansion is capped at 500 paths, physically rechecked for working-copy
containment, sorted, returned as `expanded_paths`, and subjected to every normal guard. A clean
directory returns `NOTHING_TO_COMMIT`. Without this flag, directory-node behavior is unchanged.
A READY result stores and returns `precommit_token` plus expiry. The token is bound to the exact
resolved scope, current status, base revisions, content and SVN property hashes, repository/EOL policy identities,
diff identity, and observed remote revision. Supplying `baselineToken` also validates the baseline
scope/policy and returns bounded paths changed since that pre-edit state. The token never bypasses
commit guards and expires with process-local evidence. Path state is captured before and after the
checks; a concurrent local change refuses token issuance. Commit recomputes the bound diff while
confirming the path state stays stable.

**`svn_commit operation:"prepare"`** — `{ cwd?, paths: string[], operation: "prepare", revision: numeric-string, expectedRemoteHead?: integer, baselineToken?: UUID, lineLimit?, allowRoot?, allowDirectoryTargets?, expandDescendants?, requireUniformRevision?, operationId?: UUID }` *(mutating update; refused under READONLY; never commits)*
One call preflights root, directory, containment, expansion, and never-commit guards, records scoped
local status, runs `svn update -r <revision> --accept postpone -- <paths...>`, refuses a changed
expected remote HEAD, refuses any update result outside the explicit file or directory scope, stops
on postponed conflicts, and runs `svn_precommit` on the same intended paths. A node-only directory
acknowledged with `allowDirectoryTargets:true` updates with `--depth empty`; expanded directories
update recursively and are guarded again after the update.
The receipt includes `requested_revision`, `resulting_revision`, `revision_range`, `mixed_revision`,
`updated_paths`, `unexpected_touched_paths`, and `final_commit_scope`. The exact numeric revision is
required so a later repository commit cannot move the prepared slice beyond the intended build or
release revision.
When `baselineToken` is supplied, prepare also refuses any same-path local/remote overlap detected
by the update, including a clean SVN merge that did not produce a text conflict.
Compact/receipt output keeps at most 25 paths per prepare collection and reports the corresponding
total and truncation flag. Full mode retains the complete bounded evidence.
The hidden `svn_prepare_commit` route has the same implementation for known full-profile callers.
It is omitted from discovery so preparation and later safe-commit orchestration can share the one
canonical `svn_commit` schema.

**`svn_commit operation:"safe"`** — `{ cwd?, paths: string[], operation: "safe", message: string, revision: numeric-string, expectedRemoteHead: integer, baselineToken?: UUID, operationId: UUID, riskAck?, lineLimit?, allowRoot?, allowDirectoryTargets?, expandDescendants?, requireUniformRevision? }` *(mutating; refused under READONLY)*
One durable operation performs: guarded pinned prepare → baseline overlap/conflict refusal → batch
verified EOL repair only when precommit reports explicit failing files → bound READY precommit →
guarded commit → pinned update of the committed scope to the committed revision → final scoped
snapshot. Invalid messages, missing evidence, changed policy/content/remote revision, unexpected
update paths, same-path overlap, and postponed conflicts stop before commit. Ordinary commit guards
remain authoritative.
When `baselineToken` is omitted, safe mode captures the current explicit-file state immediately
before update and uses local SVN status plus remote update touches for collision detection. A
caller-supplied pre-edit token additionally proves which content changed since editing began.
Paths already scheduled for addition are not valid `svn update` operands. Safe mode skips only
those operands during its pinned update, still verifies the expected repository HEAD, and keeps
every scheduled-added path in the exact precommit and commit scope.
The compact result reports only verdict, committed revision/paths, final scoped cleanliness,
scope-uniform revision evidence, durable operation ID, and an optional detail evidence ID. Detailed
stage envelopes stay in the bounded process-local evidence store. `operation:"detail"` with the
same explicit paths, returned `detailOperationId`, decimal cursor, and bounded `maxChars` pages that
evidence without rerunning SVN. The safe and detail modes add no advertised tool.

**`eol_fix_verified`** — `{ cwd?, path?: string, paths?: string[], target?: "crlf"|"lf", removeBom?: boolean = true, dryRun?: boolean = false, allowLarge?: boolean = false, operationId?: UUID }` *(mutating; refused under READONLY)*
One call = read `svn:eol-style`, infer the target (`native` → platform native, `LF` → lf,
`CRLF` → crlf, no property → platform native), execute the real converter via `execFile`
(`unix2dos` for crlf / `dos2unix` for lf; `--remove-bom` when `removeBom`) on one file,
then automatically re-run the ignore-EOL diff on it. Clients normally pass only `{path}` when
using absolute paths; `cwd` is optional and mainly for relative paths.
Extra: `{ before: {kind, has_bom}, after: {kind, has_bom}, target, eol_style, converter,
verification_command, diff_ignored_eol:true, pure_eol_churn: boolean }` —
`pure_eol_churn:true` is the proof the fix changed nothing but line endings. `dryRun:true`
reports `before` + inferred converter/target, touches nothing. Safe-commit mode may invoke the same
batch operation only after precommit names explicit EOL failures; ordinary tools never repair
tracked files implicitly. Missing paths, non-files, binary files,
and `sniff:"skipped-too-large"` files return structured refusals; oversized files require
explicit `allowLarge:true`, then use streaming sniff/hash verification plus a disk-backed backup.
Never-commit guards run before any conversion. A failed verification restores the backup only when
the converted file still has the expected identity; a concurrent edit is preserved and reported.
No PowerShell scripts, byte rewrites, pipes, redirects, or shell
quoting are involved. `svn_add` may apply the same verified conversion transactionally when the
repository policy enables `normalizeEol`; existing tracked-file repair remains an explicit call.
`paths` accepts up to 500 explicit files and returns one aggregate receipt. Passing files are
counted; failures retain bounded per-file evidence. Directories and implicit working-copy scans are
refused. SHA256 over canonical LF/no-BOM content proves EOL conversion preserved content.

Complete recovery example:

```text
eol_check(paths:["src/example.cs"]) → kind:"lf", has_bom:true, mismatch:true
eol_fix_verified(path:"src/example.cs") → after.has_bom:false, pure_eol_churn:true
svn_diff(paths:["src/example.cs"], ignoreEol:true) → no unintended content/property changes
```

The sequence is bounded to explicit paths. Never-commit guards run before repair, and a concurrent
edit is preserved and reported rather than overwritten.

### 8.4 Mutating tools (all refused under READONLY)

**`svn_add`** — `{ cwd?, paths: string[], allowRecursive?: boolean = false }`
argv: `svn add --parents --depth empty -- <paths…>` (files); intermediate parent directories are
scheduled as needed without recursively adding siblings. A directory path requires
`allowRecursive:true` (then `--parents --depth infinity`). G4 enforced — can't add what may never be committed
(`scratch/**` is reserved for local scratch files; never add).
When repository policy sets `normalizeEol:"crlf"` or `"lf"`, new text files in the explicit add
scope are backed up, converted, and content-hash verified before SVN scheduling. Any failure restores
converted files that have not changed concurrently and prevents the add; concurrently changed files
are preserved and reported as rollback-skipped. Binary files and `eolExclude` globs (defaulting to
`**/*.patch` and `**/*.diff`) are skipped and reported.

**`svn_lock`** — `{ cwd?, paths: string[], comment: string, workstationLabel?: string, force?: boolean, forceAck?: boolean, operationId?: UUID }`
Guarded repository lock. The comment must be non-empty and the workstation label must come from
the input or `SVN_MCP_WORKSTATION_LABEL`, using one to 64 `[A-Za-z0-9._-]` characters. The
repository comment is bounded and stored as `[svn-agent-mcp workstation=<label>] <comment>`.
Normal calls run `svn lock -F <secure-temp-file> -- <paths…>`; the temporary file is always
deleted. `force:true` adds `--force` only when `forceAck:true` and a valid UUID `operationId` are
present. The operation receipt fingerprint binds normalized paths, comment, label, and force state.
Never-commit, containment, and READONLY guards run before SVN.

**`svn_unlock`** — `{ cwd?: string, paths: string[], force?: boolean, forceAck?: boolean, operationId?: UUID }`
Guarded repository unlock. Before a normal `svn unlock`, the tool compares the local working-copy
lock token with the current repository URL lock token. It refuses when the repository is locked but
this working copy does not hold the matching token, even when the SVN username is the same. A
forced unlock requires `force:true`, `forceAck:true`, and a valid UUID `operationId`; only then may
`--force` be emitted. Durable receipts bind normalized paths and force state and replay terminal
results without repeating SVN.

**`svn_needs_lock`** — `{ cwd?: string, paths: string[], action: "set"|"remove", riskAck?: boolean, operationId?: UUID }`
Guarded property mutation for regular versioned files only. `action:"set"` runs
`svn propset -- svn:needs-lock * <paths…>`; `action:"remove"` runs
`svn propdel -- svn:needs-lock <paths…>` and requires `riskAck:true`. Durable operation receipts
bind normalized paths, action, and acknowledgement state. All normal mutation guards apply and
READONLY refuses both actions.

**`svn_commit`** — `{ cwd?, paths: string[], operation?: "commit"|"prepare"|"safe"|"detail" = "commit", message?: string, revision?: numeric-string, expectedRemoteHead?: integer, baselineToken?: UUID, precommitToken?: UUID, detailOperationId?: UUID, cursor?, maxChars?, riskAck?: boolean = false, allowRoot?: boolean = false, allowDirectoryTargets?: boolean = false, expandDescendants?: boolean = false, operationId?: UUID }`
Sequence: G1→G6 checks → message format check against §5.8 template (subject + blank second line +
at least one `- ` verification bullet; deviation → typed refusal before SVN) → write message to temp
file **outside the WC** (secure temp dir, UTF-8 **no BOM**, leading BOM stripped) → argv:
`svn commit -F <tmpfile> --depth empty -- <paths…>` → delete tmpfile (always, incl. on failure) →
parse `Committed revision N.` → run scoped `svn status --xml -- <paths…>`.
`riskAck:true` is required when the explicit commit scope has more than 8 paths or another G6
mechanical signal. Exactly 8 paths does not require acknowledgement for the path-count signal.
Compact `OUT_OF_DATE` refusals identify bounded `outOfDatePaths`, `outOfDatePathCount`, and
`outOfDatePathsTruncated` fields, while retaining `workingCopyMixed` and `revisionRange` when both
conditions are present.
If an explicit file path is under newly-added parent directories, the commit argv includes only
those scheduled-added ancestors plus the explicit path, so the caller does not need to name parent
directories manually.
Extra: `{ revision, post_status_clean: boolean, risk_signals: string[] }`. Mixed-revision WC →
warning in `note`, commit proceeds (D3).
`postStatusClean` is the compatibility field for the committed path scope only. The receipt also
publishes `postStatusScope:"committed-paths"`, bounded `postStatusPaths`, and separate
`workingCopyClean` evidence from a whole-working-copy status check. These fields remove ambiguity;
`postStatusClean` is not deprecated in 1.6.0.
Whitespace-only messages are refused. Naming the working-copy root is refused unless
`allowRoot:true`. Existing directory targets are refused unless `allowDirectoryTargets:true`
explicitly acknowledges that `--depth empty` commits only the directory node and excludes changed
descendants. Explicit child paths remain the normal scoped workflow. A changed descendant outside
the committed scope makes `workingCopyClean:false`; call `svn_status` when its path detail is needed.
With `expandDescendants:true`, existing directory inputs expand to the bounded, sorted set of all
currently changed descendants. The exact expanded list is returned and every descendant receives
the same containment, never-commit, status, conflict, and risk checks as an explicitly named path.
When `precommitToken` is supplied, commit proves that exact scope, file state, repository policy,
and observed remote revision still match the READY evidence, then repeats that proof immediately
before invoking SVN. A mismatch is a typed refusal; the token never substitutes for G1-G6. This
does not freeze files against an unrelated external editor, so one writable process per working
copy remains an operating boundary.

**`svn_path_change`** — `{ cwd?, action: "move"|"rename"|"copy", src: string, dest: string }`
argv: `svn <move|copy> --parents <src> <dest>`; `rename` uses SVN's `move` operation. Working-copy
path to working-copy path only; repository URL forms are refused because URL mutations create
revisions immediately and require message-file handling. `src` must exist and both paths must
resolve inside the working copy. Intermediate destination directories are created and scheduled by
SVN. G4 applies to both paths. The receipt reports the requested action plus scoped changed paths.
Committing a move or rename normally requires both old and new paths; because the old path is
scheduled delete, `svn_commit` requires `riskAck:true` by G6.

The legacy `svn_move`, `svn_rename`, and `svn_copy` routes remain callable in the full profile for
compatibility but are omitted from tool discovery. They have the same guards and behavior as the
corresponding `svn_path_change` action.

**`svn_update`** — `{ cwd?, paths?: string[], updateAll?: boolean = false, revision?: Revision, expectedRemoteHead?: integer, baselineToken?: UUID, maxItems?, cursor?, taskPaths?, targetOverlapOnly?, operationId?: UUID }`
Refuses unless `paths` non-empty or `updateAll:true` (deliberate friction; the operator-request
requirement in §5.2 remains the caller's responsibility). argv:
`svn update [-r <revision>] --accept postpone [paths…]`. Revision ranges are refused. An optional
`expectedRemoteHead` requires a numeric `revision` and refuses before mutation unless current
repository HEAD still matches the caller's value; the numeric `-r` keeps the operation pinned even
if HEAD advances after the check. Parses multi-column update output + "Summary of conflicts" →
`changed_paths` + `conflicts`; any conflict ⇒ prominent `note`. Returns `requested_revision`,
`resulting_revision` (null for a mixed WC), `revision_range`, and `mixed_revision`. Never auto-resolves.
Compact receipts include paged working-copy-relative `changedPaths`, complete conflicts, action
counts, changed top-level folders, and total changed count. `taskPaths` highlights overlap with the
caller's explicit work; `targetOverlapOnly:true` returns only that overlap plus an unrelated-change
count. `maxItems` is capped at 500 and `cursor` continues the changed-path page.
Top-folder summaries are capped at 25 with explicit total/truncation fields. Conflict paths use their
own 100-item `conflictCursor` pages and are never silently omitted.
Any nonzero or past-end changed-path cursor retains `changedCount`, `changedPathCount`, `pageOffset`,
and bounded top-folder context; past-end pages add `cursorPastEnd:true`.
`baselineToken` requires the same explicit files used to capture the baseline. The update returns a
bounded per-path receipt with baseline revision, local modification before update, remote touch,
same-path collision, postponed conflict, and remediation. It does not change SVN's successful
merge semantics, but prepare and safe modes treat a reported collision as a commit blocker.
Exact-file updates publish `scopeKind:"exact-file"`, `scopeComplete:false`, bounded
`omittedRepositoryAdditions`, and `recommendedAction:"update-containing-directory"`; the exact-file
scope is not directory-complete even when no sibling is currently omitted. Directory and
working-copy updates publish their selected `scopeKind` and can report `scopeComplete:true` when the
selected scope is complete. `scopeCheckUnavailableReason` explains bounded comparison failures.
If the bounded SVN metadata probe cannot classify every target, `scopeKind:"unknown"` and
`scopeComplete:false` state that completeness was not proven. The receipt includes a bounded
`scopeCheckUnavailableReason` and `recommendedAction:"inspect-target-metadata"`; any omitted-addition
count is non-authoritative in this state.

**`svn_revert`** — `{ cwd?, paths: string[], allowRecursive?: boolean = false, dryRun?: boolean = true, riskAck?: boolean = false }`
`dryRun:true` (default) = preview: returns scoped status + per-file ± counts of what would be
**lost**, changes nothing. `dryRun:false` → argv `svn revert <file paths…>` for files and a
separate `svn revert --depth infinity <directory paths…>` for directories; a directory or `.`
requires `allowRecursive:true`, and every executing call requires `riskAck:true` after preview.
Reverting the WC root path is refused unconditionally.

**`svn_delete`** — `{ cwd?, paths: string[], allowRecursive?: boolean = false, dryRun?: boolean = true, riskAck?: boolean = false }`
The default returns the exact contained targets without changing the working copy. Execution
requires `dryRun:false` and `riskAck:true`; directories additionally require
`allowRecursive:true`. The working-copy root is always refused, `--force` is never emitted, and a
successful schedule-delete is followed by scoped status verification for `D` entries.

**`svn_resolve`** — `{ cwd?, path: string, accept: "working"|"mine-full"|"theirs-full"|"base", operationId?: UUID }`
argv: `svn resolve --accept <accept> <path>`. Single path; `accept` has **no default** — the
caller must state the resolution. Intended only after an operator asked for conflict resolution.
The legacy `svn_resolved` route remains callable in the full profile as a deprecated compatibility
alias but is omitted from tool discovery.

**`svn_cleanup`** — `{ cwd?, path?: string }`
argv: `svn cleanup [path]` — releases stale WC locks (the `E155004` remedy). **Never** passes
`--remove-unversioned`, `--remove-ignored`, or `--vacuum-pristines`. Mutating classification
(refused under READONLY) because it rewrites WC metadata.

**`svn_propset_eol_style`** — `{ cwd?, paths: string[], style?: "native"|"LF"|"CRLF" = "native" }`
argv: `svn propset -- svn:eol-style <style> <paths…>`. Guard: the prop is checked via propget
first and **already-correct targets are skipped** — only missing or mismatched targets are
written; when every target already matches, the call succeeds as a no-op with an
"already <style> on all paths" note (preserve-existing rule, §5.6). Never-commit guards apply to
every target. Rarely needed once §10.2 lands.

**`svn_propset`** — `{ cwd?, paths: string[], name: string, value: string, riskAck?: boolean = false }`
argv: `svn propset -F <tmpfile> -- <name> <paths…>`. The bounded value is written to a mode-0600
temporary file outside the working copy and removed in `finally`, so it is not echoed in the
displayed process command. Guard: explicit existing paths inside one working
copy, READONLY refusal, never-commit target checks, bounded property names/values. `riskAck:true`
is required for high-risk properties that can hide or redirect repository behavior:
`svn:ignore`, `svn:global-ignores`, `svn:externals`, and `svn:auto-props`.

**`svn_export`** — `{ cwd?, src: string, dest: string, revision?: string, externalDestAck?: boolean }` /
**`svn_import`** — `{ cwd?, src: string, url: string, message: string }`
argv: `svn export [-r rev] <src> <dest>` / `svn import -F <tmpfile> <src> <url>`. Explicit
src+dest/url; `svn_export` validates revision strings before invoking SVN, and `svn_import`
scans the source tree for never-commit descendants before invoking SVN. `svn_import` uses the
same commit-message format validation and secure `-F` tempfile mechanics as commit. Purpose: MCP
release packaging. These tools intentionally support external filesystem paths: export may write to an explicit destination
  outside a working copy only with `externalDestAck:true`, and import may read an explicit external
  source after its bounded guard scan skips SVN administrative directories. READONLY mode refuses both.

## 9. Edge cases (defined so no doubts remain)

- `paths: []` where required → `ok:false`, `note:"explicit paths required"`.
- Nonexistent path → `ok:false`, naming the path (fail before spawning svn).
- Path outside WC root → G3 refusal.
- WC locked (`E155004`) on any tool → mapped note pointing at `svn_cleanup` (§6.6).
- Binary file in `svn_diff`/`eol_check` → flagged `binary`, never sniffed/converted; `eol_fix_verified` on a binary → refusal.
- File > 5 MB in `eol_check` → prop still reported, byte sniff skipped with note.
- Diff larger than `lineLimit` → excerpt + `truncated:true`; per-file counts always complete (counted while streaming, not from the excerpt).
- Two svn-agent instances on one WC → fine: svn handles concurrent readers; the only writer is the non-READONLY instance, and svn's own wc locking covers overlap.
- Message containing `"""`, backticks, non-ASCII → irrelevant: message goes through a file (`-F`), never a shell string. Process launches never use a shell, so there is no shell interpolation.
- Commit succeeds but post-status shows residue → `post_status_clean:false` + note (caller decides).
- svn prints warnings on stderr with exit 0 → `ok:true`, stderr preserved in `stderr_summary`.

## 10. Companion fixes outside the MCP (part of the plan, not the server)

### 10.1 EOL handling

EOL remediation belongs inside this MCP. New files are normalized automatically when repository
policy enables `normalizeEol`; callers use batch-capable `eol_fix_verified` for tracked files.
the MCP infers the target from `svn:eol-style`, runs bundled `unix2dos`/`dos2unix` directly via
`execFile`, and rechecks the ignored-EOL diff. Do not install or generate PowerShell EOL
hooks/scripts for this workflow.

### 10.2 Repo-dictated auto-props — *one commit at the repository root, maintainer approval*

SVN ≥1.8 inherited property; every 1.8+ client then auto-applies on `svn add`, no client config.
This is an example policy; repositories should adapt patterns to their own text files:

```
svn propset svn:auto-props "*.cs = svn:eol-style=native
*.xaml = svn:eol-style=native
*.csproj = svn:eol-style=native
*.config = svn:eol-style=native
*.props = svn:eol-style=native
*.targets = svn:eol-style=native
*.md = svn:eol-style=native
*.resx = svn:eol-style=native
*.ts = svn:eol-style=native
*.js = svn:eol-style=native
*.json = svn:eol-style=native" <REPOSITORY_ROOT>
svn commit -F <msgfile> <REPOSITORY_ROOT>   # prop-only commit
```

### 10.3 Defender exclusion — *operator decision (security trade-off), admin shell*

```powershell
Add-MpPreference -ExclusionPath '<WORKING_COPY_ROOT>'
```

Measure before/after: `Measure-Command { svn status <PROJECT_ROOT>\src }`. Expected 2–10× on
file-heavy svn ops. Trade-off: files under the path are not scanned on access. No process-level
exclusions.

### 10.4 Host approval settings

The npm package does not edit user or host configuration. Keep Codex approval settings outside the
repository. For a persistent server-scoped configuration, use:

```toml
approval_policy = "never"

[mcp_servers.svn]
default_tools_approval_mode = "approve"
```

All registered SVN tools, including hidden compatibility routes, advertise
`annotations.destructiveHint=false`. A central canonical read-only set advertises accurate
`readOnlyHint` values for diagnostics, status/info/snapshot, diff/log/cat/blame, EOL checks,
property reads, precommit, and lock status. These annotations do not replace the MCP's READONLY,
containment, never-commit, risk acknowledgement, or durable receipt guards.

## 11. Historical development phases

Phases 1-4 are complete in the shipped v1.0.0 baseline. This section remains as traceability
for why the implementation was built in this order and how future release phases should be
gated.

**Phase 0 — no-code quick wins** *(operator executes/approves; independent of the MCP)*
0a Defender exclusion (§10.3) · 0b repo auto-props (§10.2) · 0c interim allowlist (§10.4).
Gate: Defender win measured with before/after `Measure-Command`; EOL repair is verified through
`eol_fix_verified`, not an external hook.

**Phase 1 — scaffold + read-only tools**
`package.json` (ESM, Node 24 LTS and npm 11 engines), `tsconfig` (strict, ES2022), deps per D12;
`runner`, `envelope`, `guards`, XML parsers; tools `svn_status`, `svn_info`, `svn_diff`,
`svn_log`, `eol_check`; startup probe.
Gate: jest unit tests green (guard matrix, envelope shape, parser fixtures incl. locale-odd and
truncated outputs); manual smoke of all five tools against a sample working copy (read-only).

**Phase 2 — composite tools**
`svn_precommit`, `eol_fix_verified`.
Gate: integration tests on a **throwaway temp repo** (`svnadmin create` + `file:///` checkout in
a temporary directory — never a production working copy): LF-damaged file → precommit `EOL_FIX_NEEDED` → fix →
`pure_eol_churn:true` → precommit `READY`. Unit tests for verdict precedence and per-file
counting.

**Phase 3 — mutating tools**
All §8.4 tools. Gate: temp-repo integration matrix — commit happy path (`-F` file used and
cleaned up; revision parsed; post-status clean), every guard refusal (G1–G7, incl. commit
without riskAck on a 9-file slice, revert of WC root refused, update without paths/updateAll
refused), READONLY instance refuses every mutating tool + `eol_fix_verified`. **No mutating
test ever touches a production working copy.**

**Phase 4 — release + registration**
`tsc` build → `npm run release:prepare` copies `dist` and source-tree `bin` to
`releases\v<version>\`, validates payload counts, and repoints the `current` junction without
PowerShell wildcard/copy commands → register:
write-capable client: `<client mcp add svn> node <MCP_HOME>\svn-agent\current\dist\index.js`;
read-only client config:
```toml
[mcp_servers.svn]
command = "node"
args = ["<MCP_HOME>\\svn-agent\\current\\dist\\index.js", "--readonly"]
```
Also: final allowlist (§10.4) and optional auto-props commit (§10.2, maintainer approved).
Gate: from a sample write-capable client session, `svn_precommit` on a touched path returns a
correct verdict; from a read-only client session, `svn_status` works and `svn_commit` refuses
with the READONLY note.

**Phase 5 — retire the manual workflow**
Slim `docs/svnrules.md` to "use the `svn` MCP tools; raw svn only where the MCP has no tool",
keeping the policy prose as the reference the MCP encodes. Maintainer-approved docs edit.
Gate: one full sample commit slice executed end-to-end through the MCP (precommit → commit),
2 round trips, zero prompts on the read path.

## 12. Historical definition of done (v0.1.0)

1. All Phase 1–4 gates green; jest suite green; zero mutating-tool tests against production working copies.
2. A sample working-copy slice committed via `svn_precommit` + `svn_commit` in 2 calls, with correct
   revision + clean post-status in the envelope.
3. Read-only instance demonstrably refuses mutating tools.
4. EOL hook + (if approved) auto-props live → a week of normal work produces zero EOL
   remediation loops.
5. This SPEC.md updated only via a new version header (spec changes are deliberate, not drift).

## 13. Out of scope / future

Branch, switch, merge, relocate (future candidates, each with its own guard design);
changelist support; any Git interop; any mass
reformatting, ever. Project build/test time can dominate total slice time, but it is not SVN
housekeeping — separate initiative.

## 14. Change Log

The complete release history lives in `../CHANGELOG.md`. Spec-affecting changes:

### Spec 1.36 / v1.6.0 — 2026-08-08

- Fixes path-scoped remote-head evidence, standard EOL response summaries, out-of-date path
  diagnostics, scoped companion-file update evidence, and post-commit scope wording (#48–#52).
- Documents the bounded native-SVN fallback for harness empty replies (#53).
- Publishes the commit-message contract and the `svn_commit` more-than-8-path `riskAck:true`
  threshold in affected tool descriptions (#54–#55).
- Defines `workingCopyMixed:true`, nullable `baseRevision`, and `baseRevisionRange` as expected
  parallel-agent evidence, not a failure by itself (#56).
- Preserves and documents the verified LF/BOM EOL recovery workflow and ignored-EOL proof (#57).

### Spec 1.35 / v1.5.0 — 2026-08-04

- Adds guarded `svn_lock`, `svn_unlock`, and read-only `svn_lock_status` for shared working-copy
  workflows. Normal unlock compares local and repository lock tokens internally and refuses a
  mismatched token; forced lock/unlock requires explicit acknowledgement and a UUID operation ID.
- Adds guarded `svn_needs_lock` for regular versioned files, with `riskAck:true` required for
  removal. Durable lock receipts bind normalized paths, comments, labels, actions, and force state.
- Bounds and redacts lock metadata, adds held-elsewhere/orphaned-token/stale-candidate diagnostics,
  and keeps lock tokens out of all public response modes.
- Publishes `destructiveHint=false` for every registered tool and accurate central read-only hints.
  Host approval configuration remains external to the package.

### Spec 1.34 / Unreleased — 2026-08-02

- Caps compact log serialization at 24 KiB and rejects decimal cursors above JavaScript's safe
  integer range before paging or constructing SVN revision arguments.
- Uses bounded-concurrency, aggregate-capped content hashing and asynchronous receipt-lock waits.
- Makes verified EOL repair streaming and never-commit guarded, preserves concurrent edits during
  rollback, validates import messages, and requires explicit risk acknowledgement for real reverts.
- Removes pathless tree-conflict placeholders and documents that stale mutation outcomes always
  fail closed instead of being inferred from repository history.

### Spec 1.33 / Unreleased — 2026-08-02

- Makes prepared releases self-contained with an adjacent package manifest and validates that
  manifest in self-check.
- Bounds process output, streamed parser callbacks, per-file previews, evidence metadata, operation
  receipts, asynchronous workflow hashing, and stored diff summaries; process cancellation and
  timeouts terminate complete process trees.
- Fixes deletion verification, multi-path logs, exact property values, snapshot-token state,
  update receipts, lock parsing, and credential/path input validation.
- Makes ambiguous stale commits fail closed and revalidates READY evidence immediately before SVN.
- Validates prepared-release pointers by canonical path, isolates test receipts from live state, and
  recovers abandoned lock-break coordination files after their bounded stale interval.

### Spec 1.32 / v1.4.0 — 2026-08-02

- Adds explicit-file pre-edit baseline tokens and path-level local/remote collision receipts on
  pinned updates without adding an advertised tool schema.
- Makes READY precommit evidence reusable through a short-lived token bound to exact scope,
  content, status, base revisions, policy, diff identity, EOL verdict, and remote revision.
- Adds durable `svn_commit operation:"safe"` orchestration plus bounded cursor-paged detail,
  retaining every existing guard and stopping before commit on changed or overlapping evidence.

### Spec 1.31 / Unreleased — 2026-08-02

- Adds optional durable UUID operation receipts for update, commit/prepare, EOL repair, and conflict
  resolution without adding advertised schemas.
- Binds each ID to normalized inputs, replays identical terminal results across MCP restarts, and
  refuses concurrent, mismatched, unreadable, incomplete, or ambiguous stale operations.
- Makes interrupted commit outcomes fail closed; message/time history similarity is not sufficient
  proof that a particular operation performed a revision. Unfinished receipts are never blindly
  re-executed.
- Physically excludes working-copy storage, cleans bounded terminal/orphan evidence, and refuses new
  work rather than pruning protected ambiguous records when store capacity is exhausted.

### Spec 1.30 / Unreleased — 2026-08-02

- Adds bounded `expandDescendants:true` commit scopes while preserving the default directory-node
  refusal and opt-in node-only behavior.
- Adds `svn_commit operation:"prepare"` for pinned explicit-path update, expected-HEAD verification,
  unexpected-path refusal, conflict postponement, and final precommit evidence without committing,
  without increasing the advertised tool count.
- Requires all commit-scope guards before prepare mutates the WC, preserves node-only update depth,
  evaluates expanded-file risk signals, and keeps unexpected-path failure evidence bounded.

### Spec 1.29 / Unreleased — 2026-08-02

- Adds query-bound status/snapshot `NO_CHANGE` tokens and bounded operation evidence for stable
  diff continuation without rerunning SVN.
- Adds diff totals and hunk-heading modes, bounded log filtering/action summaries, update overlap
  summaries, and precommit EOL-policy proof.
- Publishes high-volume controls once in the generated contract to retain strict schema budgets.

### Spec 1.28 / Unreleased — 2026-08-02

- Makes structured MCP data authoritative and human text explicit opt-in.
- Adds receipt and structured-only modes, relative normal-mode paths, validated field projection,
  and projection-aware snapshot execution.
- Shrinks compact guard refusals and standardizes failure-only check output.
- Makes receipt cursors advance deterministically and removes remaining machine-path leaks from
  every non-full response shape.
- Enforces response and schema budgets, including receipt targets, while keeping the full live
  input schema smaller than before the feature.

### Spec 1.27 / Unreleased — 2026-08-02

- Adds `full`, `docs`, and `review` tool profiles as schema-context controls with typed hidden-tool
  refusals and unchanged safety guards.
- Consolidates move, rename, and copy discovery under canonical `svn_path_change`; legacy routes
  remain callable in full mode without consuming advertised schema context.

### Spec 1.26 / Unreleased — 2026-08-02

- Adds repository-driven transactional EOL normalization during add and bounded batch EOL repair.
- Makes diff and blame EOL-blind by default while retaining explicit EOL diagnostics.
- Blocks malformed commit messages before mutation, strengthens commit receipts, and fixes Windows
  Unicode argv handling with a reproducible UTF-8 runtime manifest.
- Adds response/schema budgets and a post-large-diff protocol recovery smoke test.

### Spec 1.25 / v1.3.0 — 2026-07-31

- Adds exact pinned updates, optional remote-HEAD guarding, resulting revision metadata, and an
  opt-in uniform-revision precommit gate for release workflows.
- Recovers exact ignored descendants from successful `W155010` status warnings and preserves those
  warnings without duplicating raw status output.
- Makes multi-entry log envelopes explicit and marks npm-package `current` pointers inapplicable.

### Spec 1.24 / v1.2.2 — 2026-07-28

- Refuses existing directory targets unless precommit and commit receive the same explicit
  directory-node acknowledgement.
- Applies matching working-copy-root acknowledgement checks during precommit and commit.
- Records the stdio diagnostic and Windows process-window ownership boundaries.

### Spec 1.23 / v1.2.1 — 2026-07-27

- Bounds compact full-diff JSON-RPC results independently of the internal streamed excerpt cap.
- Returns independent excerpt and file-summary cursors when the transport budget reduces a
  requested diff page.
- Clarifies that stdio clients must buffer newline-delimited JSON-RPC records rather than treating
  arbitrary pipe read chunks as complete messages.

### Spec 1.22 / v1.2.0 — 2026-07-22

- Adds guarded delete, canonical conflict resolution naming, MCP request cancellation, compact
  snapshots, exact/range history and diff queries, and bounded historical cat/blame tools.
- Requires explicit acknowledgement for root commits and rejects whitespace-only messages.
- Ships the specification and generated MCP API contract in npm artifacts.
- Contains unexpected tool failures in structured envelopes and keeps arbitrary property values
  out of displayed process commands by using secure temporary files.

### Spec 1.21 / v1.1.3 — 2026-07-20

- Replaces the SlikSVN payload with the July 2026 redistributable VisualSVN Apache Subversion
  1.14.5 command-line package and retains complete upstream license/notice files.
- Handles literal peg-revision markers according to each SVN subcommand's operand semantics,
  including names ending in a revision-like `@123` and VisualSVN's distinct move/copy destination
  parsing.
- Refuses symbolic links and Windows directory junctions during recursive add/import guard scans,
  preventing SVN from following links into unscanned external content.
- Applies finite XML entity-expansion limits and fails EOL checks on real property-query errors or
  malformed XML instead of treating them as absent properties.
- Requires regular repository policy files, bounds them at 64 KiB, and redacts parsed structured
  fields in every public response mode.
- Makes VCS administration directories and `.ssh` content immutable never-commit paths.
- Requires npm packing to build current output and tests the installed command shim directly.

### Spec 1.20 / v1.1.2 — 2026-07-20

- Makes credential-file guards immutable even when repository policy has broad allow exceptions.
- Bounds streamed diff lines and per-file summaries, reports truncation, and maps buffered-output
  overflow to a scoped diagnostic.
- Adds finite public input limits and consistent SVN operand separators.
- Accepts npm 12 and newer while retaining npm 11.16.0 as the minimum supported npm version.
- Requires explicit acknowledgment for external export destinations, checks mixed revisions at the
  working-copy root, and aligns EOL repair/property guards with the rest of the safety model.

### Spec 1.19 / v1.1.1 — 2026-07-20

- Recognizes both prepared source-release and direct npm-package runtime layouts in self-check.
- Keeps unprepared source trees invalid and reports the selected runtime layout.
- Supports native SVN and dos2unix commands from `PATH` on macOS and Linux while retaining the
  bundled Windows toolchain.
- Verifies the packed npm artifact through an isolated install and self-check on every CI platform.
- Pins release verification to Node.js 24.18.0 LTS with npm 11.16.0 and matching Node 24 types.

### Spec 1.18 / v1.1.0 — 2026-07-20

- Defines compact/standard/full response modes and preserves the complete envelope internally.
- Makes log changed paths opt-in, lowers the diff default to 200 lines, adds explicit continuation,
  and bounds public status/log/diff output.
- Defines projected info/property reads, failure-oriented EOL results, compact precommit/mutation
  receipts, and concise self-check output.

### Spec 1.17 / v1.0.0 — 2026-07-08

- Declares the first public open-source release as `1.0.0`.
- Documents the GitHub clone -> `npm install` -> `npm run prepare:local` setup path for automated clients.
- Keeps generated `releases/`, `current`, and root `dist/` ignored; only the source tree and root
  bundled Windows runtime payload are versioned.

### Spec 1.16 / v0.1.15 — 2026-07-08

- Adds generic working-copy property tools: read-only `svn_propget` and guarded `svn_propset`.
- Defines property guard boundaries: explicit paths, one working copy, READONLY refusal for
  writes, never-commit target checks, bounded property names/values, and `riskAck` for high-risk
  ignore/externals/auto-props properties.
- Keeps `svn_propset_eol_style` as the stricter EOL-specific shortcut.

### Spec 1.15 / v0.1.14 — 2026-07-07

- Adds §15.7 CLI failsafe mode: on mechanical MCP failure (server down, runtime broken), callers
  fall back to scoped raw svn CLI for the session under the same §5 policy; guard refusals are
  explicitly not failures and must never be bypassed via CLI.
- `noteFromRun` flags executable-launch failures (`ENOENT`/`EACCES`/`EPERM`) as
  "MCP svn runtime unavailable" with the failsafe hint; `svn_diagnose` adds the failsafe
  suggestion when the bundled SVN toolchain is unavailable.

### Spec 1.14 / v0.1.13 — 2026-07-07

- Fixes the critical junction-launch defect: the ESM launched-directly check now compares real
  paths, so `node <MCP_HOME>\svn-agent\current\dist\index.js` (the documented registration)
  actually starts the server instead of exiting silently.
- Update-output parsing accepts only structurally valid status lines, so informational trailers
  ("Updated to revision N.", "At revision N.", "Updating '.':", "Restored ...") can no longer
  appear as phantom changed paths.
- `eol_check`/`svn_precommit` return a structured `kind:"not-a-file"` for directory targets
  instead of failing with a thrown filesystem error.
- Streamed stdout/stderr (the `svn_diff` hot path) now decode with the same latin1 fallback as
  buffered output, honoring §6.5 for non-UTF8 bytes.
- Working-copy containment (G3) verifies physical paths, so junctions/symlinks under a working
  copy cannot redirect tools to files outside it.
- Policy globs additionally cap total wildcard count to bound regex backtracking.
- The read-only working-copy probe no longer falls back to the MCP launch directory under any
  input combination.



- Defines the full hardening pass: non-interactive stable-locale SVN execution, bounded
  streaming stderr, timeout settlement, latin1 output fallback, stronger redaction, parser
  correctness, ignored-path guards, secure message files, split recursive reverts, guarded import
  source scanning, export revision validation, policy validation/caching, nullable working-copy
  roots, and no ambiguous process-cwd fallback.
- Updates read-only performance contracts: batched EOL propget, async EOL sniffing, parallel
  diagnostics, and reduced repeated `svn_info` process spawns.
- Records coverage for the hardening items.

### Spec 1.12 / v0.1.11 — 2026-07-07

- Defines repository-local never-commit policy precedence: `deny` rules override broad `allow`
  exceptions, while `allow` rules may still override the default generated-artifact guard set.
- Defines envelope summary redaction for `stdout_summary` and `stderr_summary`, matching command
  redaction for URL userinfo and sensitive query parameters.
- Updates release references to v0.1.11 after the hardening fixes.

### Spec 1.11 — 2026-07-07

- Updates project documentation guidance for the v0.1.10 shipped baseline.
- Adds `svn_self_check` and `svn_diagnose` to the read-only MCP allowlist guidance.
- Marks the implementation phase plan and v0.1.0 definition of done as historical traceability.
- Adds ADR-004 as the formal decision record for borrowing diagnostic ideas from external SVN MCPs
  without adopting their mutating/configuration semantics.

### Spec 1.10 / v0.1.10 — 2026-07-07

- Defines `svn_diagnose` as a read-only working-copy diagnostic tool for local status, remote
  status, HEAD info, and latest-log reachability.
- Expands the SVN error taxonomy for `E215004` auth exhaustion, `E175002` network/repository
  failures, `E155036` working-copy locks, and `E200030` SQLite working-copy database failures.
- Records the external SVN MCP comparison decision: borrow safe diagnostic patterns
  and reject permissive commit/update/force/auth/shell/plain-text semantics.

### Spec 1.9 / v0.1.9 — 2026-07-07

- Defines segment-aware never-commit guards plus optional repo-local `.svn-mcp-policy.json`
  allow/deny exceptions, including recursive-add descendant scanning.
- Defines streamed `svn_diff` counting so per-file summaries remain complete when excerpts are
  truncated.
- Defines `DIFF_FAILED` precommit verdict behavior and EOL-recoverable diff failure handling.
- Defines structured `eol_fix_verified` refusals for missing/non-file/binary/too-large targets
  and the explicit `allowLarge` escape hatch.
- Defines URL userinfo and sensitive query-parameter redaction for command display.

### Spec 1.8 / v0.1.8 — 2026-07-07

- Defines richer `svn_info` mixed-revision interpretation and remote HEAD/stale-base fields.
- Defines `svn_status` `hideNoise` and `includeIgnored` controls for daily noise reduction and
  explicit review passes.
- Defines `svn_self_check` for release pointer, payload count, startup probe, and packaging
  script health.
- Replaces remaining PowerShell clean behavior with Node-based cleanup.

### Spec 1.7 — 2026-07-07

- Adds the SVN/Subversion pain-point matrix in §16, including which issues the MCP
  already handles, which v0.1.x changes addressed, and which items remain workflow or future
  tooling concerns.

### Spec 1.6 / v0.1.7 — 2026-07-07

- Defines `svn_log` repository-URL-at-HEAD targeting for working-copy paths to avoid
  mixed-revision root log gaps.
- Defines inconsistent-EOL diff recovery diagnostics that point callers to `eol_fix_verified`
  instead of surfacing a generic SVN failure.
- Defines the Node-based `npm run release:prepare` release packaging path to avoid PowerShell
  copy/junction friction.

### Spec 1.5 — 2026-07-07

- Adds the plug-and-play operator guidance in §15, clarifying configuration, automatic
  working-copy discovery, expected benefits, and known trade-offs.

### v0.1.6 — 2026-07-07

- Expands G4 never-commit guards for common generated output and dependency/cache artifacts:
  `dist/**`, `node_modules/**`, `coverage/**`, `.cache/**`, and `*.tsbuildinfo`.

### v0.1.5 — 2026-07-07

- Defines plug-and-play global registration: no end-user environment variables and no
  project-specific launch `cwd`.
- Defines working-copy inference from absolute path inputs so one MCP registration can serve
  multiple SVN working copies.
- Defines `--readonly` as the normal read-only launch mode; `SVN_AGENT_READONLY=1` remains only as
  a legacy/dev override.

### v0.1.4 — 2026-07-07

- Defines the root `bin/` source-tree runtime payload and matching release `bin/` payload.
- Makes bundled SVN and EOL converter binaries the normal runtime path.

### v0.1.3 — 2026-07-07

- Adds guarded `svn_move`, `svn_rename`, and `svn_copy` contracts.

### v0.1.2 — 2026-07-07

- Makes ignored-EOL diffs and EOL repair MCP-owned through bundled converter binaries.

### v0.1.1 — 2026-07-07

- Defines parent-directory handling for nested explicit file adds and commits.

### v0.1.0 — 2026-07-07

- Establishes the generic TypeScript/Node stdio MCP architecture, tool families, guards, and
  versioned release layout.

## 15. Plug-and-play operating model

### 15.1 Corrected requirement

The intended operating model is:

- The SVN MCP is configured once in each MCP-capable client.
- The MCP is not tied to one SVN repository, project, product, checkout, or launch directory.
- A machine may contain many unrelated SVN working copies; one MCP registration must serve all
  of them.
- Normal users do not set environment variables.
- Environment variables exist only for development and testing this MCP.
- Clients should not spend turns locating SVN binaries, composing special diff flags, fixing EOL
  by hand, or re-reading SVN policy for routine work.

The phrase "auto register itself when an existing SVN repository is located" means automatic
working-copy discovery after the MCP has been registered once globally. A stdio MCP server should
not rewrite arbitrary client configuration files at runtime. Client registration is a one-time
client setup step; repository selection happens per tool call.

### 15.2 End-user configuration

Write-capable client:

```json
{
  "mcpServers": {
    "svn": {
      "command": "node",
      "args": ["<MCP_HOME>\\svn-agent\\current\\dist\\index.js"]
    }
  }
}
```

Read-only launch using the same generic server name:

```json
{
  "mcpServers": {
    "svn": {
      "command": "node",
      "args": ["<MCP_HOME>\\svn-agent\\current\\dist\\index.js", "--readonly"]
    }
  }
}
```

Do not set a project-specific launch `cwd`. Do not set normal-use environment variables. For
zero-friction multi-repository use, pass absolute paths to MCP tools. When absolute paths are
provided, the MCP finds the nearest SVN working copy root and runs the command there. Relative
paths remain supported, but they require an explicit per-call `cwd`.

### 15.3 Environment-variable policy

No environment variable is required for normal end-user operation.

`SVN_AGENT_BIN_DIR`, `SVN_AGENT_SVN_PATH`, `SVN_AGENT_DOS2UNIX_DIR`,
`SVN_AGENT_TIMEOUT_MS`, `SVN_AGENT_MAX_DIFF_LINES`, and legacy `SVN_AGENT_READONLY` are reserved
for development, tests, diagnostics, and compatibility checks. They must not be required in
ordinary client setup because they add friction, make the MCP look project-specific, and invite
configuration drift between machines.

Readonly production use should prefer the explicit `--readonly` launch argument.

### 15.4 What the MCP handles for clients

- Bundled SVN and EOL converter binaries, including required DLLs.
- Working-copy inference from absolute paths across multiple SVN checkouts.
- Scoped status, info, log, and diff commands.
- Rich mixed-revision interpretation that separates revision ranges, local modifications, remote
  HEAD, and stale-base warnings.
- Status noise filtering and explicit ignored-path audit mode.
- Repository-URL-at-HEAD log targeting so mixed-revision working-copy roots still show current
  repository history.
- Ignored-EOL diffs by default: `svn diff --internal-diff -x --ignore-eol-style`.
- Inconsistent-EOL diff diagnostics with `eol_fix_verified` as the recovery tool.
- `svn_precommit` as one structured call for status, ignored-EOL diff, EOL inspection, guards,
  and mixed-revision warning.
- `svn_commit` with a temporary `-F` message file, explicit paths, guard checks, revision
  parsing, and post-status.
- `svn_add` with parent-directory scheduling for explicit nested file paths.
- `svn_move`, `svn_rename`, and `svn_copy` with working-copy containment and parent handling.
- `eol_fix_verified` using bundled `unix2dos` or `dos2unix`, followed by an ignored-EOL diff
  proof.
- Hard readonly mode for read-only clients.
- Never-commit guards for generated output, dependency/cache folders, secrets, and other
  high-risk paths.
- Node-based release preparation through `npm run release:prepare`, avoiding PowerShell wildcard
  and junction-copy pitfalls during MCP packaging.
- `svn_self_check` for checking the local `current` pointer, release payload counts, startup
  probe, and packaging script health.
- `svn_diagnose` for one-call troubleshooting of local SVN health, remote reachability,
  authentication failures, lock problems, and working-copy database failures.

### 15.5 How it improves client speed and token use

The MCP reduces client work by turning repeated shell recipes into structured tool calls. Clients
no longer need to:

- Search for `svn`, `svnadmin`, `svnversion`, `dos2unix`, `unix2dos`, or their DLLs.
- Reconstruct SVN policy from rules files for every session.
- Hand-compose ignored-EOL diff commands.
- Dump large raw diffs into assistant context when a structured per-file summary is enough.
- Run separate status, diff, EOL check, and guard commands during every commit-prep loop.
- Manually create commit message files.
- Add missing parent directories before adding a nested file.
- Diagnose and repair common EOL churn with ad hoc PowerShell or byte rewrites.

The intended daily flow is:

1. Client edits files.
2. Client calls `svn_precommit` on the intended paths.
3. Client reviews the structured result and asks for targeted diffs only when needed.
4. Client fixes EOL through `eol_fix_verified` if required.
5. Client calls `svn_commit` with explicit paths and a message when the slice is verified and
   safe to commit.

For common slices this changes a 5-8 command shell loop into one or two MCP calls. That saves
model turns, reduces repeated command text, keeps diffs smaller, and makes unattended work less
likely to stall on avoidable prompts.

### 15.6 Workflow improvement

One global MCP registration supports many SVN repositories on the same machine. Write-capable clients
can make guarded changes, while read-only clients use the same tool surface in `--readonly` mode
and cannot mutate SVN state. This gives both roles the same structured evidence without relying
on product-specific assumptions or project-specific configuration.

The workflow is safer because high-risk actions are explicit: updates need paths or
`updateAll:true`, revert defaults to dry-run, cleanup never removes unversioned files, URL
copy/move is refused, and commit checks enforce explicit paths plus mechanical risk signals.

### 15.7 CLI failsafe mode

If the MCP itself fails mechanically, the caller falls back to scoped raw `svn` CLI **for the
rest of that session** instead of stalling.

**Triggers (mechanical failures only):**

- The `svn` MCP server is not registered, not running, or tool calls fail at the protocol level
  (client-side tool errors, no envelope returned).
- Envelopes report the MCP runtime itself broken: `note` contains
  `"MCP svn runtime unavailable"`, or `svn_diagnose`/`svn_self_check` report the bundled
  toolchain unhealthy and unrecoverable in-session.
- The same read-only tool call fails twice consecutively for reasons that are clearly not
  SVN-level errors (auth, network, locks are SVN-level — CLI would fail identically and is not
  a remedy for them).

**Explicit non-triggers:** a guard refusal is a policy decision, not a failure. READONLY
refusals, never-commit hits, `riskAck` demands, explicit-paths refusals, and working-copy
containment refusals must **never** be retried through the CLI. A read-only instance
stays read-only in failsafe mode.

**Failsafe behavior:** the same policy in §5 applies, hand-executed:

- Scoped commands only; explicit paths; no whole-tree status/diff.
- Diff: `svn diff --internal-diff -x --ignore-eol-style -- <paths…>`.
- Commit: message file + explicit file list (`svn commit -F <msgfile> -- <path1> …`), never inline
  `-m`; message file created outside the working copy.
- Never `--force`; updates only on operator request and with `--accept postpone`.
- The never-commit list (§7 G4) and risky-slice stops (§5.4) remain in force as caller judgment.
- EOL repair via `unix2dos`/`dos2unix` binaries (bundled `<MCP_HOME>\svn-agent\current\bin` if
  reachable, otherwise PATH), never PowerShell byte rewrites.

**Exit:** failsafe lasts for the session. The caller reports that the MCP was unavailable so the
operator can repair it (`svn_self_check` / `svn_diagnose` once the server is back).

### 15.8 Overheads and trade-offs

- A one-time MCP client registration is still required.
- A stdio MCP cannot safely rewrite every possible client configuration file at runtime.
- Bundled Windows runtime binaries make the source and release payloads larger.
- macOS and Linux require package-managed SVN and dos2unix commands on `PATH`; Windows remains
  self-contained through the bundled runtime.
- Absolute paths give the best zero-`cwd` multi-repository behavior. Relative-path-only workflows
  need explicit per-call `cwd`.
- The MCP reduces SVN housekeeping, but it does not remove the caller's responsibility to inspect
  the requested scope, run project-specific tests, and avoid unrelated changes.

## 16. Observed SVN/Subversion pain-point matrix

This matrix records SVN pain points that shaped the MCP design. The purpose is to keep future
work grounded in practical workflow friction, not abstract SVN theory.

| # | Pain point | How the MCP helps now | Pending / still human or future-tooling work |
|---:|---|---|---|
| 1 | Mixed-revision confusion: a working-copy root can be at an older BASE revision while children are newer. | `svn_info` reports parsed revision ranges, local modification flags, remote HEAD, and stale-base state; release workflows can set `svn_precommit requireUniformRevision:true`. | Ordinary workflows still decide whether mixed revision is acceptable. |
| 2 | `svn log <wc-root>` can stop at the root node's old peg revision and hide newer commits. | v0.1.7 resolves working-copy targets to repository URLs and returns `target_mode:"repository-url"`. | URL fallback can fail if `svn info` cannot resolve a URL; then the MCP returns `working-copy-path` mode. |
| 3 | Concurrent-client overlap: another actor may commit while local work exists; update can merge `G` files silently. | Explicit-file baselines plus `svn_update baselineToken` report same-path overlap even after a clean merge; safe mode can capture current state itself, blocks overlap, pins revisions, and always uses `--accept postpone`. | Ordinary standalone updates without a baseline still require caller review. |
| 4 | Unversioned files are easy to miss; `svn commit` does not include them automatically. | `svn_status` exposes `?` paths; `svn_precommit` blocks uncommittable paths; `svn_add` is explicit. | Caller must decide which unversioned files belong to the current slice. |
| 5 | SVN cannot add a child file under a brand-new unversioned parent directory without adding parents first. | `svn_add` uses `--parents --depth empty` for files and schedules needed parent dirs without adding siblings. | Recursive directory adds still require `allowRecursive:true`. |
| 6 | Commit scope ambiguity: no Git-style staging area; broad commits can include unrelated WIP. | Mutating tools require explicit paths; `svn_commit` verifies each path is changed/scheduled. | "Commit everything" remains unsafe unless the caller intentionally scopes all paths. |
| 7 | Partial slice commits create bookkeeping overhead when some work must remain uncommitted. | `svn_precommit`, scoped `svn_status`, scoped `svn_diff`, and explicit `svn_commit` paths support small slices. | The operator or caller still chooses slice boundaries. |
| 8 | Update-before-commit discipline matters when others are committing remotely. | `svn_update` is guarded and conflict-safe; `svn_info` reports remote HEAD and stale-base state. | The MCP does not force an update before every commit because some workflows deliberately avoid it. |
| 9 | Direct-to-trunk workflow means every bad commit lands immediately. | Guarded commit, risk signals, read-only mode, and explicit paths reduce accidental commits. | Branch/PR-like review remains outside SVN/MCP v0.1. |
| 10 | Old design file sprawl: many versioned variants make "current" unclear. | Never-commit guards reduce future generated clutter; scoped status/diff make touched files visible. | The MCP cannot infer canonical design intent; project docs or an archive map are needed. |
| 11 | Archiving or moving files is risky because external notes or checklists may reference exact paths. | `svn_move`/`svn_rename` are guarded, scoped, and report changed paths. | The MCP does not yet maintain a reference map or warn about out-of-repo links. |
| 12 | Noisy status from ignored local runtime folders and generated artifacts. | Never-commit guards block common generated/dependency/cache paths; `svn_status hideNoise:true` filters common local clutter. | Project-specific noise may need local conventions or future custom filters. |
| 13 | `svn status --no-ignore` is useful for audit but noisy for daily work. | Normal MCP status avoids `--no-ignore`; `includeIgnored:true` enables explicit ignored-path audits. | Callers must choose audit mode deliberately. |
| 14 | EOL problems can make `svn diff` fail instead of merely showing a messy diff. | `svn_diff` defaults to ignored-EOL internal diff; failures return EOL diagnostics and `recovery_tool:"eol_fix_verified"`. | Existing tracked files may still need explicit batch repair. |
| 15 | Editing tools can introduce LF into native-CRLF SVN files, causing diff/commit friction. | Repository policy can make `svn_add` transactionally normalize and verify new text files; batch `eol_fix_verified` repairs existing files. | Editors can still alter tracked files after add, so precommit EOL verification remains required. |
| 16 | PowerShell byte rewrites or redirects are risky for tracked text files. | The MCP uses `unix2dos`/`dos2unix` binaries through `execFile`; docs forbid PowerShell EOL repair. | Callers should use MCP tools rather than ad hoc shell rewrites. |
| 17 | Raw `svn diff` command flags are easy to forget and waste tokens. | `svn_diff` owns `svn diff --internal-diff -x --ignore-eol-style` by default and returns structured summaries. | Full raw diffs may still be needed for detailed review. |
| 18 | SVN history lookup is clunkier than modern Git workflows. | `svn_log` returns structured XML-parsed entries and now avoids mixed-root log gaps. | Higher-level "what changed between these revisions" summaries are future tooling. |
| 19 | Versioned generated/test artifacts can become permanent repository weight if added accidentally. | Never-commit guards now block `dist/**`, `node_modules/**`, `coverage/**`, `.cache/**`, `*.tsbuildinfo`, secrets, and other risky paths. | Project-specific generated paths may need additional local guard rules later. |
| 20 | Adding bundled binary release payloads is noisy and easy to miscount. | `npm run release:prepare` validates release `dist` and `bin` counts before repointing `current`; `svn_self_check` reports counts. | SVN add output is still verbose for binary payloads. |
| 21 | Local `current` junction is intentionally ignored, so a clean SVN status does not prove the local runtime pointer is correct. | `svn_self_check` validates prepared-release pointers and explicitly marks the pointer inapplicable for direct npm installs. | None for normal use. |
| 22 | PowerShell wildcard/copy/junction command differences caused release-packaging hiccups. | `npm run release:prepare` and `npm run clean` are Node scripts with path containment checks. | None for MCP release/clean paths. |
| 23 | Message quoting and shell command construction are fragile for commits/imports. | `svn_commit` and `svn_import` use temporary UTF-8 `-F` message files and `execFile`, not shell strings. | Human-written raw SVN commits can still bypass this discipline. |
| 24 | Root-clean does not mean conceptually clean: a clean status can still represent mixed concerns in the last commit. | Post-commit scoped status proves no local residue; risk signals and explicit paths reduce mixed slices. | Conceptual scope review remains a human or caller responsibility. |
| 25 | Opaque SVN failures waste turns: auth exhaustion, server connection failures, WC locks, and WC database issues all look like generic command failures when raw stderr is fed back into an assistant transcript. | v0.1.10 adds `svn_diagnose` and expands `noteFromRun` so these classes produce structured notes and next-step suggestions. | Repository-specific server outages and credential fixes still happen outside the MCP. |
| 26 | Existing generic SVN MCPs contain useful diagnostics but may reintroduce friction or risk through PATH/env setup, credential env vars, force flags, optional broad commits, and shell/string command execution. | This MCP borrows the safe read-only diagnostic/error-taxonomy ideas while keeping bundled binaries, no normal-use env vars, no-shell execution, explicit path commits, and guarded mutating tools. | Future external comparisons should be treated as design input, not as a reason to fork or loosen guards. |
