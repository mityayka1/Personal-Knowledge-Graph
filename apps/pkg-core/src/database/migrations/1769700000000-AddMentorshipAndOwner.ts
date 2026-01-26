import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMentorshipAndOwner1769700000000 implements MigrationInterface {
  name = 'AddMentorshipAndOwner1769700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Add 'mentorship' to relation_type enum
    // PostgreSQL requires this specific syntax to add values to existing enum
    await queryRunner.query(`
      ALTER TYPE "public"."entity_relations_relation_type_enum"
      ADD VALUE IF NOT EXISTS 'mentorship'
    `);

    // 2. Add is_owner column to entities table
    await queryRunner.query(`
      ALTER TABLE "entities"
      ADD COLUMN "is_owner" BOOLEAN NOT NULL DEFAULT FALSE
    `);

    // 3. Create partial unique index to ensure only one owner
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_entities_is_owner"
      ON "entities" ("is_owner")
      WHERE "is_owner" = TRUE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop the unique index
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_entities_is_owner"`);

    // Drop the is_owner column
    await queryRunner.query(`ALTER TABLE "entities" DROP COLUMN IF EXISTS "is_owner"`);

    // Note: PostgreSQL doesn't support removing enum values easily
    // The 'mentorship' value will remain in the enum but won't affect anything
  }
}
