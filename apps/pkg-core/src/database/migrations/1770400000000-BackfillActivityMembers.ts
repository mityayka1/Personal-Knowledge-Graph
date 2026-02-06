import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backfill ActivityMember records from Activity.metadata.participants.
 *
 * 12 activities have participants stored in metadata JSON but no corresponding
 * ActivityMember records. This migration resolves participant names to entities
 * and creates member records with appropriate roles.
 *
 * Roles:
 * - "self" / owner entity name → OWNER
 * - client_entity_id match → CLIENT
 * - other matched entities → MEMBER
 * - unmatched names → skipped (logged)
 */
export class BackfillActivityMembers1770400000000 implements MigrationInterface {
  name = 'BackfillActivityMembers1770400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Get owner entity ID
    const ownerRows = await queryRunner.query(
      `SELECT id, name FROM entities WHERE is_owner = true LIMIT 1`,
    );
    const ownerEntityId: string | null = ownerRows[0]?.id ?? null;
    const ownerEntityName: string | null = ownerRows[0]?.name ?? null;

    if (!ownerEntityId) {
      console.log('[BackfillActivityMembers] No owner entity found, skipping migration');
      return;
    }

    // Get all activities with participants in metadata
    const activities = await queryRunner.query(`
      SELECT
        a.id as activity_id,
        a.owner_entity_id,
        a.client_entity_id,
        p.participant
      FROM activities a,
        jsonb_array_elements_text(a.metadata->'participants') as p(participant)
      WHERE a.metadata IS NOT NULL
        AND a.metadata ? 'participants'
    `);

    if (activities.length === 0) {
      console.log('[BackfillActivityMembers] No activities with participants found');
      return;
    }

    let created = 0;
    let skipped = 0;

    for (const row of activities) {
      const { activity_id, owner_entity_id, client_entity_id, participant } = row;

      // Determine entity_id and role
      let entityId: string | null = null;
      let role: string;

      if (participant === 'self' || participant === ownerEntityName) {
        // Owner participant
        entityId = ownerEntityId;
        role = 'owner';
      } else {
        // Try to find entity by exact name match (case-insensitive)
        const entityRows = await queryRunner.query(
          `SELECT id FROM entities WHERE LOWER(name) = LOWER($1) LIMIT 1`,
          [participant],
        );
        entityId = entityRows[0]?.id ?? null;

        if (!entityId) {
          console.log(`[BackfillActivityMembers] No entity found for "${participant}" in activity ${activity_id}, skipping`);
          skipped++;
          continue;
        }

        // Determine role: client or member
        role = entityId === client_entity_id ? 'client' : 'member';
      }

      // Check for existing record (dedup)
      const existing = await queryRunner.query(
        `SELECT id FROM activity_members WHERE activity_id = $1 AND entity_id = $2 LIMIT 1`,
        [activity_id, entityId],
      );

      if (existing.length > 0) {
        continue; // Already exists
      }

      // Insert ActivityMember
      await queryRunner.query(
        `INSERT INTO activity_members (id, activity_id, entity_id, role, is_active, metadata, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, true, '{"source": "backfill"}'::jsonb, NOW(), NOW())`,
        [activity_id, entityId, role],
      );
      created++;
    }

    console.log(`[BackfillActivityMembers] Created ${created} members, skipped ${skipped} unresolved`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove only backfill-created records
    await queryRunner.query(
      `DELETE FROM activity_members WHERE metadata @> '{"source": "backfill"}'::jsonb`,
    );
  }
}
