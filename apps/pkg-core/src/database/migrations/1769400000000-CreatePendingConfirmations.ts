import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePendingConfirmations1769400000000 implements MigrationInterface {
  name = 'CreatePendingConfirmations1769400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create enum types
    await queryRunner.query(`
      CREATE TYPE pending_confirmation_type AS ENUM (
        'identifier_attribution',
        'entity_merge',
        'fact_subject',
        'fact_value'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE pending_confirmation_status AS ENUM (
        'pending',
        'confirmed',
        'declined',
        'expired'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE pending_confirmation_resolved_by AS ENUM (
        'user',
        'auto',
        'expired'
      )
    `);

    // Create pending_confirmations table
    await queryRunner.query(`
      CREATE TABLE pending_confirmations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        type pending_confirmation_type NOT NULL,
        context JSONB NOT NULL,
        options JSONB NOT NULL,
        confidence NUMERIC(3, 2),
        status pending_confirmation_status NOT NULL DEFAULT 'pending',
        source_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
        source_entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
        source_pending_fact_id UUID REFERENCES pending_facts(id) ON DELETE SET NULL,
        selected_option_id VARCHAR(100),
        resolution JSONB,
        resolved_by pending_confirmation_resolved_by,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP WITH TIME ZONE,
        resolved_at TIMESTAMP WITH TIME ZONE
      )
    `);

    // Create indexes
    await queryRunner.query(`
      CREATE INDEX idx_pending_confirmations_type ON pending_confirmations(type)
    `);

    await queryRunner.query(`
      CREATE INDEX idx_pending_confirmations_status ON pending_confirmations(status)
    `);

    await queryRunner.query(`
      CREATE INDEX idx_pending_confirmations_source_entity ON pending_confirmations(source_entity_id)
      WHERE source_entity_id IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX idx_pending_confirmations_created ON pending_confirmations(created_at DESC)
    `);

    // Composite index for common query pattern: pending by type
    await queryRunner.query(`
      CREATE INDEX idx_pending_confirmations_pending_type ON pending_confirmations(type, created_at DESC)
      WHERE status = 'pending'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes
    await queryRunner.query(`DROP INDEX IF EXISTS idx_pending_confirmations_pending_type`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_pending_confirmations_created`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_pending_confirmations_source_entity`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_pending_confirmations_status`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_pending_confirmations_type`);

    // Drop table
    await queryRunner.query(`DROP TABLE IF EXISTS pending_confirmations`);

    // Drop enum types
    await queryRunner.query(`DROP TYPE IF EXISTS pending_confirmation_resolved_by`);
    await queryRunner.query(`DROP TYPE IF EXISTS pending_confirmation_status`);
    await queryRunner.query(`DROP TYPE IF EXISTS pending_confirmation_type`);
  }
}
