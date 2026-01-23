import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add embedding column to entity_facts for semantic deduplication.
 * Uses pgvector extension (1536 dimensions for text-embedding-3-small).
 */
export class AddFactEmbedding1768800000000 implements MigrationInterface {
  name = 'AddFactEmbedding1768800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add embedding column
    await queryRunner.query(`
      ALTER TABLE entity_facts
      ADD COLUMN embedding vector(1536)
    `);

    // Create IVFFlat index for fast similarity search
    // lists = 100 is good for up to 100k rows
    await queryRunner.query(`
      CREATE INDEX idx_entity_facts_embedding
      ON entity_facts
      USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_entity_facts_embedding`);
    await queryRunner.query(`ALTER TABLE entity_facts DROP COLUMN embedding`);
  }
}
