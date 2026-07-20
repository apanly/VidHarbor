# Changelog

All notable user-visible changes are documented here. The project follows Semantic Versioning.

## Unreleased

### Added

- Added a public GHCR deployment path alongside local source builds.

### Fixed

- Fixed the published AMD64 image containing ARM64 binaries because the Node base image was pinned to a single-platform digest.
- Fixed interrupted scheduled checks remaining active after restart and permanently blocking channel deletion.
- Replaced the bare empty channel message with a guided first-channel action.
- Removed the redundant no-channel-updates message from the dashboard.
- Grouped optional direct-download fields behind a clearer advanced-options section.
- Removed the raw yt-dlp format expression from the direct-download form.
- Removed chapter splitting from the direct-download form because it adds post-processing rather than reducing download time.

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
