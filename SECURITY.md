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
  payloads. They cannot permit credential-like files such as private keys, `.env*`, or `.npmrc`.
- `svn_export` may write to an explicit destination outside a working copy only when the caller sets
  `externalDestAck:true`, and `svn_import` may read an explicit source outside one. Both are refused
  in read-only mode; import scans its source for never-commit paths before invoking SVN.
- Buffered SVN output is limited to 20 MB. Streamed diff lines are limited to 1 MiB, and diff file
  summaries are limited to 20,000 entries. Truncation and over-limit failures are reported rather
  than silently discarded.
