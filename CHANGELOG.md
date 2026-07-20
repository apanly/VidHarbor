# Changelog

All notable user-visible changes are documented here. The project follows Semantic Versioning.

## 0.2.0 - 2026-07-20

### Added

- Added one yt-dlp task manager for media downloads, metadata probes, initial channel synchronization, manual checks, and scheduled checks.
- Added unified queued, running, succeeded, failed, and canceled task snapshots.
- Added task status tables to the dashboard, including all active tasks and the 30 most recent terminal tasks.

### Changed

- Limited only media downloads by the configured download concurrency; all other yt-dlp task types start independently.
- Changed the dashboard to show every channel whose latest check found updates, without pagination.
- Moved task cancellation and shutdown cleanup behind the unified manager.
- Bound the default Compose port to localhost.
- Added Docker image support and CI validation for both Linux AMD64 and ARM64.

### Security

- Kept yt-dlp subprocess execution behind one controlled entry point with shared cancellation and redacted task failures.
