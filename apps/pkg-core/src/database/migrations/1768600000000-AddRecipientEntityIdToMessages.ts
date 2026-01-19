import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRecipientEntityIdToMessages1768600000000 implements MigrationInterface {
  name = 'AddRecipientEntityIdToMessages1768600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add recipient_entity_id column
    await queryRunner.query(`
      ALTER TABLE messages
      ADD COLUMN recipient_entity_id UUID NULL
    `);

    // Add foreign key constraint
    await queryRunner.query(`
      ALTER TABLE messages
      ADD CONSTRAINT fk_messages_recipient_entity
      FOREIGN KEY (recipient_entity_id)
      REFERENCES entities(id)
      ON DELETE SET NULL
    `);

    // Add index for efficient lookups
    await queryRunner.query(`
      CREATE INDEX idx_messages_recipient_entity_id
      ON messages(recipient_entity_id)
      WHERE recipient_entity_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop index
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_messages_recipient_entity_id
    `);

    // Drop foreign key constraint
    await queryRunner.query(`
      ALTER TABLE messages
      DROP CONSTRAINT IF EXISTS fk_messages_recipient_entity
    `);

    // Drop column
    await queryRunner.query(`
      ALTER TABLE messages
      DROP COLUMN IF EXISTS recipient_entity_id
    `);
  }
}
