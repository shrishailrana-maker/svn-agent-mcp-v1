# SVN Rules

Read when source-changing work reaches diff/commit prep, imports, EOL problems, or tasks
specifically about SVN state.

## Principle

SVN is for preserving completed work, not for warming up. Do the requested work first. Use SVN only when it is needed for exact diff, EOL diagnosis, conflict diagnosis, or commit.

## When SVN is allowed

- **Before editing:** no SVN command unless the task is about SVN/EOL, the target file is ambiguous, or the user asks.
- **After editing tracked files:** run scoped diff/status only on touched/intended paths when needed for handoff or commit.
- **Commit prep:** use scoped MCP `svn_status` and `svn_diff` on intended paths. `svn_diff` runs `svn diff --internal-diff -x "--ignore-eol-style"` by default. Confirm the diff is exactly the requested change.
- **Property work:** use MCP `svn_propget` and guarded `svn_propset` for generic working-copy properties. Use `svn_propset_eol_style` for `svn:eol-style` when normalizing EOL policy.
- **`svn update .`:** only when the user explicitly asks or the task is specifically to update/sync the working copy. Never run it as default preflight.

## MCP Registration

Register the SVN MCP once globally. Do not configure a project-specific launch `cwd` or normal-use
environment variables. For frictionless multi-repo use, pass absolute paths to MCP tools; the MCP
will infer the matching SVN working copy. Use explicit per-call `cwd` only when working with
relative paths.

Use `svn_self_check` when the MCP release pointer or bundled toolchain is in question. Use
`svn_diagnose` when SVN behavior is unclear or raw SVN errors mention authentication, network
access, working-copy locks, database problems, or stale remote reachability.

## Failsafe: raw svn CLI when the MCP is down

If the SVN MCP fails mechanically — the server is not registered or not responding, tool calls
error at the protocol level, or envelopes/`svn_diagnose` report "MCP svn runtime unavailable" —
switch to scoped raw `svn` CLI for the rest of the session instead of stalling:

- Follow the same rules in this file by hand: scoped explicit paths, ignored-EOL diff
  (`svn diff --internal-diff -x --ignore-eol-style <paths…>`), commit via `-F` message file plus
  explicit file list, never `--force`, update only on user request with `--accept postpone`,
  never-commit list still applies, EOL repair via `unix2dos`/`dos2unix` binaries only.
- A guard refusal is not a failure. Never use the CLI to redo something the MCP refused
  (READONLY, never-commit, riskAck, explicit-paths, containment). Read-only instances stay
  read-only in failsafe mode.
- SVN-level errors (authentication, network, working-copy locks) are not failsafe triggers —
  the CLI fails the same way; use `svn_diagnose` output to report them instead.
- Report that the MCP was unavailable and failsafe was used, so it can be repaired;
  verify with `svn_self_check` once it is back.

## Frequent commits

- Write-capable clients commit after completed, verified, requested-scope, non-risky slices.
- A commit is never the first step. Implement → verify → inspect diff → commit.
- Commit only intended paths, one slice at a time.
- Use a message file and explicit file list: `svn commit -F <msgfile> <path1> <path2>`. Never use bare inline `-m` from an automated session.
- After commit, report the revision and clean scoped status.
- If verification fails, fix it or report the exact failure. Do not commit a known-bad slice.

## Risky slices stop before commit

Ask for explicit approval before committing when the slice is large, destructive, schema-changing, version-bumping, build-system-changing, delete-heavy, security-sensitive, or scope-unclear.

## Read-Only Clients

Read-only instances never commit, stage, revert, update, or change SVN state. They may
describe the intended fix or commit plan for a write-capable client.

## EOL and encoding

- Preserve existing encoding and EOL. Do not normalize whole files.
- EOL-only churn is not a code change. Check with MCP `svn_diff`; it ignores EOL style by default.
- If SVN reports inconsistent line endings, use MCP `eol_fix_verified` on that one file. The MCP chooses `unix2dos` or `dos2unix` from `svn:eol-style`, runs the real binary, then re-checks the ignored-EOL diff.
- Do not use PowerShell byte rewrites, scripts, pipes, or redirects on tracked text files.

## Never commit

In managed project working copies, never commit `bin/`, `dist/`, `node_modules/`, `coverage/`, `obj/`, `.vs/`, `.cache/`, `*.tsbuildinfo`, generated output, `*.db`, `scratch/**`, secrets, keys, certificates, tool caches, or unrelated drive-by changes. The root `bin/` folder in this MCP repository is versioned source for the bundled runtime tools.

## Commit message format

```text
<short summary>

- <logical change group>
- <verification performed>
- <behavior impact, or "No behavior changes">
```
