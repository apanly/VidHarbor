# Changelog

All notable user-visible changes are documented here. The project follows Semantic Versioning.

## Unreleased

### Added

- Added a fixed bilingual interface for Chinese (`zh-CN`) and English (`en`) across all 10 pages, including server-rendered content, dynamic states, errors, confirmations, accessibility labels, the System Guide, and Download Preview.
- Added a page-level Chinese / English switcher backed by the `vidharbor_language` session Cookie. It preserves the current page across refreshes and in-app navigation; missing, cleared, or invalid values restore the Chinese default without browser-language negotiation.
- Added automated bilingual contract coverage and isolated-browser acceptance for all 10 pages, including language selection, dynamic UI states, README sources, and localized date and number display.
- Added a public GHCR deployment path alongside local source builds.
- Added authorization management for one strictly validated Netscape Cookie file per YouTube, Bilibili, X, Facebook, and Douyin platform, with upload, full replacement, status, and deletion controls.
- Added durable download status `deleting` for completed-archive removal, with startup recovery and HTTP `DOWNLOAD_DELETE_IN_PROGRESS` (409) when another delete already owns the row.
- Documented the unreleased download-delete state machine and direct-download field contract in `docs/designs/unreleased/download-delete-and-direct-options.md`.

### Changed

- Localized dates and human-readable numbers with the selected interface language while keeping routes, API requests and responses, status values, database schema and data, and all existing business workflows unchanged.
- Replaced the bare empty channel message with a guided first-channel action.
- Removed the redundant no-channel-updates message from the dashboard.
- Grouped optional direct-download fields behind a clearer advanced-options section.
- Replaced free-form resolution and transcoding inputs with supported choices.
- Removed the raw yt-dlp format expression and chapter splitting from the direct-download form.
- Removed the direct-download `filenamePreset` field from the UI and API; main media filenames keep using the resource ID.
- Included `deleting` in the download “active” list/SSE group and channel-detail “删除中” presentation.
- Removed Vimeo from the officially supported and verified direct-download platforms without adding a domain blacklist; generic HTTPS probing and existing download records remain compatible.

### Security

- Treat saved Cookie files as account login credentials. They persist under `/data`, are included in `/data` backups, and are not yet used by channel synchronization, metadata probing, or media downloads.

### Fixed

- Fixed the published AMD64 image containing ARM64 binaries because the Node base image was pinned to a single-platform digest.
- Fixed interrupted scheduled checks remaining active after restart and permanently blocking channel deletion.
- Fixed completed-download deletion so failed recursive cleanup restores `completed` only when the persisted main media path is still a non-empty regular file; otherwise the row stays `deleting` for recovery.

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
