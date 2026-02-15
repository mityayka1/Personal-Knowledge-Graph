import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Create knowledge_packs table + source_segment_id traceability columns.
 *
 * KnowledgePack consolidates multiple TopicalSegments into compact
 * knowledge representations (decisions, facts, open questions).
 *
 * source_segment_id columns enable traceability from extracted data
 * back to the discussion segment that produced it.
 *
 * Phase E: Knowledge Segmentation & Packing
 */
export class CreateKnowledgePacks1770700000000 implements MigrationInterface {
  name = 'CreateKnowledgePacks1770700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Main table: knowledge_packs
    await queryRunner.query(`
      CREATE TABLE knowledge_packs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        -- Identification
        title VARCHAR(500) NOT NULL,
        pack_type VARCHAR(20) NOT NULL,

        -- Bindings
        activity_id UUID REFERENCES activities(id) ON DELETE SET NULL,
        entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
        topic VARCHAR(500),

        -- Time period
        period_start TIMESTAMPTZ NOT NULL,
        period_end TIMESTAMPTZ NOT NULL,

        -- Content
        summary TEXT NOT NULL,
        decisions JSONB DEFAULT '[]',
        open_questions JSONB DEFAULT '[]',
        key_facts JSONB DEFAULT '[]',
        participant_ids UUID[] DEFAULT '{}',

        -- Sources
        source_segment_ids UUID[] NOT NULL,
        segment_count INT DEFAULT 0,
        total_message_count INT DEFAULT 0,

        -- Conflicts & validation
        conflicts JSONB DEFAULT '[]',
        is_verified BOOLEAN DEFAULT false,
        verified_at TIMESTAMPTZ,

        -- Status
        status VARCHAR(20) DEFAULT 'draft',
        superseded_by_id UUID,

        -- Metadata
        metadata JSONB,

        -- Timestamps
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 2. Indexes for knowledge_packs
    await queryRunner.query(
      `CREATE INDEX idx_kp_title ON knowledge_packs(title)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_kp_pack_type ON knowledge_packs(pack_type)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_kp_activity_id ON knowledge_packs(activity_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_kp_entity_id ON knowledge_packs(entity_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_kp_period_start ON knowledge_packs(period_start)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_kp_period_end ON knowledge_packs(period_end)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_kp_status ON knowledge_packs(status)`,
    );

    // 3. Traceability: source_segment_id on entity_facts, activities, commitments
    await queryRunner.query(
      `ALTER TABLE entity_facts ADD COLUMN source_segment_id UUID`,
    );
    await queryRunner.query(
      `ALTER TABLE activities ADD COLUMN source_segment_id UUID`,
    );
    await queryRunner.query(
      `ALTER TABLE commitments ADD COLUMN source_segment_id UUID`,
    );

    // 4. FK reference from topical_segments to knowledge_packs
    await queryRunner.query(`
      ALTER TABLE topical_segments
      ADD CONSTRAINT fk_segments_knowledge_pack
      FOREIGN KEY (knowledge_pack_id) REFERENCES knowledge_packs(id)
      ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE topical_segments DROP CONSTRAINT IF EXISTS fk_segments_knowledge_pack`,
    );
    await queryRunner.query(
      `ALTER TABLE commitments DROP COLUMN IF EXISTS source_segment_id`,
    );
    await queryRunner.query(
      `ALTER TABLE activities DROP COLUMN IF EXISTS source_segment_id`,
    );
    await queryRunner.query(
      `ALTER TABLE entity_facts DROP COLUMN IF EXISTS source_segment_id`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS knowledge_packs`);
  }
}
