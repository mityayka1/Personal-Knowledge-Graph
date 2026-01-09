import { Test, TestingModule } from '@nestjs/testing';
import { PendingResolutionController } from './pending-resolution.controller';
import { PendingResolutionService } from './pending-resolution.service';
import { ResolutionStatus } from '@pkg/entities';

describe('PendingResolutionController', () => {
  let controller: PendingResolutionController;
  let service: PendingResolutionService;

  const mockResolution = {
    id: 'test-uuid-1',
    identifierType: 'telegram_user_id',
    identifierValue: '123456789',
    displayName: 'John Doe',
    status: ResolutionStatus.PENDING,
    suggestions: [],
    firstSeenAt: new Date(),
  };

  const mockResolutionService = {
    findAll: jest.fn(),
    findOne: jest.fn(),
    updateSuggestions: jest.fn(),
    resolve: jest.fn(),
    ignore: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PendingResolutionController],
      providers: [
        {
          provide: PendingResolutionService,
          useValue: mockResolutionService,
        },
      ],
    }).compile();

    controller = module.get<PendingResolutionController>(PendingResolutionController);
    service = module.get<PendingResolutionService>(PendingResolutionService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findAll', () => {
    it('should return paginated resolutions', async () => {
      const expected = { items: [mockResolution], total: 1 };
      mockResolutionService.findAll.mockResolvedValue(expected);

      const result = await controller.findAll();

      expect(result).toEqual(expected);
      expect(service.findAll).toHaveBeenCalledWith(undefined, undefined, undefined);
    });

    it('should pass query parameters', async () => {
      mockResolutionService.findAll.mockResolvedValue({ items: [], total: 0 });

      await controller.findAll(ResolutionStatus.PENDING, 10, 5);

      expect(service.findAll).toHaveBeenCalledWith(ResolutionStatus.PENDING, 10, 5);
    });
  });

  describe('findOne', () => {
    it('should return single resolution', async () => {
      mockResolutionService.findOne.mockResolvedValue(mockResolution);

      const result = await controller.findOne('test-uuid-1');

      expect(result).toEqual(mockResolution);
      expect(service.findOne).toHaveBeenCalledWith('test-uuid-1');
    });
  });

  describe('updateSuggestions', () => {
    it('should update suggestions', async () => {
      const suggestions = [
        { entity_id: 'ent-1', name: 'John', confidence: 0.8, reason: 'Match' },
      ];
      mockResolutionService.updateSuggestions.mockResolvedValue({
        id: 'test-uuid-1',
        status: ResolutionStatus.PENDING,
        suggestions_count: 1,
        auto_resolved: false,
      });

      const result = await controller.updateSuggestions('test-uuid-1', { suggestions });

      expect((result as any).suggestions_count).toBe(1);
      expect(service.updateSuggestions).toHaveBeenCalledWith('test-uuid-1', suggestions);
    });
  });

  describe('resolve', () => {
    it('should resolve to entity', async () => {
      mockResolutionService.resolve.mockResolvedValue({
        id: 'test-uuid-1',
        status: 'resolved',
        entity_id: 'entity-uuid',
      });

      const result = await controller.resolve('test-uuid-1', { entity_id: 'entity-uuid' });

      expect(result.status).toBe('resolved');
      expect(service.resolve).toHaveBeenCalledWith('test-uuid-1', 'entity-uuid');
    });
  });

  describe('ignore', () => {
    it('should ignore resolution', async () => {
      mockResolutionService.ignore.mockResolvedValue({
        id: 'test-uuid-1',
        status: 'ignored',
      });

      const result = await controller.ignore('test-uuid-1');

      expect(result.status).toBe('ignored');
      expect(service.ignore).toHaveBeenCalledWith('test-uuid-1');
    });
  });
});
