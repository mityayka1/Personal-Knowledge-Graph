import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSourceEntityIdAndContextToPendingApprovals1771000000000
  implements MigrationInterface
{
  name = 'AddSourceEntityIdAndContextToPendingApprovals1771000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "pending_approvals"
        ADD COLUMN "source_entity_id" uuid,
        ADD COLUMN "context" text
    `);

    await queryRunner.query(`
      ALTER TABLE "pending_approvals"
        ADD CONSTRAINT "FK_pending_approvals_source_entity"
        FOREIGN KEY ("source_entity_id") REFERENCES "entities"("id")
        ON DELETE SET NULL
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_pending_approvals_source_entity_id"
        ON "pending_approvals" ("source_entity_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_pending_approvals_source_entity_id"
    `);

    await queryRunner.query(`
      ALTER TABLE "pending_approvals"
        DROP CONSTRAINT IF EXISTS "FK_pending_approvals_source_entity"
    `);

    await queryRunner.query(`
      ALTER TABLE "pending_approvals"
        DROP COLUMN IF EXISTS "context",
        DROP COLUMN IF EXISTS "source_entity_id"
    `);
  }
}
