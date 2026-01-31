import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePendingApprovals1770000000000 implements MigrationInterface {
  name = 'CreatePendingApprovals1770000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create enum types
    await queryRunner.query(`
      CREATE TYPE pending_approval_item_type AS ENUM (
        'fact',
        'project',
        'task',
        'commitment'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE pending_approval_status AS ENUM (
        'pending',
        'approved',
        'rejected'
      )
    `);

    // Create pending_approvals table
    await queryRunner.query(`
      CREATE TABLE pending_approvals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        item_type pending_approval_item_type NOT NULL,
        target_id UUID NOT NULL,
        batch_id UUID NOT NULL,
        status pending_approval_status NOT NULL DEFAULT 'pending',
        confidence NUMERIC(3, 2) NOT NULL,
        source_quote TEXT,
        source_interaction_id UUID REFERENCES interactions(id) ON DELETE SET NULL,
        message_ref VARCHAR(100),
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reviewed_at TIMESTAMP WITH TIME ZONE
      )
    `);

    // Create indexes
    await queryRunner.query(`
      CREATE INDEX idx_pending_approvals_item_type ON pending_approvals(item_type)
    `);

    await queryRunner.query(`
      CREATE INDEX idx_pending_approvals_target_id ON pending_approvals(target_id)
    `);

    await queryRunner.query(`
      CREATE INDEX idx_pending_approvals_batch_id ON pending_approvals(batch_id)
    `);

    await queryRunner.query(`
      CREATE INDEX idx_pending_approvals_status ON pending_approvals(status)
    `);

    await queryRunner.query(`
      CREATE INDEX idx_pending_approvals_source_interaction ON pending_approvals(source_interaction_id)
      WHERE source_interaction_id IS NOT NULL
    `);

    // Composite indexes for common query patterns
    await queryRunner.query(`
      CREATE INDEX idx_pending_approvals_batch_status ON pending_approvals(batch_id, status)
    `);

    // For cleanup job: find rejected items older than retention period
    await queryRunner.query(`
      CREATE INDEX idx_pending_approvals_cleanup ON pending_approvals(status, reviewed_at)
      WHERE status = 'rejected'
    `);

    // For listing pending items by creation time
    await queryRunner.query(`
      CREATE INDEX idx_pending_approvals_pending_created ON pending_approvals(created_at DESC)
      WHERE status = 'pending'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes
    await queryRunner.query(`DROP INDEX IF EXISTS idx_pending_approvals_pending_created`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_pending_approvals_cleanup`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_pending_approvals_batch_status`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_pending_approvals_source_interaction`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_pending_approvals_status`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_pending_approvals_batch_id`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_pending_approvals_target_id`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_pending_approvals_item_type`);

    // Drop table
    await queryRunner.query(`DROP TABLE IF EXISTS pending_approvals`);

    // Drop enum types
    await queryRunner.query(`DROP TYPE IF EXISTS pending_approval_status`);
    await queryRunner.query(`DROP TYPE IF EXISTS pending_approval_item_type`);
  }
}
