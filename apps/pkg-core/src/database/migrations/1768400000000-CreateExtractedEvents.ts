import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateExtractedEvents1768400000000 implements MigrationInterface {
  name = 'CreateExtractedEvents1768400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create enum types
    await queryRunner.query(`
      CREATE TYPE extracted_event_type AS ENUM (
        'meeting',
        'promise_by_me',
        'promise_by_them',
        'task',
        'fact',
        'cancellation'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE extracted_event_status AS ENUM (
        'pending',
        'confirmed',
        'rejected',
        'auto_processed',
        'expired'
      )
    `);

    // Create extracted_events table
    await queryRunner.query(`
      CREATE TABLE extracted_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        source_interaction_id UUID REFERENCES interactions(id) ON DELETE SET NULL,
        entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
        event_type extracted_event_type NOT NULL,
        extracted_data JSONB NOT NULL,
        source_quote TEXT,
        confidence NUMERIC(3, 2) NOT NULL,
        status extracted_event_status NOT NULL DEFAULT 'pending',
        result_entity_type VARCHAR(30),
        result_entity_id UUID,
        notification_sent_at TIMESTAMP WITH TIME ZONE,
        user_response_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes
    await queryRunner.query(`
      CREATE INDEX idx_extracted_events_source_message ON extracted_events(source_message_id)
    `);

    await queryRunner.query(`
      CREATE INDEX idx_extracted_events_entity ON extracted_events(entity_id) WHERE entity_id IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX idx_extracted_events_type ON extracted_events(event_type)
    `);

    await queryRunner.query(`
      CREATE INDEX idx_extracted_events_status ON extracted_events(status)
    `);

    await queryRunner.query(`
      CREATE INDEX idx_extracted_events_created ON extracted_events(created_at DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes
    await queryRunner.query(`DROP INDEX IF EXISTS idx_extracted_events_created`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_extracted_events_status`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_extracted_events_type`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_extracted_events_entity`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_extracted_events_source_message`);

    // Drop table
    await queryRunner.query(`DROP TABLE IF EXISTS extracted_events`);

    // Drop enum types
    await queryRunner.query(`DROP TYPE IF EXISTS extracted_event_status`);
    await queryRunner.query(`DROP TYPE IF EXISTS extracted_event_type`);
  }
}
