import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIsBotToEntity1768200000000 implements MigrationInterface {
  name = 'AddIsBotToEntity1768200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add is_bot column to entities table
    await queryRunner.query(`
      ALTER TABLE "entities" 
      ADD COLUMN "is_bot" BOOLEAN NOT NULL DEFAULT FALSE
    `);

    // Create partial index for bot entities
    await queryRunner.query(`
      CREATE INDEX "idx_entities_is_bot" 
      ON "entities" ("is_bot") 
      WHERE "is_bot" = true
    `);

    // Backfill: Update is_bot based on EntityIdentifier metadata
    await queryRunner.query(`
      UPDATE "entities" e
      SET "is_bot" = true
      FROM "entity_identifiers" ei
      WHERE ei.entity_id = e.id
        AND ei.metadata->>'isBot' = 'true'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_entities_is_bot"`);
    await queryRunner.query(`ALTER TABLE "entities" DROP COLUMN "is_bot"`);
  }
}
