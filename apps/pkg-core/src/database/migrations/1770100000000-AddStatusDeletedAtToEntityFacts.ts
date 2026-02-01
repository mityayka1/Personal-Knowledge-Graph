import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStatusDeletedAtToEntityFacts1770100000000
  implements MigrationInterface
{
  name = 'AddStatusDeletedAtToEntityFacts1770100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create enum type for status
    await queryRunner.query(`
      CREATE TYPE entity_fact_status AS ENUM ('draft', 'active')
    `);

    // Add status column with default 'active' for existing data
    await queryRunner.query(`
      ALTER TABLE entity_facts
      ADD COLUMN status entity_fact_status NOT NULL DEFAULT 'active'
    `);

    // Add soft delete column
    await queryRunner.query(`
      ALTER TABLE entity_facts
      ADD COLUMN deleted_at TIMESTAMP WITH TIME ZONE
    `);

    // Create index on status
    await queryRunner.query(`
      CREATE INDEX idx_entity_facts_status ON entity_facts(status)
    `);

    // Create index on deleted_at for soft delete queries
    await queryRunner.query(`
      CREATE INDEX idx_entity_facts_deleted_at ON entity_facts(deleted_at)
      WHERE deleted_at IS NOT NULL
    `);

    // Create partial index for active facts (most common query pattern)
    // This speeds up queries that filter by entity_id and fact_type for active facts
    await queryRunner.query(`
      CREATE INDEX idx_entity_facts_active ON entity_facts(entity_id, fact_type)
      WHERE status = 'active' AND deleted_at IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes
    await queryRunner.query(`DROP INDEX IF EXISTS idx_entity_facts_active`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_entity_facts_deleted_at`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_entity_facts_status`);

    // Drop columns
    await queryRunner.query(`
      ALTER TABLE entity_facts DROP COLUMN deleted_at
    `);

    await queryRunner.query(`
      ALTER TABLE entity_facts DROP COLUMN status
    `);

    // Drop enum type
    await queryRunner.query(`DROP TYPE IF EXISTS entity_fact_status`);
  }
}
