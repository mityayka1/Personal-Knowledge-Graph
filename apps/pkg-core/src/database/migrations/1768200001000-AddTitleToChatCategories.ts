import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTitleToChatCategories1768200001000 implements MigrationInterface {
  name = 'AddTitleToChatCategories1768200001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add title column to chat_categories
    await queryRunner.query(`
      ALTER TABLE "chat_categories"
      ADD COLUMN "title" VARCHAR(255) NULL
    `);

    // Backfill titles for user chats from entity names
    // For user_XXX chats, get the entity name from interactions
    await queryRunner.query(`
      WITH chat_titles AS (
        SELECT DISTINCT ON (cc.telegram_chat_id)
          cc.telegram_chat_id,
          e.name as title
        FROM chat_categories cc
        INNER JOIN interactions i ON i.source_metadata->>'telegram_chat_id' = cc.telegram_chat_id
        INNER JOIN interaction_participants ip ON ip.interaction_id = i.id
        INNER JOIN entities e ON e.id = ip.entity_id
        WHERE cc.telegram_chat_id LIKE 'user_%'
          AND e.is_bot = false
        ORDER BY cc.telegram_chat_id, e.created_at
      )
      UPDATE chat_categories cc
      SET title = ct.title
      FROM chat_titles ct
      WHERE cc.telegram_chat_id = ct.telegram_chat_id
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chat_categories" DROP COLUMN "title"
    `);
  }
}
