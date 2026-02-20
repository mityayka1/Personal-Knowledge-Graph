import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Activity } from '@pkg/entities';
import { DedupBatchCleanupJob } from '../dedup-batch-cleanup.job';
import { LlmDedupService } from '../llm-dedup.service';
import { DataQualityService } from '../../data-quality/data-quality.service';

describe('DedupBatchCleanupJob', () => {
  let job: DedupBatchCleanupJob;
  let llmDedupService: jest.Mocked<LlmDedupService>;
  let dataQualityService: jest.Mocked<DataQualityService>;

  const mockQueryBuilder = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockQueryBuilder.getRawMany.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DedupBatchCleanupJob,
        {
          provide: LlmDedupService,
          useValue: { decideBatch: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: DataQualityService,
          useValue: { mergeActivities: jest.fn().mockResolvedValue({}) },
        },
        {
          provide: getRepositoryToken(Activity),
          useValue: {
            createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
          },
        },
      ],
    }).compile();

    job = module.get(DedupBatchCleanupJob);
    llmDedupService = module.get(LlmDedupService);
    dataQualityService = module.get(DataQualityService);
  });

  it('should be defined', () => {
    expect(job).toBeDefined();
  });

  it('should run without errors when no duplicates found', async () => {
    const result = await job.run();

    expect(result).toEqual({ activityMerged: 0, pairsChecked: 0 });
    expect(llmDedupService.decideBatch).not.toHaveBeenCalled();
  });

  it('should find and merge high-confidence activity duplicates', async () => {
    mockQueryBuilder.getRawMany.mockResolvedValueOnce([
      { id_a: 'act-1', name_a: 'Панавто', id_b: 'act-2', name_b: 'панавто хаб', similarity: 0.85 },
    ]);

    llmDedupService.decideBatch.mockResolvedValueOnce([
      { isDuplicate: true, confidence: 0.95, reason: 'Same project' },
    ]);

    const result = await job.run();

    expect(result.pairsChecked).toBe(1);
    expect(result.activityMerged).toBe(1);
    expect(dataQualityService.mergeActivities).toHaveBeenCalledWith('act-1', ['act-2']);
  });

  it('should skip merge when LLM confidence is below threshold', async () => {
    mockQueryBuilder.getRawMany.mockResolvedValueOnce([
      { id_a: 'act-1', name_a: 'Project A', id_b: 'act-2', name_b: 'Project B', similarity: 0.65 },
    ]);

    llmDedupService.decideBatch.mockResolvedValueOnce([
      { isDuplicate: true, confidence: 0.6, reason: 'Maybe similar' },
    ]);

    const result = await job.run();

    expect(result.pairsChecked).toBe(1);
    expect(result.activityMerged).toBe(0);
    expect(dataQualityService.mergeActivities).not.toHaveBeenCalled();
  });

  it('should skip merge when LLM says not duplicate', async () => {
    mockQueryBuilder.getRawMany.mockResolvedValueOnce([
      { id_a: 'act-1', name_a: 'PKG', id_b: 'act-2', name_b: 'PGK', similarity: 0.7 },
    ]);

    llmDedupService.decideBatch.mockResolvedValueOnce([
      { isDuplicate: false, confidence: 0.9, reason: 'Different projects' },
    ]);

    const result = await job.run();

    expect(result.activityMerged).toBe(0);
  });

  it('should handle merge errors gracefully', async () => {
    mockQueryBuilder.getRawMany.mockResolvedValueOnce([
      { id_a: 'act-1', name_a: 'Test', id_b: 'act-2', name_b: 'Test 2', similarity: 0.9 },
    ]);

    llmDedupService.decideBatch.mockResolvedValueOnce([
      { isDuplicate: true, confidence: 0.95, reason: 'Same' },
    ]);

    dataQualityService.mergeActivities.mockRejectedValueOnce(new Error('Merge failed'));

    const result = await job.run();

    expect(result.activityMerged).toBe(0);
  });
});
