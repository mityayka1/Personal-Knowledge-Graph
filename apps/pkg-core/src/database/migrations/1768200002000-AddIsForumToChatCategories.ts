import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIsForumToChatCategories1768200002000 implements MigrationInterface {
  name = 'AddIsForumToChatCategories1768200002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add is_forum column to chat_categories
    await queryRunner.query(`
      ALTER TABLE "chat_categories"
      ADD COLUMN "is_forum" BOOLEAN NOT NULL DEFAULT FALSE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chat_categories" DROP COLUMN "is_forum"
    `);
  }
}
