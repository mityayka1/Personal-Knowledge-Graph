import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import {
  EntityEvent,
  EventStatus,
  ExtractedEvent,
  ExtractedEventStatus,
  EntityFact,
  BriefItem,
  BriefState,
} from '@pkg/entities';
import { BriefService } from './brief.service';
import { BriefStateService } from './brief-state.service';

describe('BriefService', () => {
  let service: BriefService;
  let briefStateService: jest.Mocked<BriefStateService>;
  let entityEventRepo: { update: jest.Mock };
  let extractedEventRepo: { update: jest.Mock };
  let entityFactRepo: { update: jest.Mock };

  const createMockItem = (
    index: number,
    type: BriefItem['type'] = 'task',
    sourceType: BriefItem['sourceType'] = 'entity_event',
  ): BriefItem => ({
    type,
    title: `Task ${index}`,
    entityName: `Person ${index}`,
    sourceType,
    sourceId: `source-uuid-${index}`,
    details: `Details for task ${index}`,
    entityId: `entity-uuid-${index}`,
  });

  const createMockState = (
    items: BriefItem[],
    expandedIndex: number | null = null,
  ): BriefState => ({
    id: 'b_test123456ab',
    chatId: '123456',
    messageId: 789,
    items,
    expandedIndex,
    createdAt: Date.now(),
  });

  beforeEach(async () => {
    briefStateService = {
      get: jest.fn(),
      expand: jest.fn(),
      collapse: jest.fn(),
      getItem: jest.fn(),
      removeItem: jest.fn(),
      create: jest.fn(),
      updateMessageId: jest.fn(),
      isEmpty: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<BriefStateService>;

    entityEventRepo = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    extractedEventRepo = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    entityFactRepo = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BriefService,
        {
          provide: BriefStateService,
          useValue: briefStateService,
        },
        {
          provide: getRepositoryToken(EntityEvent),
          useValue: entityEventRepo,
        },
        {
          provide: getRepositoryToken(ExtractedEvent),
          useValue: extractedEventRepo,
        },
        {
          provide: getRepositoryToken(EntityFact),
          useValue: entityFactRepo,
        },
      ],
    }).compile();

    service = module.get<BriefService>(BriefService);
  });

  describe('getBrief', () => {
    it('should return brief state', async () => {
      const state = createMockState([createMockItem(1)]);
      briefStateService.get.mockResolvedValue(state);

      const result = await service.getBrief('b_test123456ab');

      expect(result).toEqual(state);
      expect(briefStateService.get).toHaveBeenCalledWith('b_test123456ab');
    });

    it('should throw NotFoundException if brief not found', async () => {
      briefStateService.get.mockResolvedValue(null);

      await expect(service.getBrief('b_nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('expand', () => {
    it('should expand item and return updated state', async () => {
      const state = createMockState([createMockItem(1), createMockItem(2)], 1);
      briefStateService.expand.mockResolvedValue(state);

      const result = await service.expand('b_test123456ab', 1);

      expect(result).toEqual(state);
      expect(result.expandedIndex).toBe(1);
      expect(briefStateService.expand).toHaveBeenCalledWith('b_test123456ab', 1);
    });

    it('should throw NotFoundException if brief not found', async () => {
      briefStateService.expand.mockResolvedValue(null);

      await expect(service.expand('b_nonexistent', 0)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('collapse', () => {
    it('should collapse all items and return updated state', async () => {
      const state = createMockState([createMockItem(1), createMockItem(2)], null);
      briefStateService.collapse.mockResolvedValue(state);

      const result = await service.collapse('b_test123456ab');

      expect(result).toEqual(state);
      expect(result.expandedIndex).toBeNull();
      expect(briefStateService.collapse).toHaveBeenCalledWith('b_test123456ab');
    });

    it('should throw NotFoundException if brief not found', async () => {
      briefStateService.collapse.mockResolvedValue(null);

      await expect(service.collapse('b_nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('markDone', () => {
    describe('with entity_event sourceType', () => {
      it('should update EntityEvent status to COMPLETED', async () => {
        const item = createMockItem(1, 'task', 'entity_event');
        const updatedState = createMockState([createMockItem(2)]);

        briefStateService.getItem.mockResolvedValue(item);
        briefStateService.removeItem.mockResolvedValue(updatedState);

        const result = await service.markDone('b_test123456ab', 0);

        expect(result.state).toEqual(updatedState);
        expect(result.allDone).toBe(false);
        expect(entityEventRepo.update).toHaveBeenCalledWith(item.sourceId, {
          status: EventStatus.COMPLETED,
        });
        expect(briefStateService.removeItem).toHaveBeenCalledWith(
          'b_test123456ab',
          0,
        );
      });
    });

    describe('with extracted_event sourceType', () => {
      it('should update ExtractedEvent status to CONFIRMED', async () => {
        const item = createMockItem(1, 'task', 'extracted_event');
        const updatedState = createMockState([createMockItem(2)]);

        briefStateService.getItem.mockResolvedValue(item);
        briefStateService.removeItem.mockResolvedValue(updatedState);

        await service.markDone('b_test123456ab', 0);

        expect(extractedEventRepo.update).toHaveBeenCalledWith(item.sourceId, {
          status: ExtractedEventStatus.CONFIRMED,
          userResponseAt: expect.any(Date),
        });
      });
    });

    describe('with entity_fact sourceType', () => {
      it('should set validUntil to current date', async () => {
        const item = createMockItem(1, 'task', 'entity_fact');
        const updatedState = createMockState([createMockItem(2)]);

        briefStateService.getItem.mockResolvedValue(item);
        briefStateService.removeItem.mockResolvedValue(updatedState);

        await service.markDone('b_test123456ab', 0);

        expect(entityFactRepo.update).toHaveBeenCalledWith(item.sourceId, {
          validUntil: expect.any(Date),
        });
      });
    });

    describe('with entity sourceType', () => {
      it('should skip status update', async () => {
        const item = createMockItem(1, 'birthday', 'entity');
        const updatedState = createMockState([createMockItem(2)]);

        briefStateService.getItem.mockResolvedValue(item);
        briefStateService.removeItem.mockResolvedValue(updatedState);

        await service.markDone('b_test123456ab', 0);

        expect(entityEventRepo.update).not.toHaveBeenCalled();
        expect(extractedEventRepo.update).not.toHaveBeenCalled();
        expect(entityFactRepo.update).not.toHaveBeenCalled();
      });
    });

    it('should return allDone=true when all items are done', async () => {
      const item = createMockItem(1);
      const emptyState = createMockState([]);

      briefStateService.getItem.mockResolvedValue(item);
      briefStateService.removeItem.mockResolvedValue(emptyState);

      const result = await service.markDone('b_test123456ab', 0);

      expect(result.allDone).toBe(true);
      expect(result.state.items.length).toBe(0);
    });

    it('should throw NotFoundException if item not found', async () => {
      briefStateService.getItem.mockResolvedValue(null);

      await expect(service.markDone('b_test123456ab', 0)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException if brief not found after remove', async () => {
      briefStateService.getItem.mockResolvedValue(createMockItem(1));
      briefStateService.removeItem.mockResolvedValue(null);

      await expect(service.markDone('b_test123456ab', 0)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('markDismissed', () => {
    describe('with entity_event sourceType', () => {
      it('should update EntityEvent status to DISMISSED', async () => {
        const item = createMockItem(1, 'task', 'entity_event');
        const updatedState = createMockState([createMockItem(2)]);

        briefStateService.getItem.mockResolvedValue(item);
        briefStateService.removeItem.mockResolvedValue(updatedState);

        const result = await service.markDismissed('b_test123456ab', 0);

        expect(result.state).toEqual(updatedState);
        expect(result.allDone).toBe(false);
        expect(entityEventRepo.update).toHaveBeenCalledWith(item.sourceId, {
          status: EventStatus.DISMISSED,
        });
      });
    });

    describe('with extracted_event sourceType', () => {
      it('should update ExtractedEvent status to REJECTED', async () => {
        const item = createMockItem(1, 'task', 'extracted_event');
        const updatedState = createMockState([createMockItem(2)]);

        briefStateService.getItem.mockResolvedValue(item);
        briefStateService.removeItem.mockResolvedValue(updatedState);

        await service.markDismissed('b_test123456ab', 0);

        expect(extractedEventRepo.update).toHaveBeenCalledWith(item.sourceId, {
          status: ExtractedEventStatus.REJECTED,
          userResponseAt: expect.any(Date),
        });
      });
    });

    describe('with entity_fact sourceType', () => {
      it('should set validUntil to current date', async () => {
        const item = createMockItem(1, 'task', 'entity_fact');
        const updatedState = createMockState([createMockItem(2)]);

        briefStateService.getItem.mockResolvedValue(item);
        briefStateService.removeItem.mockResolvedValue(updatedState);

        await service.markDismissed('b_test123456ab', 0);

        expect(entityFactRepo.update).toHaveBeenCalledWith(item.sourceId, {
          validUntil: expect.any(Date),
        });
      });
    });

    describe('with entity sourceType', () => {
      it('should skip status update', async () => {
        const item = createMockItem(1, 'birthday', 'entity');
        const updatedState = createMockState([createMockItem(2)]);

        briefStateService.getItem.mockResolvedValue(item);
        briefStateService.removeItem.mockResolvedValue(updatedState);

        await service.markDismissed('b_test123456ab', 0);

        expect(entityEventRepo.update).not.toHaveBeenCalled();
        expect(extractedEventRepo.update).not.toHaveBeenCalled();
        expect(entityFactRepo.update).not.toHaveBeenCalled();
      });
    });

    it('should return allDone=true when all items are processed', async () => {
      const item = createMockItem(1);
      const emptyState = createMockState([]);

      briefStateService.getItem.mockResolvedValue(item);
      briefStateService.removeItem.mockResolvedValue(emptyState);

      const result = await service.markDismissed('b_test123456ab', 0);

      expect(result.allDone).toBe(true);
    });

    it('should throw NotFoundException if item not found', async () => {
      briefStateService.getItem.mockResolvedValue(null);

      await expect(service.markDismissed('b_test123456ab', 0)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException if brief not found after remove', async () => {
      briefStateService.getItem.mockResolvedValue(createMockItem(1));
      briefStateService.removeItem.mockResolvedValue(null);

      await expect(service.markDismissed('b_test123456ab', 0)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getItem', () => {
    it('should return item', async () => {
      const item = createMockItem(1);
      briefStateService.getItem.mockResolvedValue(item);

      const result = await service.getItem('b_test123456ab', 0);

      expect(result).toEqual(item);
      expect(briefStateService.getItem).toHaveBeenCalledWith('b_test123456ab', 0);
    });

    it('should throw NotFoundException if item not found', async () => {
      briefStateService.getItem.mockResolvedValue(null);

      await expect(service.getItem('b_test123456ab', 0)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateSourceStatus edge cases', () => {
    it('should handle unknown sourceType gracefully', async () => {
      const item = {
        ...createMockItem(1),
        sourceType: 'unknown_type' as BriefItem['sourceType'],
      };
      const updatedState = createMockState([]);

      briefStateService.getItem.mockResolvedValue(item);
      briefStateService.removeItem.mockResolvedValue(updatedState);

      // Should not throw
      const result = await service.markDone('b_test123456ab', 0);

      expect(result.state).toEqual(updatedState);
      expect(entityEventRepo.update).not.toHaveBeenCalled();
      expect(extractedEventRepo.update).not.toHaveBeenCalled();
      expect(entityFactRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('repository errors', () => {
    it('should propagate error when entityEventRepo.update fails', async () => {
      const item = createMockItem(1, 'task', 'entity_event');
      briefStateService.getItem.mockResolvedValue(item);
      entityEventRepo.update.mockRejectedValue(
        new Error('Database connection lost'),
      );

      await expect(service.markDone('b_test123456ab', 0)).rejects.toThrow(
        'Database connection lost',
      );
    });

    it('should propagate error when extractedEventRepo.update fails', async () => {
      const item = createMockItem(1, 'task', 'extracted_event');
      briefStateService.getItem.mockResolvedValue(item);
      extractedEventRepo.update.mockRejectedValue(new Error('Database timeout'));

      await expect(service.markDone('b_test123456ab', 0)).rejects.toThrow(
        'Database timeout',
      );
    });

    it('should propagate error when entityFactRepo.update fails', async () => {
      const item = createMockItem(1, 'birthday', 'entity_fact');
      briefStateService.getItem.mockResolvedValue(item);
      entityFactRepo.update.mockRejectedValue(new Error('Connection refused'));

      await expect(service.markDone('b_test123456ab', 0)).rejects.toThrow(
        'Connection refused',
      );
    });
  });

  describe('different item types', () => {
    it('should handle overdue item type with entity_event source', async () => {
      const item = createMockItem(1, 'overdue', 'entity_event');
      const updatedState = createMockState([]);

      briefStateService.getItem.mockResolvedValue(item);
      briefStateService.removeItem.mockResolvedValue(updatedState);

      const result = await service.markDone('b_test123456ab', 0);

      expect(result.state).toEqual(updatedState);
      expect(entityEventRepo.update).toHaveBeenCalledWith(item.sourceId, {
        status: EventStatus.COMPLETED,
      });
    });

    it('should handle meeting item type with entity_event source', async () => {
      const item = createMockItem(1, 'meeting', 'entity_event');
      const updatedState = createMockState([]);

      briefStateService.getItem.mockResolvedValue(item);
      briefStateService.removeItem.mockResolvedValue(updatedState);

      const result = await service.markDone('b_test123456ab', 0);

      expect(result.state).toEqual(updatedState);
      expect(entityEventRepo.update).toHaveBeenCalledWith(item.sourceId, {
        status: EventStatus.COMPLETED,
      });
    });

    it('should handle followup item type with extracted_event source', async () => {
      const item = createMockItem(1, 'followup', 'extracted_event');
      const updatedState = createMockState([]);

      briefStateService.getItem.mockResolvedValue(item);
      briefStateService.removeItem.mockResolvedValue(updatedState);

      const result = await service.markDone('b_test123456ab', 0);

      expect(result.state).toEqual(updatedState);
      expect(extractedEventRepo.update).toHaveBeenCalledWith(item.sourceId, {
        status: ExtractedEventStatus.CONFIRMED,
        userResponseAt: expect.any(Date),
      });
    });

    it('should handle birthday item type with entity source', async () => {
      const item = createMockItem(1, 'birthday', 'entity');
      const updatedState = createMockState([]);

      briefStateService.getItem.mockResolvedValue(item);
      briefStateService.removeItem.mockResolvedValue(updatedState);

      const result = await service.markDone('b_test123456ab', 0);

      expect(result.state).toEqual(updatedState);
      // Entity source should not update any repository
      expect(entityEventRepo.update).not.toHaveBeenCalled();
      expect(extractedEventRepo.update).not.toHaveBeenCalled();
      expect(entityFactRepo.update).not.toHaveBeenCalled();
    });

    it('should dismiss overdue item correctly', async () => {
      const item = createMockItem(1, 'overdue', 'entity_event');
      const updatedState = createMockState([]);

      briefStateService.getItem.mockResolvedValue(item);
      briefStateService.removeItem.mockResolvedValue(updatedState);

      const result = await service.markDismissed('b_test123456ab', 0);

      expect(result.state).toEqual(updatedState);
      expect(entityEventRepo.update).toHaveBeenCalledWith(item.sourceId, {
        status: EventStatus.DISMISSED,
      });
    });
  });
});
