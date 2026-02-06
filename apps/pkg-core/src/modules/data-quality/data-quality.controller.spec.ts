import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { DataQualityController } from './data-quality.controller';
import { DataQualityService } from './data-quality.service';
import {
  DataQualityReport,
  DataQualityReportStatus,
  DataQualityIssueType,
  DataQualityIssueSeverity,
  DataQualityMetrics,
} from '@pkg/entities';

describe('DataQualityController', () => {
  let controller: DataQualityController;

  // ---------------------------------------------------------------------------
  // Mock setup
  // ---------------------------------------------------------------------------

  const mockService = {
    runFullAudit: jest.fn(),
    getReports: jest.fn(),
    getLatestReport: jest.fn(),
    getReportById: jest.fn(),
    resolveIssue: jest.fn(),
    getCurrentMetrics: jest.fn(),
    mergeActivities: jest.fn(),
  };

  // ---------------------------------------------------------------------------
  // Test data constants
  // ---------------------------------------------------------------------------

  const REPORT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const KEEP_ID = '11111111-1111-1111-1111-111111111111';
  const MERGE_ID_1 = '22222222-2222-2222-2222-222222222222';
  const MERGE_ID_2 = '33333333-3333-3333-3333-333333333333';

  // ---------------------------------------------------------------------------
  // Factories
  // ---------------------------------------------------------------------------

  function makeReport(overrides: Partial<DataQualityReport> = {}): DataQualityReport {
    return {
      id: REPORT_ID,
      reportDate: new Date('2025-02-01'),
      metrics: {
        totalActivities: 10,
        duplicateGroups: 1,
        orphanedTasks: 2,
        missingClientEntity: 3,
        activityMemberCoverage: 0.5,
        commitmentLinkageRate: 0.8,
        inferredRelationsCount: 4,
        fieldFillRate: 0.6,
      },
      issues: [
        {
          type: DataQualityIssueType.DUPLICATE,
          severity: DataQualityIssueSeverity.HIGH,
          activityId: 'act-1',
          activityName: 'Dup',
          description: 'Duplicate project',
          suggestedAction: 'Merge',
        },
      ],
      resolutions: null,
      status: DataQualityReportStatus.PENDING,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as DataQualityReport;
  }

  function makeMetrics(overrides: Partial<DataQualityMetrics> = {}): DataQualityMetrics {
    return {
      totalActivities: 50,
      duplicateGroups: 2,
      orphanedTasks: 5,
      missingClientEntity: 3,
      activityMemberCoverage: 0.7,
      commitmentLinkageRate: 0.9,
      inferredRelationsCount: 10,
      fieldFillRate: 0.65,
      ...overrides,
    };
  }

  // ---------------------------------------------------------------------------
  // Module setup
  // ---------------------------------------------------------------------------

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DataQualityController],
      providers: [
        { provide: DataQualityService, useValue: mockService },
      ],
    }).compile();

    controller = module.get<DataQualityController>(DataQualityController);
    jest.clearAllMocks();
  });

  // =========================================================================
  // POST /audit - runAudit
  // =========================================================================

  describe('POST /audit - runAudit', () => {
    it('should call service.runFullAudit and return report', async () => {
      const report = makeReport();
      mockService.runFullAudit.mockResolvedValue(report);

      const result = await controller.runAudit();

      expect(result).toEqual(report);
      expect(mockService.runFullAudit).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // GET /reports - getReports
  // =========================================================================

  describe('GET /reports - getReports', () => {
    it('should return paginated reports with default params', async () => {
      const response = { data: [makeReport()], total: 1 };
      mockService.getReports.mockResolvedValue(response);

      const result = await controller.getReports(undefined, undefined);

      expect(result).toEqual(response);
      expect(mockService.getReports).toHaveBeenCalledWith(20, 0);
    });

    it('should pass custom limit and offset', async () => {
      const response = { data: [], total: 0 };
      mockService.getReports.mockResolvedValue(response);

      const result = await controller.getReports(5, 10);

      expect(result).toEqual(response);
      expect(mockService.getReports).toHaveBeenCalledWith(5, 10);
    });
  });

  // =========================================================================
  // GET /reports/latest - getLatestReport
  // =========================================================================

  describe('GET /reports/latest - getLatestReport', () => {
    it('should return latest report', async () => {
      const report = makeReport();
      mockService.getLatestReport.mockResolvedValue(report);

      const result = await controller.getLatestReport();

      expect(result).toEqual(report);
      expect(mockService.getLatestReport).toHaveBeenCalledTimes(1);
    });

    it('should throw NotFoundException when no reports', async () => {
      mockService.getLatestReport.mockResolvedValue(null);

      await expect(controller.getLatestReport()).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // =========================================================================
  // GET /reports/:id - getReportById
  // =========================================================================

  describe('GET /reports/:id - getReportById', () => {
    it('should return report by valid UUID', async () => {
      const report = makeReport();
      mockService.getReportById.mockResolvedValue(report);

      const result = await controller.getReportById(REPORT_ID);

      expect(result).toEqual(report);
      expect(mockService.getReportById).toHaveBeenCalledWith(REPORT_ID);
    });

    it('should propagate NotFoundException from service', async () => {
      mockService.getReportById.mockRejectedValue(
        new NotFoundException(`DataQualityReport ${REPORT_ID} not found`),
      );

      await expect(controller.getReportById(REPORT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // =========================================================================
  // PATCH /reports/:id/resolve - resolveIssue
  // =========================================================================

  describe('PATCH /reports/:id/resolve - resolveIssue', () => {
    it('should resolve issue with valid DTO', async () => {
      const resolvedReport = makeReport({
        status: DataQualityReportStatus.REVIEWED,
        resolutions: [
          { issueIndex: 0, resolvedAt: new Date(), resolvedBy: 'manual', action: 'Merged duplicates' },
        ],
      });
      mockService.resolveIssue.mockResolvedValue(resolvedReport);

      const dto = { issueIndex: 0, action: 'Merged duplicates' };
      const result = await controller.resolveIssue(REPORT_ID, dto as any);

      expect(result).toEqual(resolvedReport);
      expect(mockService.resolveIssue).toHaveBeenCalledWith(
        REPORT_ID,
        0,
        'Merged duplicates',
      );
    });

    it('should pass issueIndex and action from DTO', async () => {
      mockService.resolveIssue.mockResolvedValue(makeReport());

      const dto = { issueIndex: 3, action: 'Assigned parent' };
      await controller.resolveIssue(REPORT_ID, dto as any);

      expect(mockService.resolveIssue).toHaveBeenCalledWith(
        REPORT_ID,
        3,
        'Assigned parent',
      );
    });
  });

  // =========================================================================
  // GET /metrics - getMetrics
  // =========================================================================

  describe('GET /metrics - getMetrics', () => {
    it('should return current metrics', async () => {
      const metrics = makeMetrics();
      mockService.getCurrentMetrics.mockResolvedValue(metrics);

      const result = await controller.getMetrics();

      expect(result).toEqual(metrics);
      expect(mockService.getCurrentMetrics).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // POST /merge - mergeActivities
  // =========================================================================

  describe('POST /merge - mergeActivities', () => {
    it('should merge with valid DTO', async () => {
      const keepActivity = {
        id: KEEP_ID,
        name: 'Keep Project',
      };
      mockService.mergeActivities.mockResolvedValue(keepActivity);

      const dto = { keepId: KEEP_ID, mergeIds: [MERGE_ID_1, MERGE_ID_2] };
      const result = await controller.mergeActivities(dto as any);

      expect(result).toEqual(keepActivity);
      expect(mockService.mergeActivities).toHaveBeenCalledWith(
        KEEP_ID,
        [MERGE_ID_1, MERGE_ID_2],
      );
    });

    it('should propagate NotFoundException when keepId not found', async () => {
      mockService.mergeActivities.mockRejectedValue(
        new NotFoundException(`Activity to keep (${KEEP_ID}) not found`),
      );

      const dto = { keepId: KEEP_ID, mergeIds: [MERGE_ID_1] };

      await expect(controller.mergeActivities(dto as any)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
