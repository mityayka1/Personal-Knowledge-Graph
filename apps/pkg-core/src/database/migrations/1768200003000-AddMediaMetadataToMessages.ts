import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMediaMetadataToMessages1768200003000 implements MigrationInterface {
  name = 'AddMediaMetadataToMessages1768200003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "messages"
      ADD COLUMN "media_metadata" JSONB NULL
    `);

    // Create index for faster media queries
    await queryRunner.query(`
      CREATE INDEX "IDX_messages_media_metadata" ON "messages" USING GIN ("media_metadata")
      WHERE "media_metadata" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_media_metadata"`);
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "media_metadata"`);
  }
}
