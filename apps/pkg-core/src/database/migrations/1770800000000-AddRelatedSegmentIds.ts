import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add related_segment_ids column to topical_segments table.
 *
 * Stores bidirectional cross-chat topic links between segments.
 * Used for linking related discussions across different chats
 * (same activity, keyword overlap, participant+time proximity).
 *
 * Task 3.7: Cross-Chat Topic Linking
 */
export class AddRelatedSegmentIds1770800000000 implements MigrationInterface {
  name = 'AddRelatedSegmentIds1770800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE topical_segments
      ADD COLUMN related_segment_ids UUID[] DEFAULT '{}'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE topical_segments
      DROP COLUMN IF EXISTS related_segment_ids
    `);
  }
}
