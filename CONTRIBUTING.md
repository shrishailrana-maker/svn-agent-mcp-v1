# Contributing

Thanks for taking the time to improve `svn-agent-mcp`.

## Prerequisites

- Windows
- Node.js 20 or newer
- Git
- Access to the public npm registry

The bundled runtime payload under `bin/` is Windows-only. Cross-platform support needs separate
runtime packaging and testing.

## Local Setup

```powershell
npm install
npm run prepare:local
npm test
```

## Development Checks

Before opening a pull request, run:

```powershell
npm run typecheck
npm run prepare:local
npm test
npm audit --audit-level=moderate
```

Use focused tests for parser, guard, and workflow changes when possible. Mutating SVN behavior
should be tested only against temporary repositories.

## Pull Requests

- Keep changes narrowly scoped.
- Update `README.md`, `CHANGELOG.md`, `docs/SPEC.md`, and ADRs when behavior or public contracts change.
- Do not commit generated root `dist/`, `current/`, `releases/`, dependency folders, local caches,
  credentials, keys, certificates, or unrelated files.
- Keep bundled binary changes explicit and update `THIRD_PARTY_NOTICES.md` plus
  `THIRD_PARTY_CHECKSUMS.txt` when `bin/` changes.

## Security

Please do not report vulnerabilities in public issues when private reporting is available. See
`SECURITY.md` for the preferred reporting path.
