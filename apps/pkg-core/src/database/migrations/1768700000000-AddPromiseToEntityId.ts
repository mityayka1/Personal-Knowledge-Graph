import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPromiseToEntityId1768700000000 implements MigrationInterface {
  name = 'AddPromiseToEntityId1768700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add promise_to_entity_id column to track who the promise was made to
    await queryRunner.query(`
      ALTER TABLE extracted_events
      ADD COLUMN promise_to_entity_id UUID NULL
    `);

    // Add index for efficient queries
    await queryRunner.query(`
      CREATE INDEX idx_extracted_events_promise_to_entity
      ON extracted_events(promise_to_entity_id)
      WHERE promise_to_entity_id IS NOT NULL
    `);

    // Add foreign key constraint
    await queryRunner.query(`
      ALTER TABLE extracted_events
      ADD CONSTRAINT fk_extracted_events_promise_to_entity
      FOREIGN KEY (promise_to_entity_id)
      REFERENCES entities(id)
      ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE extracted_events
      DROP CONSTRAINT IF EXISTS fk_extracted_events_promise_to_entity
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_extracted_events_promise_to_entity
    `);

    await queryRunner.query(`
      ALTER TABLE extracted_events
      DROP COLUMN IF EXISTS promise_to_entity_id
    `);
  }
}
