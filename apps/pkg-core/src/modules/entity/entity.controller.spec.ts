import { Test, TestingModule } from '@nestjs/testing';
import { EntityController } from './entity.controller';
import { EntityService } from './entity.service';
import { EntityType } from '@pkg/entities';

describe('EntityController', () => {
  let controller: EntityController;
  let service: EntityService;

  const mockEntity = {
    id: 'test-uuid-1',
    type: EntityType.PERSON,
    name: 'John Doe',
    organizationId: null,
    notes: null,
    identifiers: [],
    facts: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockEntityService = {
    findAll: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    merge: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EntityController],
      providers: [
        {
          provide: EntityService,
          useValue: mockEntityService,
        },
      ],
    }).compile();

    controller = module.get<EntityController>(EntityController);
    service = module.get<EntityService>(EntityService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findAll', () => {
    it('should return paginated entities', async () => {
      const expected = { items: [mockEntity], total: 1, limit: 50, offset: 0 };
      mockEntityService.findAll.mockResolvedValue(expected);

      const result = await controller.findAll();

      expect(result).toEqual(expected);
      expect(service.findAll).toHaveBeenCalledWith({
        type: undefined,
        search: undefined,
        limit: undefined,
        offset: undefined,
      });
    });

    it('should pass query parameters to service', async () => {
      mockEntityService.findAll.mockResolvedValue({ items: [], total: 0, limit: 10, offset: 5 });

      await controller.findAll(EntityType.PERSON, 'John', 10, 5);

      expect(service.findAll).toHaveBeenCalledWith({
        type: EntityType.PERSON,
        search: 'John',
        limit: 10,
        offset: 5,
      });
    });
  });

  describe('findOne', () => {
    it('should return single entity', async () => {
      mockEntityService.findOne.mockResolvedValue(mockEntity);

      const result = await controller.findOne('test-uuid-1');

      expect(result).toEqual(mockEntity);
      expect(service.findOne).toHaveBeenCalledWith('test-uuid-1');
    });
  });

  describe('create', () => {
    it('should create and return entity', async () => {
      const dto = { type: EntityType.PERSON, name: 'Jane Doe' };
      mockEntityService.create.mockResolvedValue({ ...mockEntity, name: 'Jane Doe' });

      const result = await controller.create(dto);

      expect(result.name).toBe('Jane Doe');
      expect(service.create).toHaveBeenCalledWith(dto);
    });
  });

  describe('update', () => {
    it('should update and return entity', async () => {
      const dto = { name: 'Updated Name' };
      mockEntityService.update.mockResolvedValue({ ...mockEntity, name: 'Updated Name' });

      const result = await controller.update('test-uuid-1', dto);

      expect(result.name).toBe('Updated Name');
      expect(service.update).toHaveBeenCalledWith('test-uuid-1', dto);
    });
  });

  describe('remove', () => {
    it('should remove entity', async () => {
      mockEntityService.remove.mockResolvedValue({ deleted: true, id: 'test-uuid-1' });

      const result = await controller.remove('test-uuid-1');

      expect(result).toEqual({ deleted: true, id: 'test-uuid-1' });
      expect(service.remove).toHaveBeenCalledWith('test-uuid-1');
    });
  });

  describe('merge', () => {
    it('should merge entities', async () => {
      const mergeResult = {
        mergedEntityId: 'target-uuid',
        sourceEntityDeleted: true,
        identifiersMoved: 2,
        factsMoved: 3,
      };
      mockEntityService.merge.mockResolvedValue(mergeResult);

      const result = await controller.merge('source-uuid', 'target-uuid');

      expect(result).toEqual(mergeResult);
      expect(service.merge).toHaveBeenCalledWith('source-uuid', 'target-uuid');
    });
  });
});
