import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { NotFoundException, ConflictException } from '@nestjs/common';
import {
  PendingApprovalService,
  CreatePendingApprovalInput,
} from './pending-approval.service';
import {
  PendingApproval,
  PendingApprovalItemType,
  PendingApprovalStatus,
  EntityFact,
  EntityFactStatus,
  Activity,
  Commitment,
} from '@pkg/entities';

describe('PendingApprovalService', () => {
  let service: PendingApprovalService;
  let approvalRepo: Repository<PendingApproval>;
  let factRepo: Repository<EntityFact>;
  let dataSource: DataSource;
  let configService: ConfigService;

  const mockApproval: Partial<PendingApproval> = {
    id: 'approval-uuid-1',
    itemType: PendingApprovalItemType.FACT,
    targetId: 'fact-uuid-1',
    batchId: 'batch-uuid-1',
    status: PendingApprovalStatus.PENDING,
    confidence: 0.85,
    sourceQuote: 'Test quote',
    sourceInteractionId: 'interaction-uuid-1',
    messageRef: 'msg:123',
    createdAt: new Date(),
    reviewedAt: null,
  };

  const mockQueryBuilder = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getMany: jest.fn(),
    getManyAndCount: jest.fn(),
    getRawMany: jest.fn(),
  };

  const mockApprovalRepository = {
    create: jest.fn().mockImplementation((data) => ({ ...mockApproval, ...data })),
    save: jest.fn().mockImplementation((data) => Promise.resolve({ ...mockApproval, ...data })),
    findOne: jest.fn(),
    find: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
  };

  const mockFactRepository = {
    findOne: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
    delete: jest.fn(),
  };

  const mockActivityRepository = {
    findOne: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
    delete: jest.fn(),
  };

  const mockCommitmentRepository = {
    findOne: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
    delete: jest.fn(),
  };

  // Transaction manager mock
  const mockManager = {
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    softDelete: jest.fn(),
  };

  const mockDataSource = {
    transaction: jest.fn().mockImplementation(async (cb) => cb(mockManager)),
  };

  const mockConfigService = {
    get: jest.fn().mockReturnValue(30), // Default retention days
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    // Reset manager mocks
    mockManager.findOne.mockReset();
    mockManager.find.mockReset();
    mockManager.save.mockReset();
    mockManager.update.mockReset();
    mockManager.delete.mockReset();
    mockManager.softDelete.mockReset();

    // Reset config mock to default
    mockConfigService.get.mockReturnValue(30);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PendingApprovalService,
        {
          provide: getRepositoryToken(PendingApproval),
          useValue: mockApprovalRepository,
        },
        {
          provide: getRepositoryToken(EntityFact),
          useValue: mockFactRepository,
        },
        {
          provide: getRepositoryToken(Activity),
          useValue: mockActivityRepository,
        },
        {
          provide: getRepositoryToken(Commitment),
          useValue: mockCommitmentRepository,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<PendingApprovalService>(PendingApprovalService);
    approvalRepo = module.get<Repository<PendingApproval>>(
      getRepositoryToken(PendingApproval),
    );
    factRepo = module.get<Repository<EntityFact>>(getRepositoryToken(EntityFact));
    dataSource = module.get<DataSource>(DataSource);
    configService = module.get<ConfigService>(ConfigService);
  });

  describe('create', () => {
    const createInput: CreatePendingApprovalInput = {
      itemType: PendingApprovalItemType.FACT,
      targetId: 'fact-uuid-1',
      batchId: 'batch-uuid-1',
      confidence: 0.85,
      sourceQuote: 'Test quote',
      sourceInteractionId: 'interaction-uuid-1',
      messageRef: 'msg:123',
    };

    it('should create a new pending approval', async () => {
      const result = await service.create(createInput);

      expect(mockApprovalRepository.create).toHaveBeenCalledWith({
        itemType: PendingApprovalItemType.FACT,
        targetId: 'fact-uuid-1',
        batchId: 'batch-uuid-1',
        confidence: 0.85,
        sourceQuote: 'Test quote',
        sourceInteractionId: 'interaction-uuid-1',
        messageRef: 'msg:123',
        status: PendingApprovalStatus.PENDING,
      });
      expect(mockApprovalRepository.save).toHaveBeenCalled();
      expect(result.status).toBe(PendingApprovalStatus.PENDING);
    });

    it('should handle optional fields as null', async () => {
      const minimalInput: CreatePendingApprovalInput = {
        itemType: PendingApprovalItemType.FACT,
        targetId: 'fact-uuid-1',
        batchId: 'batch-uuid-1',
        confidence: 0.7,
      };

      await service.create(minimalInput);

      expect(mockApprovalRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceQuote: null,
          sourceInteractionId: null,
          messageRef: null,
        }),
      );
    });
  });

  describe('getById', () => {
    it('should return approval when found', async () => {
      mockApprovalRepository.findOne.mockResolvedValue(mockApproval);

      const result = await service.getById('approval-uuid-1');

      expect(result).toEqual(mockApproval);
      expect(mockApprovalRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'approval-uuid-1' },
        relations: ['sourceInteraction'],
      });
    });

    it('should return null when not found', async () => {
      mockApprovalRepository.findOne.mockResolvedValue(null);

      const result = await service.getById('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('list', () => {
    const approvals = [
      { ...mockApproval, id: '1' },
      { ...mockApproval, id: '2' },
    ];

    it('should return approvals with default pagination', async () => {
      mockQueryBuilder.getManyAndCount.mockResolvedValue([approvals, 2]);

      const result = await service.list();

      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(mockQueryBuilder.take).toHaveBeenCalledWith(50);
      expect(mockQueryBuilder.skip).toHaveBeenCalledWith(0);
    });

    it('should filter by batchId', async () => {
      mockQueryBuilder.getManyAndCount.mockResolvedValue([approvals, 2]);

      await service.list({ batchId: 'batch-uuid-1' });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'pa.batchId = :batchId',
        { batchId: 'batch-uuid-1' },
      );
    });

    it('should filter by status', async () => {
      mockQueryBuilder.getManyAndCount.mockResolvedValue([[], 0]);

      await service.list({ status: PendingApprovalStatus.APPROVED });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'pa.status = :status',
        { status: PendingApprovalStatus.APPROVED },
      );
    });

    it('should apply custom pagination', async () => {
      mockQueryBuilder.getManyAndCount.mockResolvedValue([[], 0]);

      await service.list({ limit: 10, offset: 20 });

      expect(mockQueryBuilder.take).toHaveBeenCalledWith(10);
      expect(mockQueryBuilder.skip).toHaveBeenCalledWith(20);
    });
  });

  describe('approve', () => {
    it('should approve pending item and activate target', async () => {
      mockManager.findOne.mockResolvedValue({ ...mockApproval });
      mockManager.update.mockResolvedValue({ affected: 1 });
      mockManager.save.mockResolvedValue({ ...mockApproval, status: PendingApprovalStatus.APPROVED });

      await service.approve('approval-uuid-1');

      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockManager.update).toHaveBeenCalledWith(
        EntityFact,
        { id: 'fact-uuid-1' },
        { status: EntityFactStatus.ACTIVE },
      );
      expect(mockManager.save).toHaveBeenCalledWith(
        PendingApproval,
        expect.objectContaining({
          status: PendingApprovalStatus.APPROVED,
          reviewedAt: expect.any(Date),
        }),
      );
    });

    it('should throw NotFoundException when approval not found', async () => {
      mockManager.findOne.mockResolvedValue(null);

      await expect(service.approve('non-existent')).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException when already processed', async () => {
      mockManager.findOne.mockResolvedValue({
        ...mockApproval,
        status: PendingApprovalStatus.APPROVED,
      });

      await expect(service.approve('approval-uuid-1')).rejects.toThrow(ConflictException);
    });

    it('should throw NotFoundException when target entity not found', async () => {
      mockManager.findOne.mockResolvedValue({ ...mockApproval });
      mockManager.update.mockResolvedValue({ affected: 0 });

      await expect(service.approve('approval-uuid-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('reject', () => {
    it('should reject pending item with soft delete (retention > 0)', async () => {
      mockManager.findOne.mockResolvedValue({ ...mockApproval });
      mockManager.softDelete.mockResolvedValue({ affected: 1 });
      mockManager.save.mockResolvedValue({ ...mockApproval, status: PendingApprovalStatus.REJECTED });

      await service.reject('approval-uuid-1');

      expect(mockManager.softDelete).toHaveBeenCalledWith(EntityFact, { id: 'fact-uuid-1' });
      expect(mockManager.save).toHaveBeenCalledWith(
        PendingApproval,
        expect.objectContaining({
          status: PendingApprovalStatus.REJECTED,
          reviewedAt: expect.any(Date),
        }),
      );
    });

    it('should reject pending item with hard delete (retention = 0)', async () => {
      // Reconfigure service with retention = 0
      mockConfigService.get.mockReturnValue(0);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PendingApprovalService,
          { provide: getRepositoryToken(PendingApproval), useValue: mockApprovalRepository },
          { provide: getRepositoryToken(EntityFact), useValue: mockFactRepository },
          { provide: getRepositoryToken(Activity), useValue: mockActivityRepository },
          { provide: getRepositoryToken(Commitment), useValue: mockCommitmentRepository },
          { provide: DataSource, useValue: mockDataSource },
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();

      const serviceWithNoRetention = module.get<PendingApprovalService>(PendingApprovalService);

      mockManager.findOne.mockResolvedValue({ ...mockApproval });
      mockManager.delete.mockResolvedValue({ affected: 1 });

      await serviceWithNoRetention.reject('approval-uuid-1');

      expect(mockManager.delete).toHaveBeenCalledWith(EntityFact, { id: 'fact-uuid-1' });
      expect(mockManager.delete).toHaveBeenCalledWith(PendingApproval, 'approval-uuid-1');
    });

    it('should throw NotFoundException when approval not found', async () => {
      mockManager.findOne.mockResolvedValue(null);

      await expect(service.reject('non-existent')).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException when already processed', async () => {
      mockManager.findOne.mockResolvedValue({
        ...mockApproval,
        status: PendingApprovalStatus.REJECTED,
      });

      await expect(service.reject('approval-uuid-1')).rejects.toThrow(ConflictException);
    });
  });

  describe('approveBatch', () => {
    const batchApprovals = [
      { ...mockApproval, id: '1', targetId: 'fact-1' },
      { ...mockApproval, id: '2', targetId: 'fact-2' },
    ];

    it('should approve all pending items in batch', async () => {
      mockManager.find.mockResolvedValue(batchApprovals);
      mockManager.update.mockResolvedValue({ affected: 1 });
      mockManager.save.mockResolvedValue(batchApprovals);

      const result = await service.approveBatch('batch-uuid-1');

      expect(result.processed).toBe(2);
      expect(result.failed).toBe(0);
      expect(mockManager.update).toHaveBeenCalledTimes(2);
    });

    it('should return zeros when no pending items in batch', async () => {
      mockManager.find.mockResolvedValue([]);

      const result = await service.approveBatch('batch-uuid-1');

      expect(result.processed).toBe(0);
      expect(result.failed).toBe(0);
    });

    it('should track failed items when target not found', async () => {
      mockManager.find.mockResolvedValue(batchApprovals);
      mockManager.update
        .mockResolvedValueOnce({ affected: 1 }) // First succeeds
        .mockResolvedValueOnce({ affected: 0 }); // Second fails

      const result = await service.approveBatch('batch-uuid-1');

      expect(result.processed).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
    });
  });

  describe('rejectBatch', () => {
    const batchApprovals = [
      { ...mockApproval, id: '1', targetId: 'fact-1' },
      { ...mockApproval, id: '2', targetId: 'fact-2' },
    ];

    it('should reject all pending items in batch with soft delete', async () => {
      mockManager.find.mockResolvedValue(batchApprovals);
      mockManager.softDelete.mockResolvedValue({ affected: 1 });
      mockManager.save.mockResolvedValue(batchApprovals);

      const result = await service.rejectBatch('batch-uuid-1');

      expect(result.processed).toBe(2);
      expect(result.failed).toBe(0);
      expect(mockManager.softDelete).toHaveBeenCalledTimes(2);
    });

    it('should return zeros when no pending items in batch', async () => {
      mockManager.find.mockResolvedValue([]);

      const result = await service.rejectBatch('batch-uuid-1');

      expect(result.processed).toBe(0);
      expect(result.failed).toBe(0);
    });

    it('should hard delete when retention = 0', async () => {
      mockConfigService.get.mockReturnValue(0);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PendingApprovalService,
          { provide: getRepositoryToken(PendingApproval), useValue: mockApprovalRepository },
          { provide: getRepositoryToken(EntityFact), useValue: mockFactRepository },
          { provide: getRepositoryToken(Activity), useValue: mockActivityRepository },
          { provide: getRepositoryToken(Commitment), useValue: mockCommitmentRepository },
          { provide: DataSource, useValue: mockDataSource },
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();

      const serviceWithNoRetention = module.get<PendingApprovalService>(PendingApprovalService);

      mockManager.find.mockResolvedValue(batchApprovals);
      mockManager.delete.mockResolvedValue({ affected: 1 });

      const result = await serviceWithNoRetention.rejectBatch('batch-uuid-1');

      expect(result.processed).toBe(2);
      expect(mockManager.delete).toHaveBeenCalled();
    });
  });

  describe('getBatchStats', () => {
    it('should return statistics for a batch', async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        { status: 'pending', count: '5' },
        { status: 'approved', count: '3' },
        { status: 'rejected', count: '2' },
      ]);

      const result = await service.getBatchStats('batch-uuid-1');

      expect(result).toEqual({
        total: 10,
        pending: 5,
        approved: 3,
        rejected: 2,
      });
    });

    it('should return zeros when batch is empty', async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([]);

      const result = await service.getBatchStats('empty-batch');

      expect(result).toEqual({
        total: 0,
        pending: 0,
        approved: 0,
        rejected: 0,
      });
    });

    it('should handle partial status counts', async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        { status: 'pending', count: '3' },
      ]);

      const result = await service.getBatchStats('batch-uuid-1');

      expect(result).toEqual({
        total: 3,
        pending: 3,
        approved: 0,
        rejected: 0,
      });
    });
  });
});
