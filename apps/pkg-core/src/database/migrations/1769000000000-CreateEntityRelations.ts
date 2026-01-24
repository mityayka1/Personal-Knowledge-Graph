import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Create entity_relations and entity_relation_members tables.
 *
 * EntityRelation (Вариант 4) — связи между сущностями с ролями:
 * - Поддержка N-арных связей (team, family)
 * - Soft delete через validUntil
 * - Trigger для очистки пустых связей
 */
export class CreateEntityRelations1769000000000 implements MigrationInterface {
  name = 'CreateEntityRelations1769000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create entity_relations table
    await queryRunner.query(`
      CREATE TABLE "entity_relations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "relation_type" varchar(50) NOT NULL,
        "metadata" jsonb,
        "source" varchar(20) NOT NULL DEFAULT 'extracted',
        "confidence" decimal(3,2),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_entity_relations" PRIMARY KEY ("id")
      )
    `);

    // Create entity_relation_members table
    await queryRunner.query(`
      CREATE TABLE "entity_relation_members" (
        "relation_id" uuid NOT NULL,
        "entity_id" uuid NOT NULL,
        "role" varchar(50) NOT NULL,
        "label" varchar(100),
        "properties" jsonb,
        "valid_until" TIMESTAMP,
        CONSTRAINT "PK_entity_relation_members" PRIMARY KEY ("relation_id", "entity_id", "role"),
        CONSTRAINT "FK_relation_members_relation" FOREIGN KEY ("relation_id")
          REFERENCES "entity_relations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_relation_members_entity" FOREIGN KEY ("entity_id")
          REFERENCES "entities"("id") ON DELETE CASCADE
      )
    `);

    // Create indexes
    await queryRunner.query(`
      CREATE INDEX "idx_relation_members_entity"
      ON "entity_relation_members"("entity_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_relation_members_valid"
      ON "entity_relation_members"("entity_id")
      WHERE "valid_until" IS NULL
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_relations_type"
      ON "entity_relations"("relation_type")
    `);

    // Create trigger function to cleanup empty relations
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION cleanup_empty_relations()
      RETURNS TRIGGER AS $$
      BEGIN
        DELETE FROM entity_relations r
        WHERE NOT EXISTS (
          SELECT 1 FROM entity_relation_members m
          WHERE m.relation_id = r.id AND m.valid_until IS NULL
        );
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);

    // Create trigger
    await queryRunner.query(`
      CREATE TRIGGER trg_cleanup_relations
      AFTER UPDATE OR DELETE ON entity_relation_members
      FOR EACH STATEMENT EXECUTE FUNCTION cleanup_empty_relations()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop trigger
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_cleanup_relations ON entity_relation_members
    `);

    // Drop function
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS cleanup_empty_relations()
    `);

    // Drop tables (cascade will handle foreign keys)
    await queryRunner.query(`DROP TABLE IF EXISTS "entity_relation_members"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "entity_relations"`);
  }
}
