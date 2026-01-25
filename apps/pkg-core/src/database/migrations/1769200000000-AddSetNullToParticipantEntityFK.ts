import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSetNullToParticipantEntityFK1769200000000 implements MigrationInterface {
  name = 'AddSetNullToParticipantEntityFK1769200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop the existing FK constraint
    await queryRunner.query(`
      ALTER TABLE "interaction_participants"
      DROP CONSTRAINT IF EXISTS "FK_f0484dbe65dbcd0b711067772a4"
    `);

    // Recreate with ON DELETE SET NULL
    // This allows deleting entities while preserving participant records
    await queryRunner.query(`
      ALTER TABLE "interaction_participants"
      ADD CONSTRAINT "FK_f0484dbe65dbcd0b711067772a4"
      FOREIGN KEY ("entity_id")
      REFERENCES "entities"("id")
      ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop the SET NULL FK constraint
    await queryRunner.query(`
      ALTER TABLE "interaction_participants"
      DROP CONSTRAINT IF EXISTS "FK_f0484dbe65dbcd0b711067772a4"
    `);

    // Recreate original FK (without ON DELETE action)
    await queryRunner.query(`
      ALTER TABLE "interaction_participants"
      ADD CONSTRAINT "FK_f0484dbe65dbcd0b711067772a4"
      FOREIGN KEY ("entity_id")
      REFERENCES "entities"("id")
    `);
  }
}
