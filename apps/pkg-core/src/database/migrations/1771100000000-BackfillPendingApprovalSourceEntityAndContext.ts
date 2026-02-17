import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backfill source_entity_id and context for existing pending_approvals.
 *
 * Reads target entities via polymorphic itemType + targetId:
 * - FACT: entity_facts → entityId, "{factType}: {value}"
 * - PROJECT/TASK: activities → ownerEntityId, "Проект: {name}" / "Задача: {name}"
 * - COMMITMENT: commitments → from_entity_id, "Обещание: {title}"
 */
export class BackfillPendingApprovalSourceEntityAndContext1771100000000
  implements MigrationInterface
{
  name = 'BackfillPendingApprovalSourceEntityAndContext1771100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Backfill FACTs: source_entity_id = entity_facts.entity_id, context = factType: value
    await queryRunner.query(`
      UPDATE pending_approvals pa
      SET
        source_entity_id = ef.entity_id,
        context = ef.fact_type || ': ' || ef.value
      FROM entity_facts ef
      WHERE pa.item_type = 'fact'
        AND pa.target_id = ef.id
        AND pa.source_entity_id IS NULL
    `);

    // Backfill PROJECTs: source_entity_id = activities.owner_entity_id, context = "Проект: {name}"
    await queryRunner.query(`
      UPDATE pending_approvals pa
      SET
        source_entity_id = a.owner_entity_id,
        context = 'Проект: ' || a.name
      FROM activities a
      WHERE pa.item_type = 'project'
        AND pa.target_id = a.id
        AND pa.source_entity_id IS NULL
    `);

    // Backfill TASKs: source_entity_id = activities.owner_entity_id, context = "Задача: {name}"
    await queryRunner.query(`
      UPDATE pending_approvals pa
      SET
        source_entity_id = a.owner_entity_id,
        context = 'Задача: ' || a.name
      FROM activities a
      WHERE pa.item_type = 'task'
        AND pa.target_id = a.id
        AND pa.source_entity_id IS NULL
    `);

    // Backfill COMMITMENTs: source_entity_id = commitments.from_entity_id, context = "Обещание: {title}"
    await queryRunner.query(`
      UPDATE pending_approvals pa
      SET
        source_entity_id = c.from_entity_id,
        context = 'Обещание: ' || c.title
      FROM commitments c
      WHERE pa.item_type = 'commitment'
        AND pa.target_id = c.id
        AND pa.source_entity_id IS NULL
    `);
  }

  public async down(): Promise<void> {
    // No-op: backfill data is not destructive, keeping it is fine on rollback
  }
}
