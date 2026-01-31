import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Add soft delete support to Activity and Commitment entities.
 *
 * This migration adds the `deleted_at` column to both tables to support:
 * - Draft Entities pattern: entities can be created with status='draft'
 * - On reject: soft delete via deletedAt timestamp
 * - Audit trail: rejected entities remain in DB for analysis
 *
 * Note: DRAFT status is already added as a valid enum value in the entity
 * (the status column is varchar, not PostgreSQL enum, so no DB migration needed).
 */
export class AddSoftDeleteToActivityCommitment1770200000000
  implements MigrationInterface
{
  name = 'AddSoftDeleteToActivityCommitment1770200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add soft delete column to activities
    await queryRunner.query(`
      ALTER TABLE activities
      ADD COLUMN deleted_at TIMESTAMP WITH TIME ZONE
    `);

    // Create index on deleted_at for soft delete queries
    await queryRunner.query(`
      CREATE INDEX idx_activities_deleted_at ON activities(deleted_at)
      WHERE deleted_at IS NOT NULL
    `);

    // Create partial index for active activities (exclude soft-deleted)
    // This speeds up most common queries that filter out deleted records
    await queryRunner.query(`
      CREATE INDEX idx_activities_active ON activities(owner_entity_id, activity_type, status)
      WHERE deleted_at IS NULL
    `);

    // Add soft delete column to commitments
    await queryRunner.query(`
      ALTER TABLE commitments
      ADD COLUMN deleted_at TIMESTAMP WITH TIME ZONE
    `);

    // Create index on deleted_at for soft delete queries
    await queryRunner.query(`
      CREATE INDEX idx_commitments_deleted_at ON commitments(deleted_at)
      WHERE deleted_at IS NOT NULL
    `);

    // Create partial index for active commitments (exclude soft-deleted)
    await queryRunner.query(`
      CREATE INDEX idx_commitments_active ON commitments(from_entity_id, to_entity_id, status)
      WHERE deleted_at IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes for commitments
    await queryRunner.query(`DROP INDEX IF EXISTS idx_commitments_active`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_commitments_deleted_at`);

    // Drop column from commitments
    await queryRunner.query(`
      ALTER TABLE commitments DROP COLUMN deleted_at
    `);

    // Drop indexes for activities
    await queryRunner.query(`DROP INDEX IF EXISTS idx_activities_active`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_activities_deleted_at`);

    // Drop column from activities
    await queryRunner.query(`
      ALTER TABLE activities DROP COLUMN deleted_at
    `);
  }
}
