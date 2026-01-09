import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddChatTypeAndTopicToMessages1767977915541
  implements MigrationInterface
{
  name = 'AddChatTypeAndTopicToMessages1767977915541';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add chat_type column - determines import behavior (private chats get auto-entity creation)
    await queryRunner.query(
      `ALTER TABLE "messages" ADD "chat_type" character varying(20)`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "messages"."chat_type" IS 'Type of chat: private, group, supergroup, channel, forum. Private chats trigger auto-entity creation.'`,
    );

    // Add topic_id column - for forum topic support
    await queryRunner.query(
      `ALTER TABLE "messages" ADD "topic_id" integer`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "messages"."topic_id" IS 'Forum topic ID. Each topic in a forum is treated as a separate conversation thread.'`,
    );

    // Add topic_name column - human-readable topic name
    await queryRunner.query(
      `ALTER TABLE "messages" ADD "topic_name" character varying(255)`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "messages"."topic_name" IS 'Forum topic name for display purposes (e.g., "General", "Support").'`,
    );

    // Create index on topic_id for efficient filtering by topic
    await queryRunner.query(
      `CREATE INDEX "IDX_messages_topic_id" ON "messages" ("topic_id") WHERE "topic_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_messages_topic_id"`);
    await queryRunner.query(
      `ALTER TABLE "messages" DROP COLUMN "topic_name"`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" DROP COLUMN "topic_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" DROP COLUMN "chat_type"`,
    );
  }
}
