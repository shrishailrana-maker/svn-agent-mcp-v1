# svn-agent — Generic Implementation Spec

**Spec version 1.19 — public implementation contract. Single source of truth.**
This document describes the current generic SVN MCP design without deployment-specific paths,
hostnames, or product-specific role assignments. Date: 2026-07-20.

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
| P1: 5–8 round trips per commit | Composite MCP tools: `svn_precommit` + `svn_commit` = 2 calls total | §8.3, §8.4 |
| P1: permission-prompt stalls | Allowlist read-only tools; only mutations prompt | §10.4 |
| P1: policy re-derivation + drift | Policy baked into the MCP as defaults & guards; read-only clients hard-READONLY | §7 |
| P1: raw-diff dumping into context | Structured JSON envelope, per-file ± counts, line-capped excerpts | §6.4, §8.3 |
| P2: LF files born from file-creation tools | Client write hook or MCP repair normalizes CRLF/no-BOM | §10.1 |
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
- Project text policy is discovered from SVN properties and local bytes. The default Windows
  remediation target is CRLF + `svn:eol-style=native`, no BOM, but this must not hard-code one
  repository's language or folder names.
- MCP installation home is chosen by the deployer, for example `<MCP_HOME>\svn-agent`.
- Node 24.18.0 or newer within the Node 24 LTS line and npm 11.16.0 or newer within the npm 11 line are required.

## 4. Locked decisions (no open questions)

| # | Decision | Rationale |
|---|---|---|
| D1 | Write from scratch in TypeScript/Node; do **not** fork an existing SVN MCP | Safety layer is the product; forking inherits a permissive surface |
| D2 | Read-only safety = launch with `--readonly` (legacy/dev env `SVN_AGENT_READONLY=1` also works); every mutating tool refuses | Simple, unbypassable, matches "read-only clients never change SVN state" |
| D3 | Mixed-revision WC on commit → **warn in `note`, proceed** | Caller decides; refusing blocks legitimate scoped commits |
| D4 | `riskAck:true` required for mechanically detectable risky slices (§7 G6); undetectable risk categories stay the calling client's approval-gate duty | Encodes the risky-slice gate without pretending to detect the undetectable |
| D5 | Branch/switch/merge/relocate/delete: **out of v0.1** | Not needed for daily flow; each is high-risk |
| D6 | Versioning: **semver**, first release `v0.1.0`; `current` junction → `releases\v0.1.0` | One pin, easy rollback |
| D7 | Env overrides win; use compatible bundled tools next and native `PATH` tools otherwise | Windows stays self-contained while macOS/Linux use their normal package-managed toolchain |
| D8 | Commit message format checked, **warn not refuse** | Format is policy but judgment; a hard block would fight legitimate cases |
| D9 | Commit message via temp **`-F` file outside the WC**, never `-m` | Encodes the shared SVN policy |
| D10 | `svn_update` needs explicit `paths[]` or `updateAll:true`; always `--accept postpone` | Update is operator-gated; conflicts must surface, never auto-resolve |
| D11 | XML output (`--xml`) for status/info/log parsing; regex only where svn has no XML (diff, update, commit) | Locale-proof, stable parsing |
| D12 | ESM TypeScript, strict mode; deps only `@modelcontextprotocol/sdk`, `zod`, `fast-xml-parser` | Small, auditable |
| D13 | Server registered under the name **`svn`**; tools named `svn_*` / `eol_*` | Short, unambiguous |
| D14 | External SVN MCPs are reference material, not the base implementation | Borrow diagnostics/docs lessons; reject force flags, optional broad commits, shell execution, credential env vars, and repo-specific registration |

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
6. EOL: preserve existing encoding/EOL; never normalize whole trees; EOL-only churn is not a
   code change (check = empty MCP `svn_diff`); fix a single failing file with MCP
   `eol_fix_verified`, which invokes `unix2dos`/`dos2unix` directly; never rewrite bytes via
   PowerShell/in-process.
