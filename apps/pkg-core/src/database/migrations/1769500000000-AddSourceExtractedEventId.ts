import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSourceExtractedEventId1769500000000 implements MigrationInterface {
  name = 'AddSourceExtractedEventId1769500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add source_extracted_event_id column to pending_confirmations
    await queryRunner.query(`
      ALTER TABLE pending_confirmations
      ADD COLUMN source_extracted_event_id UUID
      REFERENCES extracted_events(id) ON DELETE SET NULL
    `);

    // Create index for the new column
    await queryRunner.query(`
      CREATE INDEX idx_pending_confirmations_source_extracted_event
      ON pending_confirmations(source_extracted_event_id)
      WHERE source_extracted_event_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop index
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_pending_confirmations_source_extracted_event
    `);

    // Drop column
    await queryRunner.query(`
      ALTER TABLE pending_confirmations
      DROP COLUMN IF EXISTS source_extracted_event_id
    `);
  }
}
