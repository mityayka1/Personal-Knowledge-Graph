import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Optimize cleanup_empty_relations trigger to only check affected relation_id.
 * Previous implementation used FOR EACH STATEMENT which scanned all relations.
 * New implementation uses FOR EACH ROW and checks only the specific relation_id.
 */
export class OptimizeRelationsCleanupTrigger1769100000000
  implements MigrationInterface
{
  name = 'OptimizeRelationsCleanupTrigger1769100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop old trigger
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_cleanup_relations ON entity_relation_members
    `);

    // Drop old function
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS cleanup_empty_relations()
    `);

    // Create optimized function that checks only affected relation_id
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION cleanup_empty_relations()
      RETURNS TRIGGER AS $$
      DECLARE
        affected_relation_id UUID;
      BEGIN
        -- Get the relation_id from the affected row
        IF TG_OP = 'DELETE' THEN
          affected_relation_id := OLD.relation_id;
        ELSE
          affected_relation_id := COALESCE(OLD.relation_id, NEW.relation_id);
        END IF;

        -- Only check the specific relation, not all relations
        DELETE FROM entity_relations
        WHERE id = affected_relation_id
          AND NOT EXISTS (
            SELECT 1 FROM entity_relation_members m
            WHERE m.relation_id = affected_relation_id
              AND m.valid_until IS NULL
          );

        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);

    // Create optimized trigger (FOR EACH ROW instead of FOR EACH STATEMENT)
    await queryRunner.query(`
      CREATE TRIGGER trg_cleanup_relations
      AFTER UPDATE OR DELETE ON entity_relation_members
      FOR EACH ROW EXECUTE FUNCTION cleanup_empty_relations()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop optimized trigger
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_cleanup_relations ON entity_relation_members
    `);

    // Drop optimized function
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS cleanup_empty_relations()
    `);

    // Restore original function (FOR EACH STATEMENT - scans all)
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION cleanup_empty_relations()
      RETURNS TRIGGER AS $$
      BEGIN
        DELETE FROM entity_relations r
        WHERE NOT EXISTS (
          SELECT 1 FROM entity_relation_members m
          WHERE m.relation_id = r.id AND m.valid_until IS NULL
        );
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);

    // Restore original trigger
    await queryRunner.query(`
      CREATE TRIGGER trg_cleanup_relations
      AFTER UPDATE OR DELETE ON entity_relation_members
      FOR EACH STATEMENT EXECUTE FUNCTION cleanup_empty_relations()
    `);
  }
}
