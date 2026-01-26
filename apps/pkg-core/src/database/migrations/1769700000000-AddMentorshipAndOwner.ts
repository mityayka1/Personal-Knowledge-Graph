import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMentorshipAndOwner1769700000000 implements MigrationInterface {
  name = 'AddMentorshipAndOwner1769700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Note: relation_type is VARCHAR, not PostgreSQL enum.
    // No ALTER TYPE needed - 'mentorship' value is defined in TypeScript enum only.

    // 1. Add is_owner column to entities table
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

    // Note: 'mentorship' is just a TypeScript enum value, no DB cleanup needed
  }
}
