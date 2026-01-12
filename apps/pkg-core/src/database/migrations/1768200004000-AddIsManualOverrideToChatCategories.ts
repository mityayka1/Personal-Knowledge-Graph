import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIsManualOverrideToChatCategories1768200004000 implements MigrationInterface {
  name = 'AddIsManualOverrideToChatCategories1768200004000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add is_manual_override column with default false
    await queryRunner.query(`
      ALTER TABLE "chat_categories"
      ADD COLUMN "is_manual_override" BOOLEAN NOT NULL DEFAULT false
    `);

    // Create index for filtering manual overrides (useful for reports/admin)
    await queryRunner.query(`
      CREATE INDEX "idx_chat_categories_manual_override"
      ON "chat_categories" ("is_manual_override")
      WHERE "is_manual_override" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_chat_categories_manual_override"
    `);
    await queryRunner.query(`
      ALTER TABLE "chat_categories"
      DROP COLUMN "is_manual_override"
    `);
  }
}
