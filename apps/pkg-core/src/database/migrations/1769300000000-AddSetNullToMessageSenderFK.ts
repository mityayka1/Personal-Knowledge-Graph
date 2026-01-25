import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSetNullToMessageSenderFK1769300000000 implements MigrationInterface {
  name = 'AddSetNullToMessageSenderFK1769300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop the existing FK constraint on messages.sender_entity_id
    await queryRunner.query(`
      ALTER TABLE "messages"
      DROP CONSTRAINT IF EXISTS "FK_41ffb1bd9c518c832d703156d8a"
    `);

    // Recreate with ON DELETE SET NULL
    // This allows deleting entities while preserving message records
    await queryRunner.query(`
      ALTER TABLE "messages"
      ADD CONSTRAINT "FK_41ffb1bd9c518c832d703156d8a"
      FOREIGN KEY ("sender_entity_id")
      REFERENCES "entities"("id")
      ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop the SET NULL FK constraint
    await queryRunner.query(`
      ALTER TABLE "messages"
      DROP CONSTRAINT IF EXISTS "FK_41ffb1bd9c518c832d703156d8a"
    `);

    // Recreate original FK (without ON DELETE action)
    await queryRunner.query(`
      ALTER TABLE "messages"
      ADD CONSTRAINT "FK_41ffb1bd9c518c832d703156d8a"
      FOREIGN KEY ("sender_entity_id")
      REFERENCES "entities"("id")
    `);
  }
}
