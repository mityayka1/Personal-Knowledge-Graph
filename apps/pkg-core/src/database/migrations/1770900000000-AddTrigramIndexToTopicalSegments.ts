import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add GIN trigram index on topical_segments.topic and topical_segments.summary
 * to optimize ILIKE '%query%' searches used in search_discussions tool.
 *
 * Without this index, ILIKE with leading wildcard causes a sequential scan.
 * pg_trgm extension + GIN index enables index-backed trigram matching.
 */
export class AddTrigramIndexToTopicalSegments1770900000000
  implements MigrationInterface
{
  name = 'AddTrigramIndexToTopicalSegments1770900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enable pg_trgm extension (idempotent)
    await queryRunner.query(
      `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
    );

    // GIN trigram index on topic column
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_topical_segments_topic_trgm"
       ON "topical_segments" USING GIN ("topic" gin_trgm_ops)`,
    );

    // GIN trigram index on summary column
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_topical_segments_summary_trgm"
       ON "topical_segments" USING GIN ("summary" gin_trgm_ops)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_topical_segments_summary_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_topical_segments_topic_trgm"`,
    );
    // Note: не удаляем pg_trgm extension — может использоваться другими таблицами
  }
}
