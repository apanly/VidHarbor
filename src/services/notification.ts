import type { DatabaseConnection } from '../db/client.js';
import { BusinessError } from '../errors.js';

export interface Notification {
  readonly id: number;
  readonly createdAt: string;
  readonly readAt: string | null;
  readonly channel: {
    readonly id: number;
    readonly customName: string;
  };
  readonly video: {
    readonly id: number;
    readonly title: string;
    readonly publishedDate: string;
    readonly url: string;
  };
}

interface NotificationRow {
  readonly id: number;
  readonly created_at: string;
  readonly read_at: string | null;
  readonly channel_id: number;
  readonly custom_name: string;
  readonly video_id: number;
  readonly title: string;
  readonly published_date: string;
  readonly source_url: string;
}

export function listNotifications(
  database: DatabaseConnection,
): Notification[] {
  try {
    const rows = database
      .prepare(
        `SELECT n.id, n.created_at, c.id AS channel_id,
                c.custom_name, n.read_at, v.id AS video_id, v.title,
                v.published_date, v.source_url
         FROM notifications n
         JOIN videos v ON v.id = n.video_id
         JOIN channels c ON c.id = v.channel_id
         ORDER BY n.created_at DESC, n.id DESC`,
      )
      .all() as NotificationRow[];
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      readAt: row.read_at,
      channel: {
        id: row.channel_id,
        customName: row.custom_name,
      },
      video: {
        id: row.video_id,
        title: row.title,
        publishedDate: row.published_date,
        url: row.source_url,
      },
    }));
  } catch {
    throw new BusinessError(
      'PERSISTENCE_ERROR',
      'notification persistence failed',
    );
  }
}

function validateNotificationIds(ids: readonly number[]): void {
  if (ids.length === 0) {
    throw new BusinessError('VALIDATION_ERROR', 'notification IDs must not be empty');
  }
  const seen = new Set<number>();
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id < 1 || seen.has(id)) {
      throw new BusinessError('VALIDATION_ERROR', 'invalid notification ID');
    }
    seen.add(id);
  }
}

export function markNotificationsRead(
  database: DatabaseConnection,
  ids: readonly number[],
  now = new Date(),
): number {
  validateNotificationIds(ids);
  if (!Number.isFinite(now.getTime())) {
    throw new BusinessError('VALIDATION_ERROR', 'read time is invalid');
  }
  const readAt = now.toISOString();
  try {
    database.exec('BEGIN IMMEDIATE');
    const find = database.prepare('SELECT id FROM notifications WHERE id = ?');
    const update = database.prepare(
      `UPDATE notifications
       SET read_at = ?
       WHERE id = ? AND read_at IS NULL`,
    );
    let changed = 0;
    for (const id of ids) {
      if (find.get(id) === undefined) {
        throw new BusinessError('NOTIFICATION_NOT_FOUND', 'notification not found');
      }
      changed += update.run(readAt, id).changes;
    }
    database.exec('COMMIT');
    return changed;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The transaction may not have started.
    }
    if (error instanceof BusinessError) throw error;
    throw new BusinessError(
      'PERSISTENCE_ERROR',
      'notification persistence failed',
    );
  }
}
