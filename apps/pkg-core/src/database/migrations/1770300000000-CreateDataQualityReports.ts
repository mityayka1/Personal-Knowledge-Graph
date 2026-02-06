import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Create data_quality_reports table.
 *
 * Stores data quality audit reports with metrics, detected issues,
 * and resolution records. Used by DataQualityService for tracking
 * data quality over time.
 */
export class CreateDataQualityReports1770300000000
  implements MigrationInterface
{
  name = 'CreateDataQualityReports1770300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE data_quality_reports (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        report_date TIMESTAMP WITH TIME ZONE NOT NULL,
        metrics JSONB NOT NULL,
        issues JSONB NOT NULL,
        resolutions JSONB,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_dqr_status ON data_quality_reports(status)
    `);

    await queryRunner.query(`
      CREATE INDEX idx_dqr_report_date ON data_quality_reports(report_date)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_dqr_report_date`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_dqr_status`);
    await queryRunner.query(`DROP TABLE IF EXISTS data_quality_reports`);
  }
}
