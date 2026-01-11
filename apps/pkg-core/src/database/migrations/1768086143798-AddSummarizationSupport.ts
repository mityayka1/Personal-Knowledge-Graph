import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSummarizationSupport1768086143798 implements MigrationInterface {
  name = 'AddSummarizationSupport1768086143798';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Update interaction_summaries table
    await queryRunner.query(`
      ALTER TABLE interaction_summaries
      ADD COLUMN IF NOT EXISTS tone VARCHAR(20),
      ADD COLUMN IF NOT EXISTS important_messages JSONB DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS message_count INTEGER,
      ADD COLUMN IF NOT EXISTS source_token_count INTEGER,
      ADD COLUMN IF NOT EXISTS summary_token_count INTEGER,
      ADD COLUMN IF NOT EXISTS compression_ratio DECIMAL(5,2),
      ADD COLUMN IF NOT EXISTS model_version VARCHAR(50),
      ADD COLUMN IF NOT EXISTS generation_cost_usd DECIMAL(10,6),
      ADD COLUMN IF NOT EXISTS revision_count INTEGER DEFAULT 1,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    `);

    // Set default values for existing rows
    await queryRunner.query(`
      UPDATE interaction_summaries
      SET
        important_messages = '[]'::jsonb,
        revision_count = 1,
        updated_at = created_at
      WHERE important_messages IS NULL
    `);

    // 2. Create entity_relationship_profiles table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS entity_relationship_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        entity_id UUID NOT NULL UNIQUE REFERENCES entities(id) ON DELETE CASCADE,
        relationship_type VARCHAR(30) NOT NULL,
        communication_frequency VARCHAR(20) NOT NULL,
        relationship_summary TEXT NOT NULL,
        relationship_timeline TEXT,
        first_interaction_date TIMESTAMP WITH TIME ZONE NOT NULL,
        last_meaningful_contact TIMESTAMP WITH TIME ZONE NOT NULL,
        total_interactions INTEGER NOT NULL,
        total_messages INTEGER NOT NULL,
        top_topics JSONB DEFAULT '[]',
        milestones JSONB DEFAULT '[]',
        key_decisions JSONB DEFAULT '[]',
        open_action_items JSONB DEFAULT '[]',
        summarized_interactions_count INTEGER NOT NULL,
        coverage_start TIMESTAMP WITH TIME ZONE NOT NULL,
        coverage_end TIMESTAMP WITH TIME ZONE NOT NULL,
        model_version VARCHAR(50),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_entity_relationship_profiles_entity
      ON entity_relationship_profiles(entity_id)
    `);

    // 3. Add columns to messages
    await queryRunner.query(`
      ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS importance_score DECIMAL(3,2),
      ADD COLUMN IF NOT EXISTS importance_reason VARCHAR(50),
      ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP WITH TIME ZONE
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_importance
      ON messages(importance_score) WHERE importance_score > 0.7
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_archived
      ON messages(is_archived) WHERE is_archived = true
    `);

    // 4. Create claude_cli_runs table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS claude_cli_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task_type VARCHAR(50) NOT NULL,
        model VARCHAR(50) NOT NULL,
        agent_name VARCHAR(50),
        tokens_in INTEGER,
        tokens_out INTEGER,
        cost_usd DECIMAL(10,6),
        duration_ms INTEGER NOT NULL,
        success BOOLEAN NOT NULL,
        error_message TEXT,
        reference_type VARCHAR(50),
        reference_id UUID,
        input_preview TEXT,
        output_preview TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        created_date DATE NOT NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_claude_cli_runs_date_type
      ON claude_cli_runs(created_date, task_type)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_claude_cli_runs_reference
      ON claude_cli_runs(reference_type, reference_id)
      WHERE reference_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes for claude_cli_runs
    await queryRunner.query(`DROP INDEX IF EXISTS idx_claude_cli_runs_reference`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_claude_cli_runs_date_type`);

    // Drop claude_cli_runs table
    await queryRunner.query(`DROP TABLE IF EXISTS claude_cli_runs`);

    // Drop indexes for messages
    await queryRunner.query(`DROP INDEX IF EXISTS idx_messages_archived`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_messages_importance`);

    // Remove columns from messages
    await queryRunner.query(`
      ALTER TABLE messages
      DROP COLUMN IF EXISTS importance_score,
      DROP COLUMN IF EXISTS importance_reason,
      DROP COLUMN IF EXISTS is_archived,
      DROP COLUMN IF EXISTS archived_at
    `);

    // Drop entity_relationship_profiles index and table
    await queryRunner.query(`DROP INDEX IF EXISTS idx_entity_relationship_profiles_entity`);
    await queryRunner.query(`DROP TABLE IF EXISTS entity_relationship_profiles`);

    // Remove columns from interaction_summaries
    await queryRunner.query(`
      ALTER TABLE interaction_summaries
      DROP COLUMN IF EXISTS tone,
      DROP COLUMN IF EXISTS important_messages,
      DROP COLUMN IF EXISTS message_count,
      DROP COLUMN IF EXISTS source_token_count,
      DROP COLUMN IF EXISTS summary_token_count,
      DROP COLUMN IF EXISTS compression_ratio,
      DROP COLUMN IF EXISTS model_version,
      DROP COLUMN IF EXISTS generation_cost_usd,
      DROP COLUMN IF EXISTS revision_count,
      DROP COLUMN IF EXISTS updated_at
    `);
  }
}
