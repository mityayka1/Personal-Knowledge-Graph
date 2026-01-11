import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration to fix interaction timestamps.
 *
 * Bug #32: Interaction startedAt/endedAt were set to import time instead of
 * actual message timestamps.
 *
 * This migration:
 * 1. Updates startedAt to MIN(message.timestamp) for each interaction
 * 2. Updates endedAt to MAX(message.timestamp) for completed interactions
 */
export class FixInteractionTimestamps1768139220000 implements MigrationInterface {
  name = 'FixInteractionTimestamps1768139220000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Fix startedAt: set to earliest message timestamp
    await queryRunner.query(`
      UPDATE interactions i
      SET started_at = sub.min_timestamp
      FROM (
        SELECT m.interaction_id, MIN(m.timestamp) as min_timestamp
        FROM messages m
        GROUP BY m.interaction_id
      ) sub
      WHERE i.id = sub.interaction_id
      AND sub.min_timestamp IS NOT NULL
    `);

    // Fix endedAt for completed sessions: set to latest message timestamp
    await queryRunner.query(`
      UPDATE interactions i
      SET ended_at = sub.max_timestamp
      FROM (
        SELECT m.interaction_id, MAX(m.timestamp) as max_timestamp
        FROM messages m
        GROUP BY m.interaction_id
      ) sub
      WHERE i.id = sub.interaction_id
      AND i.status = 'completed'
      AND sub.max_timestamp IS NOT NULL
    `);

    // Also update updatedAt to match the latest message timestamp
    // This ensures gap calculation works correctly for existing sessions
    await queryRunner.query(`
      UPDATE interactions i
      SET updated_at = sub.max_timestamp
      FROM (
        SELECT m.interaction_id, MAX(m.timestamp) as max_timestamp
        FROM messages m
        GROUP BY m.interaction_id
      ) sub
      WHERE i.id = sub.interaction_id
      AND sub.max_timestamp IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Cannot reliably restore original timestamps (they were import time)
    // This migration is not reversible in a meaningful way
    // Log a warning instead
    console.warn(
      'FixInteractionTimestamps: down migration does nothing - original timestamps were incorrect',
    );
  }
}
