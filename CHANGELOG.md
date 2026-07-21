# Changelog

All notable user-visible changes are documented here. The project follows Semantic Versioning.

## Unreleased

### Added

- Added a public GHCR deployment path alongside local source builds.
- Added authorization management for one strictly validated Netscape Cookie file per YouTube, Bilibili, X, Facebook, and Douyin platform, with upload, full replacement, status, and deletion controls.

### Changed

- Replaced the bare empty channel message with a guided first-channel action.
- Removed the redundant no-channel-updates message from the dashboard.
- Grouped optional direct-download fields behind a clearer advanced-options section.
- Replaced free-form resolution and transcoding inputs with supported choices.
- Removed the raw yt-dlp format expression and chapter splitting from the direct-download form.
- Removed Vimeo from the officially supported and verified direct-download platforms without adding a domain blacklist; generic HTTPS probing and existing download records remain compatible.

### Security

- Treat saved Cookie files as account login credentials. They persist under `/data`, are included in `/data` backups, and are not yet used by channel synchronization, metadata probing, or media downloads.

### Fixed

- Fixed the published AMD64 image containing ARM64 binaries because the Node base image was pinned to a single-platform digest.
- Fixed interrupted scheduled checks remaining active after restart and permanently blocking channel deletion.

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
