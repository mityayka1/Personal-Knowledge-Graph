import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add embedding columns to activities and commitments tables.
 *
 * These vector(1536) columns store OpenAI text-embedding-3-small embeddings
 * for semantic deduplication during extraction pipeline.
 *
 * Used by DraftExtractionService to find semantically similar tasks/commitments
 * via cosine distance (<=> operator) before creating new drafts.
 */
export class AddEmbeddingToActivitiesAndCommitments1770500000000 implements MigrationInterface {
  name = 'AddEmbeddingToActivitiesAndCommitments1770500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE activities ADD COLUMN IF NOT EXISTS embedding vector(1536)`,
    );
    await queryRunner.query(
      `ALTER TABLE commitments ADD COLUMN IF NOT EXISTS embedding vector(1536)`,
    );

    // IVFFlat indexes for cosine similarity search
    // lists=100 is appropriate for <100K rows (adjust as data grows)
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_activities_embedding ON activities USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_commitments_embedding ON commitments USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_commitments_embedding`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_activities_embedding`);
    await queryRunner.query(
      `ALTER TABLE activities DROP COLUMN IF EXISTS embedding`,
    );
    await queryRunner.query(
      `ALTER TABLE commitments DROP COLUMN IF EXISTS embedding`,
    );
  }
}
