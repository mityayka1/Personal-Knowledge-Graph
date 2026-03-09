import { MigrationInterface, QueryRunner } from 'typeorm';

export class FactTaxonomyCleanup1771200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ═══════════════════════════════════════════
    // ЭТАП 1: Delete non-fact data (financial, process, project metadata)
    // ═══════════════════════════════════════════
    await queryRunner.query(`
      DELETE FROM entity_facts
      WHERE fact_type IN (
        'transaction', 'financial_transaction', 'account_balance',
        'card_last_digits', 'payment', 'payment_methods', 'mortgage',
        'financial_arrangement', 'tax_status_update', 'account',
        'process_observation', 'project', 'project_status',
        'project_update', 'project_context', 'current_project',
        'project_responsibility', 'company_restrictions',
        'access', 'access_issue',
        'note', 'plan', 'daily_summary',
        'service_agreement', 'availability',
        'software_version', 'technical_issue',
        'acquaintance'
      )
    `);

    // ═══════════════════════════════════════════
    // ЭТАП 2: Remap alias types to canonical
    // ═══════════════════════════════════════════
    const remaps: [string, string][] = [
      ['occupation', 'position'],
      ['work_activity', 'specialization'],
      ['professional', 'specialization'],
      ['research_area', 'specialization'],
      ['career_aspiration', 'preference'],
      ['work_setup', 'preference'],
      ['opinion', 'preference'],
      ['personal', 'preference'],
      ['communication_style', 'communication'],
      ['experience', 'education'],
      ['tool', 'skill'],
      ['accessibility_issue', 'health'],
      ['health_condition', 'health'],
      ['health_visit', 'health'],
      ['tax_status', 'status'],
      ['work_status', 'status'],
      ['address', 'location'],
      ['tax_id', 'inn'],
    ];

    for (const [from, to] of remaps) {
      await queryRunner.query(
        `UPDATE entity_facts SET fact_type = $1 WHERE fact_type = $2`,
        [to, from],
      );
    }

    // ═══════════════════════════════════════════
    // ЭТАП 3: Delete contact-type facts (duplicates of EntityIdentifier)
    // ═══════════════════════════════════════════
    await queryRunner.query(`
      DELETE FROM entity_facts
      WHERE fact_type IN (
        'phone', 'phone_personal', 'email',
        'telegram', 'contact', 'contact_link', 'contact_telegram',
        'github_account', 'website'
      )
    `);

    // ═══════════════════════════════════════════
    // ЭТАП 4: Update categories to match new taxonomy
    // ═══════════════════════════════════════════
    const categoryUpdates: [string[], string][] = [
      [['position', 'company', 'department', 'specialization', 'skill', 'education', 'role'], 'professional'],
      [['birthday', 'location', 'family', 'hobby', 'language', 'health', 'status'], 'personal'],
      [['communication', 'preference'], 'preferences'],
      [['inn', 'legal_address'], 'business'],
    ];

    for (const [types, category] of categoryUpdates) {
      const placeholders = types.map((_, i) => `$${i + 2}`).join(', ');
      await queryRunner.query(
        `UPDATE entity_facts SET category = $1 WHERE fact_type IN (${placeholders})`,
        [category, ...types],
      );
    }

    // Note: 'activity' type facts (~504 rows) are left for LLM batch reclassification (Task 6)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Irreversible migration — data deleted
    // down() intentionally left empty
  }
}
