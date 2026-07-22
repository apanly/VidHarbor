# Unreleased contract: download delete state machine and direct-download fields

Historical `docs/designs/v0.1/*` snapshots are not rewritten. This note is the
current contract for unreleased code on the default branch.

## Direct-download advanced options

- The public form and API accept only these advanced option fields:
  `mediaType`, `format`, `quality`, `codec`, `writeSubtitles`, `splitChapters`,
  `timeRangeStart`, `timeRangeEnd`.
- `filenamePreset` is **not** part of the public request contract. It is not
  accepted by the API, not shown in the UI, and not used by the worker.
- Main media files continue to use the resource ID template
  `%(id)s.%(ext)s` under the download-id directory layout.

## Download status `deleting`

### Meaning

- `deleting` is a durable intermediate status for a completed download whose
  archive removal is in progress or interrupted.
- The row keeps `output_path` and a null `failure_reason` while `status =
  'deleting'`.
- Schema migration `008-download-deleting-status.sql` adds the status and CHECK
  constraints.

### Who may run file cleanup

- Only the HTTP request that successfully transitions
  `completed → deleting` may quarantine and remove files.
- A later HTTP `DELETE` against a row already in `deleting` returns
  `DOWNLOAD_DELETE_IN_PROGRESS` (HTTP 409) and must not touch the filesystem.
- Startup (`recoverDeletingDownloads`) is the only non-HTTP owner of leftover
  `deleting` rows and converges them before accepting traffic.

### Failure and recovery

- SQLite transactions around status changes and hard-delete remain fully
  synchronous (no `await` while a transaction is open).
- Archive cleanup uses a fixed quarantine path
  `.vidharbor-delete/<downloadId>/` under the real download root.
- Recursive `rm` is not atomic. If cleanup fails after quarantine:
  1. Best-effort rename of residual quarantine material back to the original
     archive path.
  2. Re-validate the **persisted** `output_path` as a readable non-empty regular
     file under the download mount.
  3. Restore `status = completed` **only** when that validation succeeds.
  4. If the main media is missing or invalid, keep `status = deleting` so startup
     recovery can delete residual files and the row.
- If both original and quarantine paths are truly missing (`ENOENT` only;
  `EACCES`/`EIO` fail closed without guessing), startup hard-deletes the row.

### Lists and UI

- Download list / SSE “active” tab includes
  `pending | downloading | running | deleting`.
- Failed tab remains `failed | canceled | interrupted`.
- Channel detail shows label `删除中` and disables selection for videos whose
  `downloadStatus` is `deleting` (same as pending/running/completed).

### Error codes

| Code | HTTP | When |
| --- | --- | --- |
| `DOWNLOAD_DELETE_FAILED` | 422 | Archive validation or cleanup failed; record retained as `completed` or `deleting` per rules above |
| `DOWNLOAD_DELETE_IN_PROGRESS` | 409 | HTTP DELETE observed an existing `deleting` row (or lost the ownership race) |
| `DOWNLOAD_NOT_FOUND` | 404 | Row already gone after a successful concurrent delete |
| `DOWNLOAD_FILE_UNAVAILABLE` | 404 | Completed delete requested but archive is not reachable under the mount |

### Concurrency and channel safety

- `deleting` counts as an existing download for duplicate-download checks.
- Channel deletion still sees the row and returns `CHANNEL_IN_USE` while
  `deleting` is present.
