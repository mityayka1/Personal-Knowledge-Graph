import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Статус отчёта о качестве данных
 */
export enum DataQualityReportStatus {
  PENDING = 'PENDING',
  REVIEWED = 'REVIEWED',
  RESOLVED = 'RESOLVED',
}

/**
 * Тип проблемы качества данных
 */
export enum DataQualityIssueType {
  DUPLICATE = 'DUPLICATE',
  ORPHAN = 'ORPHAN',
  MISSING_CLIENT = 'MISSING_CLIENT',
  MISSING_MEMBERS = 'MISSING_MEMBERS',
  UNLINKED_COMMITMENT = 'UNLINKED_COMMITMENT',
  EMPTY_FIELDS = 'EMPTY_FIELDS',
}

/**
 * Серьёзность проблемы
 */
export enum DataQualityIssueSeverity {
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
}

/**
 * Метрики качества данных
 */
export interface DataQualityMetrics {
  totalActivities: number;
  duplicateGroups: number;
  orphanedTasks: number;
  missingClientEntity: number;
  activityMemberCoverage: number;
  commitmentLinkageRate: number;
  inferredRelationsCount: number;
  fieldFillRate: number;
}

/**
 * Обнаруженная проблема
 */
export interface DataQualityIssue {
  type: DataQualityIssueType;
  severity: DataQualityIssueSeverity;
  activityId: string;
  activityName: string;
  description: string;
  suggestedAction: string;
}

/**
 * Запись о разрешении проблемы
 */
export interface DataQualityResolution {
  issueIndex: number;
  resolvedAt: Date;
  resolvedBy: 'auto' | 'manual';
  action: string;
}

/**
 * DataQualityReport — отчёт о качестве данных.
 *
 * Содержит метрики, обнаруженные проблемы и их разрешения.
 * Создаётся при запуске аудита качества данных.
 */
@Entity('data_quality_reports')
@Index('idx_dqr_status', ['status'])
@Index('idx_dqr_report_date', ['reportDate'])
export class DataQualityReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    name: 'report_date',
    type: 'timestamp with time zone',
    comment: 'Дата создания отчёта',
  })
  reportDate: Date;

  @Column({
    type: 'jsonb',
    comment: 'Метрики качества данных',
  })
  metrics: DataQualityMetrics;

  @Column({
    type: 'jsonb',
    comment: 'Обнаруженные проблемы',
  })
  issues: DataQualityIssue[];

  @Column({
    type: 'jsonb',
    nullable: true,
    comment: 'Записи о разрешении проблем',
  })
  resolutions: DataQualityResolution[] | null;

  @Column({
    type: 'varchar',
    length: 20,
    default: DataQualityReportStatus.PENDING,
    comment: 'Статус отчёта: PENDING, REVIEWED, RESOLVED',
  })
  status: DataQualityReportStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
