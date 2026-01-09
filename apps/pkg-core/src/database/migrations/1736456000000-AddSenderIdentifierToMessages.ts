import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSenderIdentifierToMessages1736456000000 implements MigrationInterface {
    name = 'AddSenderIdentifierToMessages1736456000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Add sender_identifier_type column
        await queryRunner.query(`
            ALTER TABLE "messages"
            ADD COLUMN "sender_identifier_type" character varying(50)
        `);

        // Add sender_identifier_value column
        await queryRunner.query(`
            ALTER TABLE "messages"
            ADD COLUMN "sender_identifier_value" character varying(255)
        `);

        // Create index on sender_identifier_value for efficient lookups during resolution
        await queryRunner.query(`
            CREATE INDEX "IDX_messages_sender_identifier_value"
            ON "messages" ("sender_identifier_value")
        `);

        // Create composite index for type+value lookups
        await queryRunner.query(`
            CREATE INDEX "IDX_messages_sender_identifier"
            ON "messages" ("sender_identifier_type", "sender_identifier_value")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_messages_sender_identifier"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_messages_sender_identifier_value"`);
        await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "sender_identifier_value"`);
        await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "sender_identifier_type"`);
    }
}
