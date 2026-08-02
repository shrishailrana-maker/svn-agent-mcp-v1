# Security Policy

## Supported Versions

Security fixes target the latest released version on the default branch. Older releases may receive
fixes when the issue is severe and the patch is low risk.

## Reporting A Vulnerability

Please report suspected vulnerabilities through GitHub private vulnerability reporting or a private
security advisory for this repository. If private reporting is not enabled, open a minimal public
issue asking for a security contact without including exploit details.

Useful reports include:

- Affected version or commit
- Impact and attacker capabilities
- Reproduction steps or proof of concept
- Whether the issue affects read-only, mutating, or release-packaging behavior

Please do not publish exploit details until a fix or mitigation is available.

## Security Boundaries

- Repository policy `allow` rules may override generated-output guards for intentional runtime
  payloads. They cannot permit credential-like files such as private keys, `.env*`, `.npmrc`,
  `.ssh` content, or VCS administration directories.
- `svn_export` may write to an explicit destination outside a working copy only when the caller sets
  `externalDestAck:true`, and `svn_import` may read an explicit source outside one. Both are refused
  in read-only mode; import scans its source for never-commit paths and refuses symbolic links or
  directory junctions before invoking SVN.
- Buffered SVN output is limited to 20 MB. Streamed diff lines are limited to 1 MiB, and diff file
  summaries are limited to 20,000 entries. Streamed parser callbacks and per-file previews have
  separate work/size limits. Truncation, incomplete aggregate totals, and over-limit failures are
  reported rather than silently discarded.
- Child-process timeouts and MCP cancellation terminate the process tree, escalate when needed, and
  wait for process closure before returning a receipt. Output byte limits count UTF-8 bytes rather
  than JavaScript string units.
- Compact diff results enforce a separate serialized-size budget and return continuation cursors
  for omitted excerpts and file summaries. Stdio clients must still buffer the byte stream through
  its newline-delimited JSON-RPC record boundary instead of parsing arbitrary read chunks.
- Response redaction covers credential-bearing URLs and common secret query parameters, but it is
  not a substitute for keeping credentials out of versioned file content and commit messages.
- Commit/import messages and generic property values are passed through mode-0600 temporary files
  outside the working copy and removed in `finally`, rather than embedded in displayed commands.
- Optional mutation operation receipts are stored outside working copies with atomic replacement,
  restricted file modes, bounded record sizes, and no raw successful stdout/stderr. IDs are bound to
  normalized inputs; unreadable, mismatched, concurrent, or ambiguous stale receipts fail closed.
  The physical store path is refused inside an SVN working copy. Terminal and stale orphan files
  are pruned within fixed limits; retained unfinished or unreadable records cause a capacity refusal
  rather than deletion. Live lock owners are preserved, abandoned breaker files are recoverable,
  and lock acquisition waits for a bounded five seconds. The receipt store is local to one host and must not be treated as a
  cross-machine lock.
- Working-copy `cwd` inputs must be absolute. Repository URL inputs containing user information are
  refused; authentication remains the responsibility of the native SVN credential cache or trusted
  operator configuration.
- Baseline, precommit, and safe-operation detail tokens are process-local, expire, and are bound to
  a working copy plus exact explicit paths. Baselines accept files only. Precommit tokens include
  file content hashes, canonical SVN property hashes, status, base revisions, repository policy, diff identity, and observed
  remote revision; commit rechecks them without weakening any ordinary guard. Detailed workflow
  stages stay in bounded memory and are not persisted with durable mutation receipts.
- Precommit evidence is revalidated immediately before invoking `svn commit`. This narrows the
  local check/use interval but cannot freeze files against an unrelated external editor; use one
  writer per working copy and do not share a writable checkout across processes or machines.
- `svn_commit operation:"safe"` requires an exact revision, expected remote revision, valid commit
  message, explicit files, and durable operation ID. It accepts a stronger pre-edit baseline or
  captures the current scoped state internally before update. It stops before
  commit on same-path overlap or postponed conflict, and an interrupted ambiguous operation fails
  closed rather than repeating a mutation.
- SVN and conversion processes inherit the host environment so native credential caches, proxy
  settings, home directories, and configured SSH transports continue to work. Treat MCP process
  environment variables as trusted operator configuration and do not place secrets in debug logs.
- The bundled Windows Subversion runtime is the redistributable VisualSVN command-line package.
  Its source archive hash, individual file hashes, and upstream license texts are retained in the
  repository. The package does not ship separate OpenSSL runtime DLLs.
