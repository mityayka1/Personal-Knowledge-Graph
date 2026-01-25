import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddConfidenceCheckConstraint1769600000000
  implements MigrationInterface
{
  name = 'AddConfidenceCheckConstraint1769600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add CHECK constraint to ensure confidence is within valid range [0, 1]
    await queryRunner.query(`
      ALTER TABLE pending_confirmations
      ADD CONSTRAINT chk_pending_confirmations_confidence
      CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
    `);

    // Also add CHECK constraint to extracted_events for consistency
    await queryRunner.query(`
      ALTER TABLE extracted_events
      ADD CONSTRAINT chk_extracted_events_confidence
      CHECK (confidence >= 0 AND confidence <= 1)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE extracted_events
      DROP CONSTRAINT IF EXISTS chk_extracted_events_confidence
    `);

    await queryRunner.query(`
      ALTER TABLE pending_confirmations
      DROP CONSTRAINT IF EXISTS chk_pending_confirmations_confidence
    `);
  }
}
