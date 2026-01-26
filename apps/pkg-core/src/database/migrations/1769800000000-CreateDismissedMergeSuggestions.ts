import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDismissedMergeSuggestions1769800000000
  implements MigrationInterface
{
  name = 'CreateDismissedMergeSuggestions1769800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE dismissed_merge_suggestions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        primary_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        dismissed_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        dismissed_by VARCHAR(50) DEFAULT 'user',
        dismissed_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(primary_entity_id, dismissed_entity_id)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_dismissed_merge_primary
      ON dismissed_merge_suggestions(primary_entity_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE dismissed_merge_suggestions`);
  }
}
