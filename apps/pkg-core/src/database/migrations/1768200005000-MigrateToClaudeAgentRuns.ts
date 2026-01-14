import { MigrationInterface, QueryRunner } from 'typeorm';

export class MigrateToClaudeAgentRuns1768200005000 implements MigrationInterface {
  name = 'MigrateToClaudeAgentRuns1768200005000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Rename table from claude_cli_runs to claude_agent_runs
    await queryRunner.query(`
      ALTER TABLE IF EXISTS claude_cli_runs RENAME TO claude_agent_runs
    `);

    // Add new columns for agent mode support
    await queryRunner.query(`
      ALTER TABLE claude_agent_runs
      ADD COLUMN IF NOT EXISTS mode VARCHAR(20) DEFAULT 'oneshot',
      ADD COLUMN IF NOT EXISTS turns_count INT DEFAULT 1,
      ADD COLUMN IF NOT EXISTS tools_used JSONB
    `);

    // Drop old agent_name column (no longer needed)
    await queryRunner.query(`
      ALTER TABLE claude_agent_runs
      DROP COLUMN IF EXISTS agent_name
    `);

    // Add index on task_type for better query performance
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_claude_agent_runs_task_type
      ON claude_agent_runs(task_type)
    `);

    // Update existing records to have mode = 'oneshot' and turns_count = 1
    await queryRunner.query(`
      UPDATE claude_agent_runs
      SET mode = 'oneshot', turns_count = 1
      WHERE mode IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop the new index
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_claude_agent_runs_task_type
    `);

    // Add back the agent_name column
    await queryRunner.query(`
      ALTER TABLE claude_agent_runs
      ADD COLUMN IF NOT EXISTS agent_name VARCHAR(50)
    `);

    // Remove new columns
    await queryRunner.query(`
      ALTER TABLE claude_agent_runs
      DROP COLUMN IF EXISTS mode,
      DROP COLUMN IF EXISTS turns_count,
      DROP COLUMN IF EXISTS tools_used
    `);

    // Rename table back
    await queryRunner.query(`
      ALTER TABLE claude_agent_runs RENAME TO claude_cli_runs
    `);
  }
}
