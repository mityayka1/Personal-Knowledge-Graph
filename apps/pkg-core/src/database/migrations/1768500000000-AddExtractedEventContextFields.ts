import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddExtractedEventContextFields1768500000000 implements MigrationInterface {
  name = 'AddExtractedEventContextFields1768500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add linked_event_id column - for linking related events (e.g., "prepare report" -> "start working on report")
    await queryRunner.query(`
      ALTER TABLE extracted_events
      ADD COLUMN linked_event_id UUID REFERENCES extracted_events(id) ON DELETE SET NULL
    `);

    // Add needs_context column - flag for abstract events that couldn't be enriched
    await queryRunner.query(`
      ALTER TABLE extracted_events
      ADD COLUMN needs_context BOOLEAN NOT NULL DEFAULT false
    `);

    // Add enrichment_data column - stores context enrichment results
    await queryRunner.query(`
      ALTER TABLE extracted_events
      ADD COLUMN enrichment_data JSONB
    `);

    // Create index for linked_event_id to optimize queries for related events
    await queryRunner.query(`
      CREATE INDEX idx_extracted_events_linked ON extracted_events(linked_event_id)
      WHERE linked_event_id IS NOT NULL
    `);

    // Create index for needs_context to quickly find events needing attention
    await queryRunner.query(`
      CREATE INDEX idx_extracted_events_needs_context ON extracted_events(needs_context)
      WHERE needs_context = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes
    await queryRunner.query(`DROP INDEX IF EXISTS idx_extracted_events_needs_context`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_extracted_events_linked`);

    // Drop columns
    await queryRunner.query(`ALTER TABLE extracted_events DROP COLUMN IF EXISTS enrichment_data`);
    await queryRunner.query(`ALTER TABLE extracted_events DROP COLUMN IF EXISTS needs_context`);
    await queryRunner.query(`ALTER TABLE extracted_events DROP COLUMN IF EXISTS linked_event_id`);
  }
}
