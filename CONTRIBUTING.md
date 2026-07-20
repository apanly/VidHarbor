# Contributing to VidHarbor

## Scope

Keep changes within the documented product boundary in `README.md`. New input formats, task types, states, fallback behavior, compatibility layers, dependencies, or deployment targets require an explicit proposal before implementation.

## Development Environment

- Node.js 24.x
- npm from the pinned lockfile workflow
- Docker and Docker Compose for container validation
- Linux AMD64 or ARM64 for local Docker image validation; CI validates both

Install dependencies and run the required checks:

```sh
npm ci
npm test -- --run --maxWorkers=1
npm run build
docker compose config --quiet
```

The automated test suite is offline and must not require real site credentials, proxy credentials, or network access.

## Pull Requests

1. Keep each pull request focused on one confirmed behavior.
2. Add tests for supported behavior and rejected non-contract inputs.
3. Update `README.md`, `CHANGELOG.md`, and relevant documents when user-visible behavior changes.
4. Do not commit SQLite files, downloads, credentials, `.env` files, generated `dist/`, or `node_modules/`.
5. Explain the user-visible change, compatibility impact, and validation commands in the pull request description.

By contributing, you agree that your contribution is licensed under `AGPL-3.0-only`.