7. For managed project working copies, never commit: `bin/`, `obj/`, `.vs/`, generated output,
   `*.db`, `scratch/**`, secrets, keys, certificates, tool caches, or unrelated drive-by changes.
   These guards are segment-aware so nested build output such as `src/App/bin/Debug/**` is also
   blocked. A repository may version an optional `.svn-mcp-policy.json` to allow intentional
   payloads; the MCP repository uses that to allow its root `bin/` runtime toolchain and
   versioned release payloads without weakening normal project defaults.
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
    parse\
      statusXml.ts, infoXml.ts, logXml.ts   # --xml parsers (fast-xml-parser)
      diffText.ts     # unified-diff → per-file {added, removed}; lineLimit excerpting
      updateText.ts   # U/G/C/E line parser + "Summary of conflicts"
      commitText.ts   # /Committed revision (\d+)\./
    eol.ts            # byte sniffing (EOL kind, BOM, binary), dos2unix/unix2dos invocation
    tools\
      readonly.ts     # svn_status, svn_info, svn_diff, svn_log, eol_check, svn_propget
      composite.ts    # svn_precommit, eol_fix_verified
      mutating.ts     # svn_add, svn_commit, svn_move, svn_rename, svn_copy,
                      # svn_update, svn_revert, svn_resolved, svn_cleanup,
                      # svn_propset_eol_style, svn_propset, svn_export, svn_import
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
| `SVN_MCP_RESPONSE_MODE` | No | Default public response mode: `compact` (default), `standard`, or `full` |

### 6.3 Path & cwd rules

Every tool accepts optional `cwd` (absolute). For plug-and-play global registration, clients do
not set a launch `cwd`; when a tool call supplies absolute paths and omits `cwd`, the MCP locates
the nearest SVN working copy for those paths. Relative paths still resolve against explicit `cwd`
when provided; without `cwd` or absolute path hints, the call is refused. Resolved paths **must stay inside one working
copy root** (found via `.svn` ancestor discovery + `svn info --xml`) — anything outside → guard
refusal. Empty `paths: []` where paths are required → refusal (`note:"explicit paths required"`),
never silently `.`.

### 6.4 Response modes and internal envelope

Every tool accepts optional `responseMode: "compact" | "standard" | "full"`. The server default
is `compact`, overridable with `SVN_MCP_RESPONSE_MODE`. Compact mode returns bounded,
tool-specific structured results and a one-line text receipt. Standard mode preserves the full
parsed envelope but omits redundant successful stdout. Full mode preserves the legacy envelope
and bounded raw successful output for troubleshooting. Failures retain bounded stdout/stderr diagnostics
in every mode. Response shaping never bypasses path validation, guards, EOL checks,
mixed-revision checks, or post-mutation verification.

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
Internally, errors are always envelopes and never thrown raw stacks. Compact public errors retain
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

- **G1 explicit targets:** mutating path-list tools require non-empty `paths[]`; source/destination tools require explicit `src` and `dest` (exceptions: `svn_update` with `updateAll:true`; `svn_cleanup` takes one `path`). No implicit `.`, no recursive default anywhere.
- **G2 READONLY:** `--readonly` (or legacy/dev `SVN_AGENT_READONLY=1`) → all §8.4 tools + `eol_fix_verified` refuse.
- **G3 WC containment:** resolved paths must be inside the working copy (§6.3).
- **G4 never-commit globs** (block in `svn_add`, `svn_move`, `svn_rename`, `svn_copy`, and `svn_commit`; case-insensitive, match on repo-relative path): `**/bin/**`, `**/dist/**`, `**/node_modules/**`, `**/coverage/**`, `**/obj/**`, `**/.vs/**`, `**/.cache/**`, `**/*.db`, `**/*.tsbuildinfo`, `scratch/**`, `packages/**`, `tags/**`, `.graphify/**`, `graphify-out/**`, `**/*.pfx`, `**/*.key`, `**/*.pem`, `**/*.p12`, `**/*.snk`, `**/.env*`. Optional repo-local `.svn-mcp-policy.json` may add strict allow/deny exceptions, for example to version a toolchain payload in the MCP repository itself. ("Unrelated drive-by changes" cannot be a glob — mitigated by G1 + G5; stays agent judgment.)
  Policy shape:
  ```json
  { "neverCommit": { "allow": ["bin/**"], "deny": ["custom-generated/**"] } }
  ```
  Defaults stay strict when no policy file is present; policy is read from the working-copy root and never from an environment variable. Policy files are cached by working-copy root and mtime/size, and malformed or pathological policy globs fail with a `policy-error:` guard note.
  Repository-local `deny` rules are evaluated before repository-local `allow` rules, so a broad
  allow exception cannot bypass a stricter project-specific deny.
