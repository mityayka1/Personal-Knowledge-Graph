import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { PendingResolutionService } from './pending-resolution.service';
import { PendingEntityResolution, ResolutionStatus } from '@pkg/entities';

describe('PendingResolutionService', () => {
  let service: PendingResolutionService;
  let resolutionRepo: Repository<PendingEntityResolution>;

  const mockResolution = {
    id: 'test-uuid-1',
    identifierType: 'telegram_user_id',
    identifierValue: '123456789',
    displayName: 'John Doe',
    status: ResolutionStatus.PENDING,
    suggestions: [],
    firstSeenAt: new Date(),
    resolvedAt: null,
    resolvedEntityId: null,
    metadata: null,
  };

  const mockResolutionRepository = {
    findAndCount: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PendingResolutionService,
        {
          provide: getRepositoryToken(PendingEntityResolution),
          useValue: mockResolutionRepository,
        },
      ],
    }).compile();

    service = module.get<PendingResolutionService>(PendingResolutionService);
    resolutionRepo = module.get<Repository<PendingEntityResolution>>(getRepositoryToken(PendingEntityResolution));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findAll', () => {
    it('should return paginated resolutions', async () => {
      mockResolutionRepository.findAndCount.mockResolvedValue([[mockResolution], 1]);

      const result = await service.findAll();

      expect(result).toEqual({ items: [mockResolution], total: 1 });
      expect(resolutionRepo.findAndCount).toHaveBeenCalledWith({
        where: {},
        order: { firstSeenAt: 'DESC' },
        take: 50,
        skip: 0,
      });
    });

    it('should filter by status', async () => {
      mockResolutionRepository.findAndCount.mockResolvedValue([[], 0]);

      await service.findAll(ResolutionStatus.PENDING);

      expect(resolutionRepo.findAndCount).toHaveBeenCalledWith({
        where: { status: ResolutionStatus.PENDING },
        order: { firstSeenAt: 'DESC' },
        take: 50,
        skip: 0,
      });
    });
  });

  describe('findOne', () => {
    it('should return resolution with relations', async () => {
      mockResolutionRepository.findOne.mockResolvedValue(mockResolution);

      const result = await service.findOne('test-uuid-1');

      expect(result).toEqual(mockResolution);
      expect(resolutionRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'test-uuid-1' },
        relations: ['resolvedEntity'],
      });
    });

    it('should throw NotFoundException if not found', async () => {
      mockResolutionRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne('non-existent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findOrCreate', () => {
    it('should create new resolution if not exists', async () => {
      mockResolutionRepository.findOne.mockResolvedValue(null);
      const newResolution = { ...mockResolution };
      mockResolutionRepository.create.mockReturnValue(newResolution);
      mockResolutionRepository.save.mockResolvedValue(newResolution);

      const result = await service.findOrCreate({
        identifierType: 'telegram_user_id',
        identifierValue: '123456789',
        displayName: 'John Doe',
      });

      expect(result).toEqual(newResolution);
      expect(resolutionRepo.create).toHaveBeenCalled();
      expect(resolutionRepo.save).toHaveBeenCalled();
    });

    it('should return existing resolution', async () => {
      mockResolutionRepository.findOne.mockResolvedValue(mockResolution);

      const result = await service.findOrCreate({
        identifierType: 'telegram_user_id',
        identifierValue: '123456789',
      });

      expect(result).toEqual(mockResolution);
      expect(resolutionRepo.create).not.toHaveBeenCalled();
    });

    it('should update metadata if now provided', async () => {
      const existingResolution = { ...mockResolution, metadata: null };
      mockResolutionRepository.findOne.mockResolvedValue(existingResolution);
      mockResolutionRepository.save.mockResolvedValue(existingResolution);

      await service.findOrCreate({
        identifierType: 'telegram_user_id',
        identifierValue: '123456789',
        metadata: { username: 'johndoe' },
      });

      expect(resolutionRepo.save).toHaveBeenCalled();
    });
  });

  describe('updateSuggestions', () => {
    it('should update suggestions', async () => {
      mockResolutionRepository.findOne.mockResolvedValue({ ...mockResolution });
      mockResolutionRepository.save.mockResolvedValue(mockResolution);

      const suggestions = [
        { entity_id: 'ent-1', name: 'John', confidence: 0.8, reason: 'Name match' },
      ];

      const result = await service.updateSuggestions('test-uuid-1', suggestions);

      expect(result).toEqual({
        id: 'test-uuid-1',
        status: ResolutionStatus.PENDING,
        suggestions_count: 1,
        auto_resolved: false,
      });
    });

    it('should auto-resolve if confidence >= 0.9', async () => {
      const resolution = { ...mockResolution };
      mockResolutionRepository.findOne.mockResolvedValue(resolution);
      mockResolutionRepository.save.mockImplementation((r) => Promise.resolve(r));

      const suggestions = [
        { entity_id: 'ent-1', name: 'John', confidence: 0.95, reason: 'High confidence match' },
      ];

      const result = await service.updateSuggestions('test-uuid-1', suggestions);

      expect(result.auto_resolved).toBe(true);
      expect((result as any).entity_id).toBe('ent-1');
    });
  });

  describe('resolve', () => {
    it('should resolve pending resolution', async () => {
      const resolution = { ...mockResolution };
      mockResolutionRepository.findOne.mockResolvedValue(resolution);
      mockResolutionRepository.save.mockResolvedValue(resolution);

      const result = await service.resolve('test-uuid-1', 'entity-uuid');

      expect(result).toEqual({
        id: 'test-uuid-1',
        status: 'resolved',
        entity_id: 'entity-uuid',
        resolved_at: expect.any(Date),
        auto_resolved: false,
      });
    });
  });

  describe('ignore', () => {
    it('should set status to ignored', async () => {
      const resolution = { ...mockResolution };
      mockResolutionRepository.findOne.mockResolvedValue(resolution);
      mockResolutionRepository.save.mockResolvedValue(resolution);

      const result = await service.ignore('test-uuid-1');

      expect(result).toEqual({
        id: 'test-uuid-1',
        status: 'ignored',
      });
    });
  });
});
