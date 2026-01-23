import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { EntityEvent, EventStatus } from '@pkg/entities';
import { BriefController } from './brief.controller';
import { BriefStateService, BriefItem, BriefState } from './brief-state.service';

describe('BriefController', () => {
  let controller: BriefController;
  let briefStateService: jest.Mocked<BriefStateService>;
  let entityEventRepo: { update: jest.Mock };

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

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BriefController],
      providers: [
        {
          provide: BriefStateService,
          useValue: briefStateService,
        },
        {
          provide: getRepositoryToken(EntityEvent),
          useValue: entityEventRepo,
        },
      ],
    }).compile();

    controller = module.get<BriefController>(BriefController);
  });

  describe('getBrief', () => {
    it('should return brief state with formatted message', async () => {
      const state = createMockState([createMockItem(1), createMockItem(2)]);
      briefStateService.get.mockResolvedValue(state);

      const result = await controller.getBrief('b_test123456ab');

      expect(result.success).toBe(true);
      expect(result.state).toEqual(state);
      expect(result.formattedMessage).toContain('Доброе утро');
      expect(result.buttons).toBeDefined();
    });

    it('should throw NotFoundException if brief not found', async () => {
      briefStateService.get.mockResolvedValue(null);

      await expect(controller.getBrief('b_nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('expand', () => {
    it('should expand item and return updated state', async () => {
      const state = createMockState([createMockItem(1), createMockItem(2)], 1);
      briefStateService.expand.mockResolvedValue(state);

      const result = await controller.expand('b_test123456ab', 1);

      expect(result.success).toBe(true);
      expect(result.state?.expandedIndex).toBe(1);
      expect(briefStateService.expand).toHaveBeenCalledWith('b_test123456ab', 1);
    });

    it('should throw NotFoundException if brief not found', async () => {
      briefStateService.expand.mockResolvedValue(null);

      await expect(controller.expand('b_nonexistent', 0)).rejects.toThrow(NotFoundException);
    });
  });

  describe('collapse', () => {
    it('should collapse all items and return updated state', async () => {
      const state = createMockState([createMockItem(1), createMockItem(2)], null);
      briefStateService.collapse.mockResolvedValue(state);

      const result = await controller.collapse('b_test123456ab');

      expect(result.success).toBe(true);
      expect(result.state?.expandedIndex).toBeNull();
      expect(briefStateService.collapse).toHaveBeenCalledWith('b_test123456ab');
    });

    it('should throw NotFoundException if brief not found', async () => {
      briefStateService.collapse.mockResolvedValue(null);

      await expect(controller.collapse('b_nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('markDone', () => {
    it('should mark item as completed and remove from brief', async () => {
      const item = createMockItem(1);
      const updatedState = createMockState([createMockItem(2)]);

      briefStateService.getItem.mockResolvedValue(item);
      briefStateService.removeItem.mockResolvedValue(updatedState);

      const result = await controller.markDone('b_test123456ab', 0);

      expect(result.success).toBe(true);
      expect(entityEventRepo.update).toHaveBeenCalledWith(item.sourceId, {
        status: EventStatus.COMPLETED,
      });
      expect(briefStateService.removeItem).toHaveBeenCalledWith('b_test123456ab', 0);
    });

    it('should return congratulation message when all items done', async () => {
      const item = createMockItem(1);
      const emptyState = createMockState([]);

      briefStateService.getItem.mockResolvedValue(item);
      briefStateService.removeItem.mockResolvedValue(emptyState);

      const result = await controller.markDone('b_test123456ab', 0);

      expect(result.message).toContain('Все задачи выполнены');
      expect(result.buttons).toEqual([]);
    });

    it('should throw NotFoundException if item not found', async () => {
      briefStateService.getItem.mockResolvedValue(null);

      await expect(controller.markDone('b_test123456ab', 0)).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if brief not found after remove', async () => {
      briefStateService.getItem.mockResolvedValue(createMockItem(1));
      briefStateService.removeItem.mockResolvedValue(null);

      await expect(controller.markDone('b_test123456ab', 0)).rejects.toThrow(NotFoundException);
    });
  });

  describe('markDismissed', () => {
    it('should mark item as dismissed and remove from brief', async () => {
      const item = createMockItem(1);
      const updatedState = createMockState([createMockItem(2)]);

      briefStateService.getItem.mockResolvedValue(item);
      briefStateService.removeItem.mockResolvedValue(updatedState);

      const result = await controller.markDismissed('b_test123456ab', 0);

      expect(result.success).toBe(true);
      expect(entityEventRepo.update).toHaveBeenCalledWith(item.sourceId, {
        status: EventStatus.DISMISSED,
      });
    });

    it('should return completion message when all items processed', async () => {
      const item = createMockItem(1);
      const emptyState = createMockState([]);

      briefStateService.getItem.mockResolvedValue(item);
      briefStateService.removeItem.mockResolvedValue(emptyState);

      const result = await controller.markDismissed('b_test123456ab', 0);

      expect(result.message).toContain('Все задачи обработаны');
    });

    it('should throw NotFoundException if item not found', async () => {
      briefStateService.getItem.mockResolvedValue(null);

      await expect(controller.markDismissed('b_test123456ab', 0)).rejects.toThrow(NotFoundException);
    });
  });

  describe('triggerAction', () => {
    it('should return action info for write action', async () => {
      const item = createMockItem(1);
      briefStateService.getItem.mockResolvedValue(item);
      briefStateService.get.mockResolvedValue(createMockState([item]));

      const result = await controller.triggerAction('b_test123456ab', 0, { actionType: 'write' });

      expect(result.success).toBe(true);
      expect(result.message).toContain('write');
    });

    it('should throw BadRequestException if actionType missing', async () => {
      briefStateService.getItem.mockResolvedValue(createMockItem(1));

      await expect(controller.triggerAction('b_test123456ab', 0, {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException if item not found', async () => {
      briefStateService.getItem.mockResolvedValue(null);

      await expect(
        controller.triggerAction('b_test123456ab', 0, { actionType: 'write' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('formatBriefMessage', () => {
    it('should format collapsed state correctly', () => {
      const state = createMockState([
        { ...createMockItem(1), type: 'meeting', title: 'Созвон с Петром' },
        { ...createMockItem(2), type: 'task', title: 'Подготовить отчёт' },
      ]);

      const message = controller.formatBriefMessage(state);

      expect(message).toContain('Доброе утро');
      expect(message).toContain('1. 📅 Созвон с Петром');
      expect(message).toContain('2. 📋 Подготовить отчёт');
    });

    it('should format expanded state with details', () => {
      const state = createMockState(
        [
          {
            ...createMockItem(1),
            type: 'task',
            title: 'Спросить у Маши про документы',
            entityName: 'Мария Иванова',
            details: 'Задача из сообщения от 15.01',
            sourceMessageLink: 'https://t.me/c/123/456',
          },
        ],
        0,
      );

      const message = controller.formatBriefMessage(state);

      expect(message).toContain('Мария Иванова');
      expect(message).toContain('Задача из сообщения');
      expect(message).toContain('Перейти к сообщению');
      expect(message).toContain('━━━');
    });

    it('should show empty message when no items', () => {
      const state = createMockState([]);

      const message = controller.formatBriefMessage(state);

      expect(message).toContain('Нет активных задач');
    });

    it('should escape HTML in content', () => {
      const state = createMockState([
        { ...createMockItem(1), title: '<script>alert("xss")</script>' },
      ]);

      const message = controller.formatBriefMessage(state);

      expect(message).not.toContain('<script>');
      expect(message).toContain('&lt;script&gt;');
    });
  });

  describe('getBriefButtons', () => {
    it('should return number buttons in collapsed state', () => {
      const state = createMockState([createMockItem(1), createMockItem(2), createMockItem(3)]);

      const buttons = controller.getBriefButtons(state);

      expect(buttons).toHaveLength(1);
      expect(buttons[0]).toHaveLength(3);
      expect(buttons[0][0].text).toBe('1');
      expect(buttons[0][0].callback_data).toBe('br_e:b_test123456ab:0');
    });

    it('should return action buttons in expanded state', () => {
      const state = createMockState([{ ...createMockItem(1), type: 'task' }], 0);

      const buttons = controller.getBriefButtons(state);

      // Should have: number row, action row, collapse row
      expect(buttons.length).toBeGreaterThanOrEqual(2);

      // Check number row has highlighted item
      expect(buttons[0][0].text).toBe('1 ▼');

      // Check action buttons
      const actionButtons = buttons[1].map((b) => b.text);
      expect(actionButtons).toContain('✅ Готово');
      expect(actionButtons).toContain('➖ Не актуально');

      // Check collapse button
      const lastRow = buttons[buttons.length - 1];
      expect(lastRow[0].text).toBe('🔙 Свернуть');
    });

    it('should return meeting-specific buttons', () => {
      const state = createMockState([{ ...createMockItem(1), type: 'meeting' }], 0);

      const buttons = controller.getBriefButtons(state);
      const actionButtons = buttons[1].map((b) => b.text);

      expect(actionButtons).toContain('📋 Brief');
      expect(actionButtons).toContain('💬 Написать');
    });

    it('should return followup-specific buttons', () => {
      const state = createMockState([{ ...createMockItem(1), type: 'followup' }], 0);

      const buttons = controller.getBriefButtons(state);
      const actionButtons = buttons[1].map((b) => b.text);

      expect(actionButtons).toContain('💬 Напомнить');
    });

    it('should return birthday-specific buttons', () => {
      const state = createMockState([{ ...createMockItem(1), type: 'birthday' }], 0);

      const buttons = controller.getBriefButtons(state);
      const actionButtons = buttons[1].map((b) => b.text);

      expect(actionButtons).toContain('💬 Поздравить');
    });

    it('should return empty buttons when no items', () => {
      const state = createMockState([]);

      const buttons = controller.getBriefButtons(state);

      expect(buttons).toEqual([]);
    });
  });
});
