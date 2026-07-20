# Stable Docker Test Environment

## Purpose

This document defines the stable Docker test environment for VidHarbor release acceptance.

The goal is not to prove every real network condition. The goal is to prove that the application image, container startup, SQLite persistence, download mount, health endpoint, and basic API contracts work in one fixed local Docker baseline.

## Fixed Baseline

Use this baseline unless a change explicitly updates this document:

- Host Docker server: Linux `amd64` or `arm64`
- Docker Engine: `29.4.0`
- Docker Compose: `v5.1.2`
- Application image tag: `vidharbor:v0.2`
- Container database path: `/data/vidharbor.db`
- Container downloads mount: `/downloads`
- Application port inside container: `3000`

Do not treat architectures other than `amd64` and `arm64`, multi-node Docker, Kubernetes, or public internet deployment as covered by this environment. Those need separate validation.

## Stable Test Scope

This environment validates:

- Docker image builds successfully from the repository.
- Container starts with `yt-dlp`, `ffmpeg`, SQLite, `/data`, and `/downloads` available.
- Runtime image contains the project `LICENSE`.
- The home page responds successfully.
- The read-only database page responds successfully.
- JSON API reads settings successfully.
- Settings written to SQLite survive container restart when the same `/data` mount is reused.
- `/downloads` is mounted and accepted as a valid download root.

This environment does not validate:

- Real YouTube or Bilibili availability, rate limits, cookies, or metadata changes.
- Real proxy connectivity.
- Long-running production stability.
- Host backups, monitoring, log rotation, or disk pressure.
- Architectures other than `amd64` and `arm64`.

## Preflight Commands

Run these before Docker acceptance:

```sh
npm test -- --run --maxWorkers=1
npm run build
docker version
docker compose version
docker compose config
```

Acceptance requires tests and build to exit with status `0`. Sass deprecation warnings from Bootstrap do not fail this baseline unless Sass exits non-zero.

## Build Image

Build the stable candidate image:

```sh
docker compose build
```

Verify the image exists and matches the host's supported Linux architecture:

```sh
docker image inspect vidharbor:v0.2 \
  --format 'Image={{.Id}} Architecture={{.Architecture}} Os={{.Os}} Size={{.Size}}'
docker run --rm --entrypoint sh vidharbor:v0.2 \
  -c "grep -q 'GNU AFFERO GENERAL PUBLIC LICENSE' /app/LICENSE"
```

Expected contract:

- `Architecture=amd64` or `Architecture=arm64`
- `Os=linux`
- image tag `vidharbor:v0.2` exists
- `/app/LICENSE` contains the AGPL license text

## Startup Smoke Test

Use isolated host directories so the test does not depend on previous state:

```sh
DATA_DIR=$(mktemp -d /tmp/vidharbor-data.XXXXXX)
DL_DIR=$(mktemp -d /tmp/vidharbor-downloads.XXXXXX)
CID=$(docker run --rm -d \
  -p 127.0.0.1::3000 \
  -v "$DATA_DIR:/data" \
  -v "$DL_DIR:/downloads" \
  vidharbor:v0.2)
PORT=$(docker port "$CID" 3000/tcp | sed 's/.*://')
```

Wait for the settings API to respond:

```sh
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/settings"; then
    break
  fi
  sleep 1
done
```

Verify the home page:

```sh
curl -fsS "http://127.0.0.1:${PORT}/" >/tmp/vidharbor-home.html
grep -q 'VidHarbor' /tmp/vidharbor-home.html
```

Verify the read-only database page:

```sh
curl -fsS "http://127.0.0.1:${PORT}/database" >/tmp/vidharbor-database.html
grep -q '数据库' /tmp/vidharbor-database.html
```

Verify startup logs:

```sh
docker logs "$CID"
```

Expected log events include:

- `database_migrated`
- `downloads_recovered`
- `download_worker_started`
- `scheduler_started`
- `http_started`

Stop the container after this smoke test:

```sh
docker stop "$CID"
```

## Persistence Restart Test

Use the same `DATA_DIR` and `DL_DIR` across two container runs.

First run:

```sh
CID1=$(docker run --rm -d \
  -p 127.0.0.1::3000 \
  -v "$DATA_DIR:/data" \
  -v "$DL_DIR:/downloads" \
  vidharbor:v0.2)
PORT1=$(docker port "$CID1" 3000/tcp | sed 's/.*://')
ORIGIN1="http://127.0.0.1:${PORT1}"

for i in $(seq 1 30); do
  if curl -fsS "$ORIGIN1/api/settings" >/dev/null; then
    break
  fi
  sleep 1
done

curl -fsS -X PUT "$ORIGIN1/api/settings" \
  -H 'Content-Type: application/json' \
  -H "Origin: $ORIGIN1" \
  --data '{"downloadRoot":"/downloads","globalCheckIntervalMinutes":15,"downloadConcurrency":2}'

docker stop "$CID1"
```

Second run:

```sh
CID2=$(docker run --rm -d \
  -p 127.0.0.1::3000 \
  -v "$DATA_DIR:/data" \
  -v "$DL_DIR:/downloads" \
  vidharbor:v0.2)
PORT2=$(docker port "$CID2" 3000/tcp | sed 's/.*://')

for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT2}/api/settings"; then
    break
  fi
  sleep 1
done

docker stop "$CID2"
```

Expected API response after restart:

```json
{"downloadRoot":"/downloads","globalCheckIntervalMinutes":15,"downloadConcurrency":2}
```

Also verify that the host data directory contains SQLite files:

```sh
ls -l "$DATA_DIR"
```

Expected files include `vidharbor.db`; WAL/SHM files may also be present while SQLite has used WAL mode.

## Failure Boundary Checks

Run these only when checking startup failure behavior.

### Unwritable Or Missing Downloads Mount

Start a container without a writable `/downloads` mount, or mount a path that the container user cannot write. The server must fail startup with a clear `startup_failed` log. It must not silently use another downloads directory.

### Missing Write Origin On API Mutations

Write APIs require a matching `Origin` header. A mutation without the header should return a validation error. This is expected and should not be treated as a persistence failure.

## Cleanup Rules

Only clean resources that are known to belong to VidHarbor tests.

Allowed cleanup:

```sh
docker ps -a --filter ancestor=vidharbor:v0.2
docker image prune -f
```

Allowed when the target is confirmed obsolete:

```sh
docker rm <stopped-vidharbor-test-container-id>
docker rmi <obsolete-vidharbor-test-tag>
```

Do not remove unrelated running services, such as `helm`, `new-api`, `postgres`, `redis`, or local development containers. Do not delete Docker volumes unless the volume is explicitly identified as a disposable VidHarbor test volume.

## Acceptance Statement

A Docker test run passes this baseline when all of the following are true:

- `npm test -- --run --maxWorkers=1` passes.
- `npm run build` passes.
- `docker compose config` passes.
- `docker compose build` produces `vidharbor:v0.2` for the host's `linux/amd64` or `linux/arm64` architecture.
- A fresh container starts and serves `/`, `/database`, and `/api/settings`.
- Startup logs contain the required lifecycle events.
- Settings persisted in `/data/vidharbor.db` survive container restart.
- No unrelated Docker services were stopped or deleted during cleanup.
