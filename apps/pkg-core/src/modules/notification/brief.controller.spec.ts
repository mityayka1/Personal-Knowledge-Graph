import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { BriefItem, BriefState } from '@pkg/entities';
import { BriefController } from './brief.controller';
import { BriefService } from './brief.service';
import { BriefStateService } from './brief-state.service';

describe('BriefController', () => {
  let controller: BriefController;
  let briefService: jest.Mocked<BriefService>;
  let briefStateService: jest.Mocked<BriefStateService>;

  const createMockItem = (index: number, type: BriefItem['type'] = 'task'): BriefItem => ({
    type,
    title: `Task ${index}`,
    entityName: `Person ${index}`,
    sourceType: 'entity_event',
    sourceId: `event-uuid-${index}`,
    details: `Details for task ${index}`,
    entityId: `entity-uuid-${index}`,
  });

  const createMockState = (items: BriefItem[], expandedIndex: number | null = null): BriefState => ({
    id: 'b_test123456ab',
    chatId: '123456',
    messageId: 789,
    items,
    expandedIndex,
    createdAt: Date.now(),
  });

  beforeEach(async () => {
    briefService = {
      getBrief: jest.fn(),
      expand: jest.fn(),
      collapse: jest.fn(),
      markDone: jest.fn(),
      markDismissed: jest.fn(),
      getItem: jest.fn(),
    } as unknown as jest.Mocked<BriefService>;

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

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BriefController],
      providers: [
        {
          provide: BriefService,
          useValue: briefService,
        },
        {
          provide: BriefStateService,
          useValue: briefStateService,
        },
      ],
    }).compile();

    controller = module.get<BriefController>(BriefController);
  });

  describe('getBrief', () => {
    it('should return brief state', async () => {
      const state = createMockState([createMockItem(1), createMockItem(2)]);
      briefService.getBrief.mockResolvedValue(state);

      const result = await controller.getBrief('b_test123456ab');

      expect(result.success).toBe(true);
      expect(result.state).toEqual(state);
    });

    it('should throw NotFoundException if brief not found', async () => {
      briefService.getBrief.mockRejectedValue(new NotFoundException('Brief not found or expired'));

      await expect(controller.getBrief('b_nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('expand', () => {
    it('should expand item and return updated state', async () => {
      const state = createMockState([createMockItem(1), createMockItem(2)], 1);
      briefService.expand.mockResolvedValue(state);

      const result = await controller.expand('b_test123456ab', 1);

      expect(result.success).toBe(true);
      expect(result.state?.expandedIndex).toBe(1);
      expect(briefService.expand).toHaveBeenCalledWith('b_test123456ab', 1);
    });

    it('should throw NotFoundException if brief not found', async () => {
      briefService.expand.mockRejectedValue(new NotFoundException('Brief not found or expired'));

      await expect(controller.expand('b_nonexistent', 0)).rejects.toThrow(NotFoundException);
    });
  });

  describe('collapse', () => {
    it('should collapse all items and return updated state', async () => {
      const state = createMockState([createMockItem(1), createMockItem(2)], null);
      briefService.collapse.mockResolvedValue(state);

      const result = await controller.collapse('b_test123456ab');

      expect(result.success).toBe(true);
      expect(result.state?.expandedIndex).toBeNull();
      expect(briefService.collapse).toHaveBeenCalledWith('b_test123456ab');
    });

    it('should throw NotFoundException if brief not found', async () => {
      briefService.collapse.mockRejectedValue(new NotFoundException('Brief not found or expired'));

      await expect(controller.collapse('b_nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('markDone', () => {
    it('should mark item as completed and return updated state', async () => {
      const updatedState = createMockState([createMockItem(2)]);

      briefService.markDone.mockResolvedValue({ state: updatedState, allDone: false });

      const result = await controller.markDone('b_test123456ab', 0);

      expect(result.success).toBe(true);
      expect(result.state).toEqual(updatedState);
      expect(briefService.markDone).toHaveBeenCalledWith('b_test123456ab', 0);
    });

    it('should return congratulation message when all items done', async () => {
      const emptyState = createMockState([]);

      briefService.markDone.mockResolvedValue({ state: emptyState, allDone: true });

      const result = await controller.markDone('b_test123456ab', 0);

      expect(result.message).toContain('Все задачи выполнены');
    });

    it('should throw NotFoundException if item not found', async () => {
      briefService.markDone.mockRejectedValue(new NotFoundException('Item not found'));

      await expect(controller.markDone('b_test123456ab', 0)).rejects.toThrow(NotFoundException);
    });
  });

  describe('markDismissed', () => {
    it('should mark item as dismissed and return updated state', async () => {
      const updatedState = createMockState([createMockItem(2)]);

      briefService.markDismissed.mockResolvedValue({ state: updatedState, allDone: false });

      const result = await controller.markDismissed('b_test123456ab', 0);

      expect(result.success).toBe(true);
      expect(result.state).toEqual(updatedState);
    });

    it('should return completion message when all items processed', async () => {
      const emptyState = createMockState([]);

      briefService.markDismissed.mockResolvedValue({ state: emptyState, allDone: true });

      const result = await controller.markDismissed('b_test123456ab', 0);

      expect(result.message).toContain('Все задачи обработаны');
    });

    it('should throw NotFoundException if item not found', async () => {
      briefService.markDismissed.mockRejectedValue(new NotFoundException('Item not found'));

      await expect(controller.markDismissed('b_test123456ab', 0)).rejects.toThrow(NotFoundException);
    });
  });

  describe('triggerAction', () => {
    it('should return action info for write action', async () => {
      const item = createMockItem(1);
      briefService.getItem.mockResolvedValue(item);
      briefStateService.get.mockResolvedValue(createMockState([item]));

      const result = await controller.triggerAction('b_test123456ab', 0, { actionType: 'write' });

      expect(result.success).toBe(true);
      expect(result.message).toContain('write');
      expect(result.message).toContain(item.entityName);
    });

    it('should return action info for remind action', async () => {
      const item = createMockItem(1);
      briefService.getItem.mockResolvedValue(item);
      briefStateService.get.mockResolvedValue(createMockState([item]));

      const result = await controller.triggerAction('b_test123456ab', 0, { actionType: 'remind' });

      expect(result.success).toBe(true);
      expect(result.message).toContain('remind');
      expect(result.message).toContain(item.entityName);
    });

    it('should return action info for prepare action', async () => {
      const item = createMockItem(1);
      briefService.getItem.mockResolvedValue(item);
      briefStateService.get.mockResolvedValue(createMockState([item]));

      const result = await controller.triggerAction('b_test123456ab', 0, { actionType: 'prepare' });

      expect(result.success).toBe(true);
      expect(result.message).toContain('prepare');
      expect(result.message).toContain(item.entityName);
    });

    it('should return undefined state if brief not found', async () => {
      const item = createMockItem(1);
      briefService.getItem.mockResolvedValue(item);
      briefStateService.get.mockResolvedValue(null);

      const result = await controller.triggerAction('b_test123456ab', 0, { actionType: 'write' });

      expect(result.success).toBe(true);
      expect(result.state).toBeUndefined();
    });

    it('should throw BadRequestException if actionType missing', async () => {
      briefService.getItem.mockResolvedValue(createMockItem(1));

      await expect(controller.triggerAction('b_test123456ab', 0, {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException if item not found', async () => {
      briefService.getItem.mockRejectedValue(new NotFoundException('Item not found'));

      await expect(
        controller.triggerAction('b_test123456ab', 0, { actionType: 'write' }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