- **G5 must-be-changed:** `svn_commit` verifies every listed path is actually modified/added/deleted per scoped status; unknown/clean path → refusal naming the path.
- **G6 risky-slice ack:** `svn_commit` requires `riskAck:true` when any mechanical signal is present: a delete-scheduled path (status `D`), **more than 8 paths**, `version.ver` among the paths, or a build-system file among the paths (`*.sln`, `*.csproj`, `Directory.Build.props`, `Directory.Build.targets`, `*.props`, `*.targets`, `packages.config`). Refusal lists the triggered signals. Schema-changing / security-sensitive / scope-unclear risk is **not detectable** — the calling client's responsibility (§5.4).
- **G7 no dangerous flags:** `--force` is never emitted. `svn_update` always gets `--accept postpone`. `svn_cleanup` never gets `--remove-unversioned`/`--remove-ignored`/`--vacuum-pristines`. `svn_resolved` requires an explicit `accept` value from the caller.

## 8. Tool contracts

All inputs are validated with zod. Tool implementations produce Envelope plus the extra fields
listed; the public response mode then shapes that complete internal result. "argv" shows the exact
svn invocation (before path resolution).

### 8.1 Read-only tools (allowed under READONLY)

**`svn_status`** — `{ cwd?, paths?: string[], statuses?, includeUnversioned?, countOnly?, maxItems?, cursor? }`
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

**`svn_info`** — `{ cwd?, paths?: string[], fields?: InfoField[] }`
argv: `svn info --xml [paths…]`. Extra fields: `url`, `repo_root`, `wc_root`.
Mixed-revision detection: additionally run `svnversion <wc-root>` once; output containing
`:` → `mixed_revision:true` (+ `note`), suffix `M`→modified, `S`→switched, `P`→partial reported
in `note`. The MCP also returns `svnversion`, `revision_range:{min,max}`, `local_modifications`,
`switched`, `partial`, `remote_head_revision`, and `stale_base` so clients can distinguish a
mixed-revision working copy from dirty local edits. Compact callers may project the corresponding
camel-case fields instead of receiving every metadata field.

**`svn_diff`** — `{ cwd?, paths: string[], ignoreEol?: boolean = true, lineLimit?: number = 200, diffMode?: "summary"|"compact"|"full", maxChars?, maxHunksPerFile?, maxFiles?, fileCursor?, cursor? }`
argv (default): `svn diff --internal-diff -x --ignore-eol-style <paths…>` — the generic
commit-prep standard. `ignoreEol:false` → `svn diff --internal-diff <paths…>` (raw, for EOL
diagnosis). Extra fields: `per_file: [{path, added, removed, binary}]` (parsed from unified
diff; `binary:true` when svn prints "Cannot display"), `diff_excerpt` (first `lineLimit`
lines), `truncated`, `ignore_eol:boolean`. Property-only changes set `property_changed:true` and
do not inflate source line counts. `lineLimit` is capped at 2,000. Compact response mode supports
summary-only output or bounded hunks, with a 3,000-character default. `cursor` pages the streamed
excerpt; `fileCursor` pages file summaries independently. Complete per-file counts are computed
before public response shaping.

**`svn_log`** — `{ cwd?, paths?: string[], limit?: number = 10, verbose?: boolean = false, fullMessage?, changedPaths?, maxMessageChars?, maxChangedPaths?, cursor? }`
argv: `svn log --xml -l <limit+1> [-v] [targets…]`; the extra entry determines whether a
continuation exists and is not returned. For working-copy targets, the MCP
resolves target URLs and queries repository URLs at HEAD when possible. This avoids the common
mixed-revision working-copy peg problem where `svn log <wc-root>` only shows history through the
root directory's older BASE revision. If URL resolution fails, the MCP falls back to the original
working-copy paths. Extra: `entries: [{rev, author, date, msg, changed_paths}]`,
`target_mode: "repository-url"|"working-copy-path"`. Compact entries contain revision, author,
date, and the first message line. Full messages and changed paths require explicit flags and remain
bounded; truncation is marked per entry. `nextCursor` continues from an older revision.

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
Pure read: `svn propget <name> --xml <paths…>`. Property names are bounded to ordinary SVN
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
availability, and short diagnostics; `detailed:true` includes paths, counts, and capabilities.
Prepared source clones use `current -> releases/v<version>`; npm installations are valid with
package-root `dist/` and `bin/` and no generated junction. Unprepared source trees remain invalid.
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

### 8.2 (reserved)

### 8.3 Composite tools (the P1 killers)

**`svn_precommit`** — `{ cwd?, paths: string[], lineLimit?: number = 200, includeDiff?: boolean = false }` *(read-only; allowed under READONLY)*
One call = scoped status + scoped ignore-EOL diff + `eol_check` + G4/G5/G6 dry evaluation +
mixed-revision check. Extra fields:

