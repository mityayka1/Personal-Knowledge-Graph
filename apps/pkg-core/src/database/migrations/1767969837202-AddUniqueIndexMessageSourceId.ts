import { MigrationInterface, QueryRunner } from "typeorm";

export class AddUniqueIndexMessageSourceId1767969837202 implements MigrationInterface {
    name = 'AddUniqueIndexMessageSourceId1767969837202'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Create unique partial index on (interaction_id, source_message_id)
        // This prevents duplicate messages in the same interaction when source_message_id is present
        // The partial index excludes null source_message_id values
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "IDX_messages_interaction_source_unique"
            ON "messages" ("interaction_id", "source_message_id")
            WHERE "source_message_id" IS NOT NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX IF EXISTS "IDX_messages_interaction_source_unique"
        `);
    }
}
