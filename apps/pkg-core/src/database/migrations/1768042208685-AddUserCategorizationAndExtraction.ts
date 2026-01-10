import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserCategorizationAndExtraction1768042208685 implements MigrationInterface {
  name = 'AddUserCategorizationAndExtraction1768042208685';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create chat_categories table
    await queryRunner.query(`
      CREATE TABLE "chat_categories" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "telegram_chat_id" varchar(100) NOT NULL,
        "category" varchar(20) NOT NULL DEFAULT 'mass',
        "participants_count" integer,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_chat_categories_telegram_chat_id" UNIQUE ("telegram_chat_id"),
        CONSTRAINT "PK_chat_categories" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_chat_categories_telegram_chat_id" ON "chat_categories" ("telegram_chat_id")`);

    // Create group_memberships table
    await queryRunner.query(`
      CREATE TABLE "group_memberships" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "telegram_chat_id" varchar(100) NOT NULL,
        "entity_id" uuid,
        "telegram_user_id" varchar(100) NOT NULL,
        "display_name" varchar(255),
        "joined_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "left_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_group_memberships" PRIMARY KEY ("id"),
        CONSTRAINT "FK_group_memberships_entity" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_group_memberships_telegram_chat_id" ON "group_memberships" ("telegram_chat_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_group_memberships_telegram_user_id" ON "group_memberships" ("telegram_user_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_group_memberships_chat_user" ON "group_memberships" ("telegram_chat_id", "telegram_user_id")`);

    // Create entity_events table
    await queryRunner.query(`
      CREATE TABLE "entity_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "entity_id" uuid NOT NULL,
        "related_entity_id" uuid,
        "event_type" varchar(20) NOT NULL,
        "title" varchar(255),
        "description" text,
        "event_date" TIMESTAMP WITH TIME ZONE,
        "status" varchar(20) NOT NULL DEFAULT 'scheduled',
        "confidence" numeric(3,2),
        "source_message_id" uuid,
        "source_quote" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_entity_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_entity_events_entity" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_entity_events_related_entity" FOREIGN KEY ("related_entity_id") REFERENCES "entities"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_entity_events_source_message" FOREIGN KEY ("source_message_id") REFERENCES "messages"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_entity_events_entity" ON "entity_events" ("entity_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_entity_events_related_entity" ON "entity_events" ("related_entity_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_entity_events_event_date" ON "entity_events" ("event_date")`);
    await queryRunner.query(`CREATE INDEX "IDX_entity_events_status" ON "entity_events" ("status") WHERE status = 'scheduled'`);

    // Add creation_source to entities
    await queryRunner.query(`ALTER TABLE "entities" ADD "creation_source" varchar(20) DEFAULT 'manual'`);

    // Add reply_to_source_message_id to messages
    await queryRunner.query(`ALTER TABLE "messages" ADD "reply_to_source_message_id" varchar(100)`);

    // Add extraction_status to messages
    await queryRunner.query(`ALTER TABLE "messages" ADD "extraction_status" varchar(20) DEFAULT 'unprocessed'`);

    // Add extraction_metadata to messages
    await queryRunner.query(`ALTER TABLE "messages" ADD "extraction_metadata" jsonb`);

    // Create index for extraction status
    await queryRunner.query(`CREATE INDEX "IDX_messages_extraction" ON "messages" ("extraction_status", "sender_entity_id")`);

    // Add default settings for categorization and extraction
    await queryRunner.query(`
      INSERT INTO "settings" ("key", "value", "description", "category") VALUES
      ('categorization.workingGroupThreshold', '20', 'Maximum participants for working group category', 'categorization'),
      ('extraction.extractDelayTime', '600000', 'Debounce delay for extraction in milliseconds (10 minutes)', 'extraction'),
      ('extraction.minMessageLength', '20', 'Minimum message length for extraction', 'extraction')
      ON CONFLICT ("key") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove settings
    await queryRunner.query(`DELETE FROM "settings" WHERE "key" IN ('categorization.workingGroupThreshold', 'extraction.extractDelayTime', 'extraction.minMessageLength')`);

    // Remove index for extraction status
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_extraction"`);

    // Remove columns from messages
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "extraction_metadata"`);
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "extraction_status"`);
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "reply_to_source_message_id"`);

    // Remove column from entities
    await queryRunner.query(`ALTER TABLE "entities" DROP COLUMN IF EXISTS "creation_source"`);

    // Drop entity_events table
    await queryRunner.query(`DROP TABLE IF EXISTS "entity_events"`);

    // Drop group_memberships table
    await queryRunner.query(`DROP TABLE IF EXISTS "group_memberships"`);

    // Drop chat_categories table
    await queryRunner.query(`DROP TABLE IF EXISTS "chat_categories"`);
  }
}