```jsonc
{
  "verdict": "READY" | "EOL_FIX_NEEDED" | "GUARD_BLOCKED" | "NOTHING_TO_COMMIT" | "DIFF_FAILED",
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
Intended flow: **precommit → (review summary; fetch full per-file diff only if a count looks
wrong) → commit.** Two round trips.

Compact mode returns one authoritative receipt: path count, status counts, diff totals, EOL and
mixed-revision verdicts, guard failures, and `ready`. It omits the diff excerpt unless
`includeDiff:true` is requested. An early setup/status failure returns a compact diagnostic instead
of implying that diff or EOL checks passed.

**`eol_fix_verified`** — `{ cwd?, path: string, target?: "crlf"|"lf", removeBom?: boolean = true, dryRun?: boolean = false, allowLarge?: boolean = false }` *(mutating; refused under READONLY)*
One call = read `svn:eol-style`, infer the target (`native` → platform native, `LF` → lf,
`CRLF` → crlf, no property → platform native), execute the real converter via `execFile`
(`unix2dos` for crlf / `dos2unix` for lf; `--remove-bom` when `removeBom`) on **one file**,
then automatically re-run the ignore-EOL diff on it. Clients normally pass only `{path}` when
using absolute paths; `cwd` is optional and mainly for relative paths.
Extra: `{ before: {kind, has_bom}, after: {kind, has_bom}, target, eol_style, converter,
verification_command, diff_ignored_eol:true, pure_eol_churn: boolean }` —
`pure_eol_churn:true` is the proof the fix changed nothing but line endings. `dryRun:true`
reports `before` + inferred converter/target, touches nothing. Never invoked implicitly by any
other tool (fixing is always an explicit caller decision). Missing paths, non-files, binary files,
and `sniff:"skipped-too-large"` files return structured refusals; oversized files require
explicit `allowLarge:true`. No PowerShell scripts, byte rewrites, pipes, redirects, or shell
quoting are involved.

### 8.4 Mutating tools (all refused under READONLY)

**`svn_add`** — `{ cwd?, paths: string[], allowRecursive?: boolean = false }`
argv: `svn add --parents --depth empty <paths…>` (files); intermediate parent directories are
scheduled as needed without recursively adding siblings. A directory path requires
`allowRecursive:true` (then `--parents --depth infinity`). G4 enforced — can't add what may never be committed
(`scratch/**` is reserved for local scratch files; never add).

**`svn_commit`** — `{ cwd?, paths: string[], message: string, riskAck?: boolean = false }`
Sequence: G1→G6 checks → message format check against §5.8 template (summary line + blank +
≥1 `- ` bullet; deviation → warning appended to `note`, not refusal) → write message to temp
file **outside the WC** (secure temp dir, UTF-8 **no BOM**, leading BOM stripped) → argv:
`svn commit -F <tmpfile> --depth empty <paths…>` → delete tmpfile (always, incl. on failure) →
parse `Committed revision N.` → run scoped `svn status --xml <paths…>`.
If an explicit file path is under newly-added parent directories, the commit argv includes only
those scheduled-added ancestors plus the explicit path, so the caller does not need to name parent
directories manually.
Extra: `{ revision, post_status_clean: boolean, risk_signals: string[] }`. Mixed-revision WC →
warning in `note`, commit proceeds (D3).

**`svn_move`** — `{ cwd?, src: string, dest: string }`
argv: `svn move --parents <src> <dest>`. Working-copy path → working-copy path only; repository
URL forms are refused because URL moves create revisions immediately and require message-file
handling. `src` must exist and both `src` and `dest` must resolve inside the working copy.
Intermediate destination directories are created/scheduled by SVN. G4 enforced on both `src` and
`dest`. Extra: `{ operation:"move", src, dest }` plus scoped `changed_paths` for review/commit.
Committing a move normally requires both old and new paths; because the old path is scheduled
delete, `svn_commit` requires `riskAck:true` by G6.

**`svn_rename`** — `{ cwd?, src: string, dest: string }`
Alias for `svn_move`, registered separately so clients can use the natural verb when doing a
rename. Same argv, guards, and response shape as `svn_move`.

**`svn_copy`** — `{ cwd?, src: string, dest: string }`
argv: `svn copy --parents <src> <dest>`. Working-copy path → working-copy path only; repository
URL forms are refused. `src` must exist and both paths must be inside the working copy.
Intermediate destination directories are created/scheduled by SVN. G4 enforced on both `src` and
`dest`. Extra: `{ operation:"copy", src, dest }` plus scoped `changed_paths`.

**`svn_update`** — `{ cwd?, paths?: string[], updateAll?: boolean = false }`
Refuses unless `paths` non-empty or `updateAll:true` (deliberate friction; the operator-request
requirement in §5.2 remains the caller's responsibility). argv:
`svn update --accept postpone [paths…]`. Parses multi-column update output + "Summary of conflicts" →
`changed_paths` + `conflicts`; any conflict ⇒ prominent `note`. Never auto-resolves.

**`svn_revert`** — `{ cwd?, paths: string[], allowRecursive?: boolean = false, dryRun?: boolean = true }`
`dryRun:true` (default) = preview: returns scoped status + per-file ± counts of what would be
**lost**, changes nothing. `dryRun:false` → argv `svn revert <file paths…>` for files and a
separate `svn revert --depth infinity <directory paths…>` for directories; a directory or `.`
requires `allowRecursive:true`. Reverting the WC root path is refused unconditionally.

**`svn_resolved`** — `{ cwd?, path: string, accept: "working"|"mine-full"|"theirs-full"|"base" }`
argv: `svn resolve --accept <accept> <path>`. Single path; `accept` has **no default** — the
caller must state the resolution. Intended only after an operator asked for conflict resolution.

**`svn_cleanup`** — `{ cwd?, path?: string }`
argv: `svn cleanup [path]` — releases stale WC locks (the `E155004` remedy). **Never** passes
`--remove-unversioned`, `--remove-ignored`, or `--vacuum-pristines`. Mutating classification
(refused under READONLY) because it rewrites WC metadata.

**`svn_propset_eol_style`** — `{ cwd?, paths: string[], style?: "native"|"LF"|"CRLF" = "native" }`
argv: `svn propset svn:eol-style <style> <paths…>`. Guard: each target must currently be
**missing or mismatched** on the prop (checked via propget first) — mass re-propset of
already-correct files is refused (preserve-existing rule, §5.6). Rarely needed once §10.2 lands.

**`svn_propset`** — `{ cwd?, paths: string[], name: string, value: string, riskAck?: boolean = false }`
argv: `svn propset <name> <value> <paths…>`. Guard: explicit existing paths inside one working
copy, READONLY refusal, never-commit target checks, bounded property names/values. `riskAck:true`
is required for high-risk properties that can hide or redirect repository behavior:
`svn:ignore`, `svn:global-ignores`, `svn:externals`, and `svn:auto-props`.

**`svn_export`** — `{ cwd?, src: string, dest: string, revision?: string }` /
**`svn_import`** — `{ cwd?, src: string, url: string, message: string }`
argv: `svn export [-r rev] <src> <dest>` / `svn import -F <tmpfile> <src> <url>`. Explicit
src+dest/url; `svn_export` validates revision strings before invoking SVN, and `svn_import`
scans the source tree for never-commit descendants before invoking SVN. `svn_import` uses the
same secure `-F` tempfile mechanics as commit. Purpose: MCP release packaging.

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

EOL remediation belongs inside this MCP. Callers should call `eol_fix_verified` with a file path;
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

### 10.4 Permission allowlist

Interim (before MCP): allow read-only `svn status`, `svn diff`, `svn info`, and `svn log`
commands in the client permission system.
Final (after Phase 4): allow `mcp__svn__svn_self_check`, `mcp__svn__svn_diagnose`,
`mcp__svn__svn_status`, `mcp__svn__svn_info`, `mcp__svn__svn_diff`, `mcp__svn__svn_log`,
`mcp__svn__eol_check`, `mcp__svn__svn_propget`, and `mcp__svn__svn_precommit`; leave every
mutating tool prompt-gated.

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

Branch, switch, merge, relocate, delete (v0.2+ candidates, each with its own guard
design); blame/annotate; lock/unlock; changelist support; any Git interop; any mass
reformatting, ever. Project build/test time can dominate total slice time, but it is not SVN
housekeeping — separate initiative.

## 14. Change Log

The complete release history lives in `../CHANGELOG.md`. Spec-affecting changes:

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
- Diff: `svn diff --internal-diff -x --ignore-eol-style <paths…>`.
- Commit: message file + explicit file list (`svn commit -F <msgfile> <path1> …`), never inline
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
| 1 | Mixed-revision confusion: a working-copy root can be at an older BASE revision while children are newer. | `svn_info` reports parsed revision ranges, local modification flags, remote HEAD, and stale-base state; `svn_log` queries repository URLs at HEAD when possible. | Callers must still understand whether mixed revision is acceptable for the task. |
| 2 | `svn log <wc-root>` can stop at the root node's old peg revision and hide newer commits. | v0.1.7 resolves working-copy targets to repository URLs and returns `target_mode:"repository-url"`. | URL fallback can fail if `svn info` cannot resolve a URL; then the MCP returns `working-copy-path` mode. |
| 3 | Concurrent-client overlap: another actor may commit while local work exists; update can merge `G` files silently. | `svn_update` requires explicit paths or `updateAll:true` and always uses `--accept postpone`; status/conflicts are structured. | Semantic overlap still needs review by the operator or caller. |
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
| 14 | EOL problems can make `svn diff` fail instead of merely showing a messy diff. | `svn_diff` defaults to ignored-EOL internal diff; v0.1.7 returns EOL diagnostics and `recovery_tool:"eol_fix_verified"` on inconsistent EOL failures. | Files still need explicit repair through `eol_fix_verified`; the MCP will not mutate implicitly. |
| 15 | Editing tools can introduce LF into native-CRLF SVN files, causing diff/commit friction. | `eol_check` and `eol_fix_verified` detect and repair single files through bundled converters. | Preventing bad writes at source depends on editor/client behavior outside the MCP. |
| 16 | PowerShell byte rewrites or redirects are risky for tracked text files. | The MCP uses `unix2dos`/`dos2unix` binaries through `execFile`; docs forbid PowerShell EOL repair. | Callers should use MCP tools rather than ad hoc shell rewrites. |
| 17 | Raw `svn diff` command flags are easy to forget and waste tokens. | `svn_diff` owns `svn diff --internal-diff -x --ignore-eol-style` by default and returns structured summaries. | Full raw diffs may still be needed for detailed review. |
| 18 | SVN history lookup is clunkier than modern Git workflows. | `svn_log` returns structured XML-parsed entries and now avoids mixed-root log gaps. | Higher-level "what changed between these revisions" summaries are future tooling. |
| 19 | Versioned generated/test artifacts can become permanent repository weight if added accidentally. | Never-commit guards now block `dist/**`, `node_modules/**`, `coverage/**`, `.cache/**`, `*.tsbuildinfo`, secrets, and other risky paths. | Project-specific generated paths may need additional local guard rules later. |
| 20 | Adding bundled binary release payloads is noisy and easy to miscount. | `npm run release:prepare` validates release `dist` and `bin` counts before repointing `current`; `svn_self_check` reports counts. | SVN add output is still verbose for binary payloads. |
| 21 | Local `current` junction is intentionally ignored, so a clean SVN status does not prove the local runtime pointer is correct. | `svn_self_check` reports `current` target and whether it matches the package version. | None for normal use. |
| 22 | PowerShell wildcard/copy/junction command differences caused release-packaging hiccups. | `npm run release:prepare` and `npm run clean` are Node scripts with path containment checks. | None for MCP release/clean paths. |
| 23 | Message quoting and shell command construction are fragile for commits/imports. | `svn_commit` and `svn_import` use temporary UTF-8 `-F` message files and `execFile`, not shell strings. | Human-written raw SVN commits can still bypass this discipline. |
| 24 | Root-clean does not mean conceptually clean: a clean status can still represent mixed concerns in the last commit. | Post-commit scoped status proves no local residue; risk signals and explicit paths reduce mixed slices. | Conceptual scope review remains a human or caller responsibility. |
| 25 | Opaque SVN failures waste turns: auth exhaustion, server connection failures, WC locks, and WC database issues all look like generic command failures when raw stderr is fed back into an assistant transcript. | v0.1.10 adds `svn_diagnose` and expands `noteFromRun` so these classes produce structured notes and next-step suggestions. | Repository-specific server outages and credential fixes still happen outside the MCP. |
| 26 | Existing generic SVN MCPs contain useful diagnostics but may reintroduce friction or risk through PATH/env setup, credential env vars, force flags, optional broad commits, and shell/string command execution. | This MCP borrows the safe read-only diagnostic/error-taxonomy ideas while keeping bundled binaries, no normal-use env vars, no-shell execution, explicit path commits, and guarded mutating tools. | Future external comparisons should be treated as design input, not as a reason to fork or loosen guards. |
