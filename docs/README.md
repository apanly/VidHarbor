# Documentation

## User and Operator Documentation

- `../README.md`: current features, supported inputs, deployment, persistence, backup, upgrade, and operational boundaries.
- `../SECURITY.md`: deployment trust boundary and private vulnerability reporting.
- `../CONTRIBUTING.md`: development and pull request requirements.
- `../CHANGELOG.md`: user-visible release history.
- `testing/stable-docker-test-environment.md`: repeatable ARM64 Docker acceptance procedure.

## Code Wiki (current contract)

- [`../openwiki/`](../openwiki/): auto-generated code wiki (`openwiki/`) describing the current stable contract — architecture, error→HTTP mapping, download state machine, API routes, database, security, build and tests. This is now the primary developer reference for the current code; regenerate it after contract changes instead of hand-editing.
- `spec/README.md`: downgraded to a redirect pointing at `../openwiki/`; not maintained here anymore.

## Historical Design Records

The files under `designs/` are historical development records. They document the requirements and decisions used while implementing a version; they are not a list of currently open defects. Current behavior is defined by the root `README.md`, current source code, and tests. For the machine-readable stable contract, see [Code Wiki](#code-wiki-current-contract).

See `designs/README.md` before interpreting review or bugfix records.
