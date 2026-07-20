# Contributing

Thanks for taking the time to improve `svn-agent-mcp`.

## Prerequisites

- Windows, macOS, or Linux
- Node.js 24.18.0 or newer within the Node 24 LTS line, with npm 11.16.0 or newer within the npm 11 line
- Git
- Access to the public npm registry

Windows uses the bundled runtime payload under `bin/`. On macOS and Linux, install Subversion 1.14
or newer and dos2unix so `svn`, `svnversion`, `svnadmin`, `dos2unix`, and `unix2dos` are on `PATH`.

## Local Setup

```shell
npm ci --strict-allow-scripts
npm run prepare:local
npm test
```

## Development Checks

Before opening a pull request, run:

```shell
npm run check:runtime
npm run typecheck
npm run prepare:local
npm test
npm run test:package
npm run benchmark:responses
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
