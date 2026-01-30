import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add soft delete support to entities table.
 *
 * This migration adds a deleted_at column that enables soft delete functionality.
 * When set, the entity is considered deleted but all data is preserved.
 * TypeORM's @DeleteDateColumn automatically:
 * - Excludes soft-deleted entities from normal queries
 * - Allows including them with { withDeleted: true }
 *
 * Benefits:
 * - Preserves data integrity for Activity/Commitment FK references
 * - Allows entity restoration
 * - Maintains audit trail
 */
export class AddSoftDeleteToEntities1769900000000 implements MigrationInterface {
  name = 'AddSoftDeleteToEntities1769900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add deleted_at column for soft delete
    await queryRunner.query(`
      ALTER TABLE "entities"
      ADD COLUMN "deleted_at" TIMESTAMPTZ DEFAULT NULL
    `);

    // Create index for efficient filtering
    await queryRunner.query(`
      CREATE INDEX "idx_entities_deleted_at"
      ON "entities" ("deleted_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop the index
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_entities_deleted_at"
    `);

    // Remove the column
    await queryRunner.query(`
      ALTER TABLE "entities"
      DROP COLUMN "deleted_at"
    `);
  }
}
