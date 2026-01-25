import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { ConfirmationService } from './confirmation.service';
import {
  PendingConfirmation,
  PendingConfirmationStatus,
  PendingConfirmationType,
  PendingConfirmationResolvedBy,
  ConfirmationContext,
  ConfirmationOption,
} from '@pkg/entities';
import { CreateConfirmationDto } from './dto/create-confirmation.dto';

describe('ConfirmationService', () => {
  let service: ConfirmationService;
  let repo: Repository<PendingConfirmation>;

  const mockContext: ConfirmationContext = {
    title: 'Test Confirmation',
    description: 'Test description',
    sourceQuote: 'Test quote',
  };

  const mockOptions: ConfirmationOption[] = [
    { id: 'opt-1', label: 'Option 1', entityId: 'entity-1' },
    { id: 'opt-2', label: 'Option 2', isCreateNew: true },
    { id: 'decline', label: 'Skip', isDecline: true },
  ];

  const mockConfirmation: Partial<PendingConfirmation> = {
    id: 'confirmation-uuid-1',
    type: PendingConfirmationType.IDENTIFIER_ATTRIBUTION,
    context: mockContext,
    options: mockOptions,
    confidence: 0.8,
    status: PendingConfirmationStatus.PENDING,
    sourceMessageId: 'msg-1',
    sourceEntityId: 'entity-1',
    sourcePendingFactId: null,
    selectedOptionId: null,
    resolution: null,
    resolvedAt: null,
    resolvedBy: null,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
  };

  const mockQueryBuilder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
    getMany: jest.fn(),
    getRawMany: jest.fn(),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    execute: jest.fn(),
  };

  const mockRepository = {
    create: jest.fn().mockImplementation((data) => ({ ...mockConfirmation, ...data })),
    save: jest.fn().mockImplementation((data) => Promise.resolve({ ...mockConfirmation, ...data })),
    findOne: jest.fn(),
    find: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConfirmationService,
        {
          provide: getRepositoryToken(PendingConfirmation),
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get<ConfirmationService>(ConfirmationService);
    repo = module.get<Repository<PendingConfirmation>>(
      getRepositoryToken(PendingConfirmation),
    );
  });

  describe('create', () => {
    const createDto: CreateConfirmationDto = {
      type: PendingConfirmationType.IDENTIFIER_ATTRIBUTION,
      context: mockContext,
      options: mockOptions,
      confidence: 0.8,
      sourceMessageId: 'msg-1',
      sourceEntityId: 'entity-1',
    };

    it('should create a new confirmation when no duplicate exists', async () => {
      mockQueryBuilder.getOne.mockResolvedValue(null);

      const result = await service.create(createDto);

      expect(mockRepository.create).toHaveBeenCalled();
      expect(mockRepository.save).toHaveBeenCalled();
      expect(result.type).toBe(PendingConfirmationType.IDENTIFIER_ATTRIBUTION);
      expect(result.status).toBe(PendingConfirmationStatus.PENDING);
    });

    it('should return existing confirmation when duplicate found', async () => {
      const existing = { ...mockConfirmation, id: 'existing-id' };
      mockQueryBuilder.getOne.mockResolvedValue(existing);

      const result = await service.create(createDto);

      expect(result.id).toBe('existing-id');
      expect(mockRepository.save).not.toHaveBeenCalled();
    });

    it('should deduplicate by sourcePendingFactId', async () => {
      const dto: CreateConfirmationDto = {
        ...createDto,
        sourcePendingFactId: 'fact-1',
      };
      mockQueryBuilder.getOne.mockResolvedValue(null);

      await service.create(dto);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'c.source_pending_fact_id = :factId',
        { factId: 'fact-1' },
      );
    });

    it('should set null for optional fields when not provided', async () => {
      const minimalDto: CreateConfirmationDto = {
        type: PendingConfirmationType.ENTITY_MERGE,
        context: mockContext,
        options: mockOptions,
      };
      mockQueryBuilder.getOne.mockResolvedValue(null);

      await service.create(minimalDto);

      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          confidence: null,
          sourceMessageId: null,
          sourceEntityId: null,
          sourcePendingFactId: null,
        }),
      );
    });

    it('should calculate correct expiry for different types', async () => {
      mockQueryBuilder.getOne.mockResolvedValue(null);

      // ENTITY_MERGE has 30-day expiry
      const mergeDto: CreateConfirmationDto = {
        type: PendingConfirmationType.ENTITY_MERGE,
        context: mockContext,
        options: mockOptions,
        sourceEntityId: 'entity-1',
      };

      const beforeCreate = Date.now();
      await service.create(mergeDto);
      const afterCreate = Date.now();

      const createCall = mockRepository.create.mock.calls[0][0];
      const expiryMs = createCall.expiresAt.getTime() - beforeCreate;

      // Should be approximately 30 days
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      expect(expiryMs).toBeGreaterThanOrEqual(thirtyDaysMs - 1000);
      expect(expiryMs).toBeLessThanOrEqual(thirtyDaysMs + (afterCreate - beforeCreate) + 1000);
    });
  });

  describe('resolve', () => {
    it('should resolve confirmation with CONFIRMED status for regular option', async () => {
      mockRepository.findOne.mockResolvedValue({ ...mockConfirmation });

      const result = await service.resolve('confirmation-uuid-1', 'opt-1', { entityId: 'entity-1' });

      expect(result.status).toBe(PendingConfirmationStatus.CONFIRMED);
      expect(result.selectedOptionId).toBe('opt-1');
      expect(result.resolution).toEqual({ entityId: 'entity-1' });
      expect(result.resolvedBy).toBe(PendingConfirmationResolvedBy.USER);
      expect(result.resolvedAt).toBeDefined();
      expect(mockRepository.save).toHaveBeenCalled();
    });

    it('should resolve confirmation with DECLINED status for decline option', async () => {
      mockRepository.findOne.mockResolvedValue({ ...mockConfirmation });

      const result = await service.resolve('confirmation-uuid-1', 'decline');

      expect(result.status).toBe(PendingConfirmationStatus.DECLINED);
      expect(result.selectedOptionId).toBe('decline');
    });

    it('should resolve confirmation with DECLINED when option has isDecline flag', async () => {
      const confirmationWithDeclineOption = {
        ...mockConfirmation,
        options: [
          { id: 'skip', label: 'Skip this', isDecline: true },
        ],
      };
      mockRepository.findOne.mockResolvedValue(confirmationWithDeclineOption);

      const result = await service.resolve('confirmation-uuid-1', 'skip');

      expect(result.status).toBe(PendingConfirmationStatus.DECLINED);
    });

    it('should throw NotFoundException when confirmation not found', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      await expect(service.resolve('non-existent', 'opt-1')).rejects.toThrow(NotFoundException);
    });

    it('should return existing confirmation if already resolved', async () => {
      const alreadyResolved = {
        ...mockConfirmation,
        status: PendingConfirmationStatus.CONFIRMED,
        selectedOptionId: 'opt-1',
      };
      mockRepository.findOne.mockResolvedValue(alreadyResolved);

      const result = await service.resolve('confirmation-uuid-1', 'opt-2');

      // Should return as-is, not update
      expect(result.selectedOptionId).toBe('opt-1');
      expect(mockRepository.save).not.toHaveBeenCalled();
    });

    it('should set resolution to null when not provided', async () => {
      mockRepository.findOne.mockResolvedValue({ ...mockConfirmation });

      const result = await service.resolve('confirmation-uuid-1', 'opt-1');

      expect(result.resolution).toBeNull();
    });
  });

  describe('findById', () => {
    it('should return confirmation when found', async () => {
      mockRepository.findOne.mockResolvedValue(mockConfirmation);

      const result = await service.findById('confirmation-uuid-1');

      expect(result).toEqual(mockConfirmation);
      expect(mockRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'confirmation-uuid-1' },
      });
    });

    it('should return null when not found', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      const result = await service.findById('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('getPending', () => {
    const pendingConfirmations = [
      { ...mockConfirmation, id: '1', confidence: 0.5 },
      { ...mockConfirmation, id: '2', confidence: 0.8 },
    ];

    it('should return pending confirmations sorted by confidence', async () => {
      mockQueryBuilder.getMany.mockResolvedValue(pendingConfirmations);

      const result = await service.getPending();

      expect(result).toHaveLength(2);
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('c.status = :status', {
        status: PendingConfirmationStatus.PENDING,
      });
      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('c.confidence', 'ASC', 'NULLS FIRST');
    });

    it('should filter by type when provided', async () => {
      mockQueryBuilder.getMany.mockResolvedValue([]);

      await service.getPending({ type: PendingConfirmationType.FACT_SUBJECT });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('c.type = :type', {
        type: PendingConfirmationType.FACT_SUBJECT,
      });
    });

    it('should filter by entityId when provided', async () => {
      mockQueryBuilder.getMany.mockResolvedValue([]);

      await service.getPending({ entityId: 'entity-1' });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('c.source_entity_id = :entityId', {
        entityId: 'entity-1',
      });
    });

    it('should apply custom limit when provided', async () => {
      mockQueryBuilder.getMany.mockResolvedValue([]);

      await service.getPending({ limit: 5 });

      expect(mockQueryBuilder.take).toHaveBeenCalledWith(5);
    });

    it('should use default limit of 10', async () => {
      mockQueryBuilder.getMany.mockResolvedValue([]);

      await service.getPending();

      expect(mockQueryBuilder.take).toHaveBeenCalledWith(10);
    });
  });

  describe('findBySourceEntity', () => {
    it('should return confirmations for entity ordered by createdAt DESC', async () => {
      const confirmations = [
        { ...mockConfirmation, id: '1' },
        { ...mockConfirmation, id: '2' },
      ];
      mockRepository.find.mockResolvedValue(confirmations);

      const result = await service.findBySourceEntity('entity-1');

      expect(result).toHaveLength(2);
      expect(mockRepository.find).toHaveBeenCalledWith({
        where: { sourceEntityId: 'entity-1' },
        order: { createdAt: 'DESC' },
      });
    });

    it('should return empty array when no confirmations found', async () => {
      mockRepository.find.mockResolvedValue([]);

      const result = await service.findBySourceEntity('entity-without-confirmations');

      expect(result).toEqual([]);
    });
  });

  describe('expireOld', () => {
    it('should expire pending confirmations past their expiry date', async () => {
      mockQueryBuilder.execute.mockResolvedValue({ affected: 5 });

      const result = await service.expireOld();

      expect(result).toBe(5);
      expect(mockQueryBuilder.update).toHaveBeenCalledWith(PendingConfirmation);
      expect(mockQueryBuilder.set).toHaveBeenCalledWith({
        status: PendingConfirmationStatus.EXPIRED,
        resolvedAt: expect.any(Date),
        resolvedBy: PendingConfirmationResolvedBy.EXPIRED,
      });
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('status = :status', {
        status: PendingConfirmationStatus.PENDING,
      });
    });

    it('should return 0 when no confirmations expired', async () => {
      mockQueryBuilder.execute.mockResolvedValue({ affected: 0 });

      const result = await service.expireOld();

      expect(result).toBe(0);
    });

    it('should return 0 when affected is undefined', async () => {
      mockQueryBuilder.execute.mockResolvedValue({});

      const result = await service.expireOld();

      expect(result).toBe(0);
    });
  });

  describe('countPending', () => {
    it('should return counts for all types', async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        { type: PendingConfirmationType.IDENTIFIER_ATTRIBUTION, count: '5' },
        { type: PendingConfirmationType.FACT_SUBJECT, count: '3' },
      ]);

      const result = await service.countPending();

      expect(result).toEqual({
        [PendingConfirmationType.IDENTIFIER_ATTRIBUTION]: 5,
        [PendingConfirmationType.ENTITY_MERGE]: 0,
        [PendingConfirmationType.FACT_SUBJECT]: 3,
        [PendingConfirmationType.FACT_VALUE]: 0,
      });
    });

    it('should return all zeros when no pending confirmations', async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([]);

      const result = await service.countPending();

      expect(result).toEqual({
        [PendingConfirmationType.IDENTIFIER_ATTRIBUTION]: 0,
        [PendingConfirmationType.ENTITY_MERGE]: 0,
        [PendingConfirmationType.FACT_SUBJECT]: 0,
        [PendingConfirmationType.FACT_VALUE]: 0,
      });
    });
  });
});
