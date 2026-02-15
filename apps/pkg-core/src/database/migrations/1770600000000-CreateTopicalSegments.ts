import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Create topical_segments table + segment_messages join table.
 *
 * TopicalSegment is a semantic discussion unit — a group of messages
 * sharing a common topic within a chat session. Bridges the gap between
 * raw messages and consolidated knowledge (KnowledgePack).
 *
 * Phase E: Knowledge Segmentation & Packing
 */
export class CreateTopicalSegments1770600000000 implements MigrationInterface {
  name = 'CreateTopicalSegments1770600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Main table: topical_segments
    await queryRunner.query(`
      CREATE TABLE topical_segments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        topic VARCHAR(500) NOT NULL,
        keywords TEXT[],
        summary TEXT,
        chat_id VARCHAR(100) NOT NULL,
        interaction_id UUID REFERENCES interactions(id) ON DELETE SET NULL,
        activity_id UUID REFERENCES activities(id) ON DELETE SET NULL,
        participant_ids UUID[] NOT NULL,
        primary_participant_id UUID REFERENCES entities(id),
        message_count INT DEFAULT 0,
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ NOT NULL,
        extracted_fact_ids UUID[] DEFAULT '{}',
        extracted_task_ids UUID[] DEFAULT '{}',
        extracted_commitment_ids UUID[] DEFAULT '{}',
        status VARCHAR(20) DEFAULT 'active',
        knowledge_pack_id UUID,
        merged_into_id UUID,
        confidence DECIMAL(3,2) DEFAULT 0.80,
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 2. Indexes for topical_segments
    await queryRunner.query(
      `CREATE INDEX idx_segments_topic ON topical_segments(topic)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_segments_chat_id ON topical_segments(chat_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_segments_interaction_id ON topical_segments(interaction_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_segments_activity_id ON topical_segments(activity_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_segments_status ON topical_segments(status)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_segments_started_at ON topical_segments(started_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_segments_ended_at ON topical_segments(ended_at)`,
    );

    // 3. Join table: segment_messages (many-to-many)
    await queryRunner.query(`
      CREATE TABLE segment_messages (
        segment_id UUID NOT NULL REFERENCES topical_segments(id) ON DELETE CASCADE,
        message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        PRIMARY KEY (segment_id, message_id)
      )
    `);

    // Index for reverse lookup (messages → segments)
    await queryRunner.query(
      `CREATE INDEX idx_segment_messages_message_id ON segment_messages(message_id)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS segment_messages`);
    await queryRunner.query(`DROP TABLE IF EXISTS topical_segments`);
  }
}
