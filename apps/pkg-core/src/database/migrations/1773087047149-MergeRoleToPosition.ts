import { MigrationInterface, QueryRunner } from 'typeorm';

export class MergeRoleToPosition1773087047149 implements MigrationInterface {
  name = 'MergeRoleToPosition1773087047149';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Count existing role facts
    const result = await queryRunner.query(
      `SELECT COUNT(*) as count FROM entity_facts WHERE fact_type = 'role'`,
    );
    const count = Number(result[0]?.count ?? 0);

    if (count > 0) {
      // Merge role → position, preserving data (skip if position already exists with same value)
      await queryRunner.query(`
        UPDATE entity_facts
        SET fact_type = 'position'
        WHERE fact_type = 'role'
          AND NOT EXISTS (
            SELECT 1 FROM entity_facts ef2
            WHERE ef2.entity_id = entity_facts.entity_id
              AND ef2.fact_type = 'position'
              AND ef2.value = entity_facts.value
          )
      `);

      // Delete remaining role duplicates (where position already exists with same value)
      await queryRunner.query(
        `DELETE FROM entity_facts WHERE fact_type = 'role'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Cannot reverse — we don't know which position facts were originally role
  }
}
