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
  summaries are limited to 20,000 entries. Truncation and over-limit failures are reported rather
  than silently discarded.
- Response redaction covers credential-bearing URLs and common secret query parameters, but it is
  not a substitute for keeping credentials out of versioned file content and commit messages.
- SVN and conversion processes inherit the host environment so native credential caches, proxy
  settings, home directories, and configured SSH transports continue to work. Treat MCP process
  environment variables as trusted operator configuration and do not place secrets in debug logs.
- The bundled Windows Subversion runtime is the redistributable VisualSVN command-line package.
  Its source archive hash, individual file hashes, and upstream license texts are retained in the
  repository. The package does not ship separate OpenSSL runtime DLLs.
