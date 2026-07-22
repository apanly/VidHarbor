import type { DatabaseConnection } from '../db/client.js';

export function recoverInterruptedChannelSyncs(
  database: DatabaseConnection,
  finishedAt = new Date().toISOString(),
): void {
  const initialReason = 'initial synchronization interrupted by restart';
  const scheduledReason = 'scheduled check interrupted by restart';
  database.exec('BEGIN IMMEDIATE');
  try {
    database
      .prepare(
        `UPDATE channels
         SET last_check_result = 'failed', last_check_error = ?, updated_at = ?
         WHERE id IN (
           SELECT channel_id FROM channel_checks
           WHERE kind = 'scheduled' AND finished_at IS NULL
         )`,
      )
      .run(scheduledReason, finishedAt);
    database
      .prepare(
        `UPDATE channel_checks
         SET finished_at = ?, result = 'failed', failure_reason = ?
         WHERE kind = 'scheduled' AND finished_at IS NULL`,
      )
      .run(finishedAt, scheduledReason);
    database
      .prepare(
        `UPDATE channel_checks
         SET finished_at = ?, result = 'failed', failure_reason = ?
         WHERE kind = 'initial' AND finished_at IS NULL`,
      )
      .run(finishedAt, initialReason);
    database
      .prepare(
        `UPDATE channels
         SET initial_sync_status = 'failed', initial_sync_error = ?, updated_at = ?
         WHERE initial_sync_status = 'syncing'`,
      )
      .run(initialReason, finishedAt);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
