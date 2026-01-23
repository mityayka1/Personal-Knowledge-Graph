import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFactFusionFields1768900000000 implements MigrationInterface {
  name = 'AddFactFusionFields1768900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add rank column for Wikidata-style ranking (preferred > normal > deprecated)
    await queryRunner.query(`
      ALTER TABLE entity_facts
      ADD COLUMN IF NOT EXISTS rank VARCHAR(20) DEFAULT 'normal'
    `);

    // Add superseded_by for fact linking (points to newer version)
    await queryRunner.query(`
      ALTER TABLE entity_facts
      ADD COLUMN IF NOT EXISTS superseded_by UUID REFERENCES entity_facts(id) ON DELETE SET NULL
    `);

    // Add conflict tracking fields
    await queryRunner.query(`
      ALTER TABLE entity_facts
      ADD COLUMN IF NOT EXISTS needs_review BOOLEAN DEFAULT FALSE
    `);

    await queryRunner.query(`
      ALTER TABLE entity_facts
      ADD COLUMN IF NOT EXISTS review_reason TEXT
    `);

    // Add confirmation tracking (how many times fact was confirmed from different sources)
    await queryRunner.query(`
      ALTER TABLE entity_facts
      ADD COLUMN IF NOT EXISTS confirmation_count INTEGER DEFAULT 1
    `);

    // Create index for efficient querying of preferred facts
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_entity_facts_rank
      ON entity_facts(entity_id, fact_type, rank)
    `);

    // Create partial index for facts needing review
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_entity_facts_needs_review
      ON entity_facts(id) WHERE needs_review = TRUE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes
    await queryRunner.query(`DROP INDEX IF EXISTS idx_entity_facts_needs_review`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_entity_facts_rank`);

    // Drop columns
    await queryRunner.query(`ALTER TABLE entity_facts DROP COLUMN IF EXISTS confirmation_count`);
    await queryRunner.query(`ALTER TABLE entity_facts DROP COLUMN IF EXISTS review_reason`);
    await queryRunner.query(`ALTER TABLE entity_facts DROP COLUMN IF EXISTS needs_review`);
    await queryRunner.query(`ALTER TABLE entity_facts DROP COLUMN IF EXISTS superseded_by`);
    await queryRunner.query(`ALTER TABLE entity_facts DROP COLUMN IF EXISTS rank`);
  }
}
