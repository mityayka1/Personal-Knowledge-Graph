import { Test, TestingModule } from '@nestjs/testing';
import { BriefFormatterService } from './brief-formatter.service';
import { BriefState, BriefItem } from '@pkg/entities';

describe('BriefFormatterService', () => {
  let service: BriefFormatterService;

  const createMockItem = (index: number, type: BriefItem['type'] = 'task'): BriefItem => ({
    type,
    title: `Task ${index}`,
    entityName: `Person ${index}`,
    sourceType: 'entity_event',
    sourceId: `event-uuid-${index}`,
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
    const module: TestingModule = await Test.createTestingModule({
      providers: [BriefFormatterService],
    }).compile();

    service = module.get<BriefFormatterService>(BriefFormatterService);
  });

  describe('formatMessage', () => {
    it('should format collapsed state correctly', () => {
      const state = createMockState([
        { ...createMockItem(1), type: 'meeting', title: 'Созвон с Петром' },
        { ...createMockItem(2), type: 'task', title: 'Подготовить отчёт' },
      ]);

      const message = service.formatMessage(state);

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

      const message = service.formatMessage(state);

      expect(message).toContain('Мария Иванова');
      expect(message).toContain('Задача из сообщения');
      expect(message).toContain('Перейти к сообщению');
      expect(message).toContain('━━━');
    });

    it('should show empty message when no items', () => {
      const state = createMockState([]);

      const message = service.formatMessage(state);

      expect(message).toContain('Нет активных задач');
    });

    it('should escape HTML in content', () => {
      const state = createMockState([
        { ...createMockItem(1), title: '<script>alert("xss")</script>' },
      ]);

      const message = service.formatMessage(state);

      expect(message).not.toContain('<script>');
      expect(message).toContain('&lt;script&gt;');
    });

    it('should display correct emoji for each item type', () => {
      const state = createMockState([
        { ...createMockItem(1), type: 'meeting', title: 'Meeting' },
        { ...createMockItem(2), type: 'task', title: 'Task' },
        { ...createMockItem(3), type: 'followup', title: 'Followup' },
        { ...createMockItem(4), type: 'overdue', title: 'Overdue' },
        { ...createMockItem(5), type: 'birthday', title: 'Birthday' },
      ]);

      const message = service.formatMessage(state);

      expect(message).toContain('📅 Meeting');
      expect(message).toContain('📋 Task');
      expect(message).toContain('👀 Followup');
      expect(message).toContain('⚠️ Overdue');
      expect(message).toContain('🎂 Birthday');
    });
  });

  describe('formatAllDoneMessage', () => {
    it('should return congratulation message', () => {
      const message = service.formatAllDoneMessage();

      expect(message).toContain('Все задачи выполнены');
      expect(message).toContain('🎉');
    });
  });

  describe('formatAllProcessedMessage', () => {
    it('should return processed message', () => {
      const message = service.formatAllProcessedMessage();

      expect(message).toContain('Все задачи обработаны');
      expect(message).toContain('✅');
    });
  });

  describe('getButtons', () => {
    it('should return number buttons in collapsed state', () => {
      const state = createMockState([
        createMockItem(1),
        createMockItem(2),
        createMockItem(3),
      ]);

      const buttons = service.getButtons(state);

      expect(buttons).toHaveLength(1);
      expect(buttons[0]).toHaveLength(3);
      expect(buttons[0][0].text).toBe('1');
      expect(buttons[0][0].callback_data).toBe('br_e:b_test123456ab:0');
    });

    it('should return action buttons in expanded state', () => {
      const state = createMockState([{ ...createMockItem(1), type: 'task' }], 0);

      const buttons = service.getButtons(state);

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

      const buttons = service.getButtons(state);
      const actionButtons = buttons[1].map((b) => b.text);

      expect(actionButtons).toContain('📋 Brief');
      expect(actionButtons).toContain('💬 Написать');
    });

    it('should return followup-specific buttons', () => {
      const state = createMockState([{ ...createMockItem(1), type: 'followup' }], 0);

      const buttons = service.getButtons(state);
      const actionButtons = buttons[1].map((b) => b.text);

      expect(actionButtons).toContain('💬 Напомнить');
    });

    it('should return birthday-specific buttons', () => {
      const state = createMockState([{ ...createMockItem(1), type: 'birthday' }], 0);

      const buttons = service.getButtons(state);
      const actionButtons = buttons[1].map((b) => b.text);

      expect(actionButtons).toContain('💬 Поздравить');
    });

    it('should return empty buttons when no items', () => {
      const state = createMockState([]);

      const buttons = service.getButtons(state);

      expect(buttons).toEqual([]);
    });

    it('should return overdue-specific buttons (same as task)', () => {
      const state = createMockState([{ ...createMockItem(1), type: 'overdue' }], 0);

      const buttons = service.getButtons(state);
      const actionButtons = buttons[1].map((b) => b.text);

      expect(actionButtons).toContain('✅ Готово');
      expect(actionButtons).toContain('➖ Не актуально');
      expect(actionButtons).toContain('💬 Написать');
    });
  });

  describe('URL sanitization', () => {
    it('should allow https:// URLs', () => {
      const state = createMockState(
        [
          {
            ...createMockItem(1),
            sourceMessageLink: 'https://t.me/c/123/456',
          },
        ],
        0,
      );

      const message = service.formatMessage(state);

      expect(message).toContain('href="https://t.me/c/123/456"');
    });

    it('should allow tg:// URLs', () => {
      const state = createMockState(
        [
          {
            ...createMockItem(1),
            sourceMessageLink: 'tg://resolve?domain=test',
          },
        ],
        0,
      );

      const message = service.formatMessage(state);

      expect(message).toContain('href="tg://resolve?domain=test"');
    });

    it('should block javascript: URLs (XSS prevention)', () => {
      const state = createMockState(
        [
          {
            ...createMockItem(1),
            sourceMessageLink: 'javascript:alert("xss")',
          },
        ],
        0,
      );

      const message = service.formatMessage(state);

      expect(message).not.toContain('javascript:');
      expect(message).not.toContain('href=');
    });

    it('should block http:// URLs (only https allowed)', () => {
      const state = createMockState(
        [
          {
            ...createMockItem(1),
            sourceMessageLink: 'http://insecure.com',
          },
        ],
        0,
      );

      const message = service.formatMessage(state);

      expect(message).not.toContain('http://insecure.com');
      expect(message).not.toContain('Перейти к сообщению');
    });

    it('should block data: URLs', () => {
      const state = createMockState(
        [
          {
            ...createMockItem(1),
            sourceMessageLink: 'data:text/html,<script>alert(1)</script>',
          },
        ],
        0,
      );

      const message = service.formatMessage(state);

      expect(message).not.toContain('data:');
    });

    it('should block file:// URLs', () => {
      const state = createMockState(
        [
          {
            ...createMockItem(1),
            sourceMessageLink: 'file:///etc/passwd',
          },
        ],
        0,
      );

      const message = service.formatMessage(state);

      expect(message).not.toContain('file://');
    });

    it('should escape quotes in valid URLs', () => {
      const state = createMockState(
        [
          {
            ...createMockItem(1),
            sourceMessageLink: 'https://t.me/c/123/456?a="test"',
          },
        ],
        0,
      );

      const message = service.formatMessage(state);

      expect(message).toContain('&quot;test&quot;');
      expect(message).not.toContain('="test"');
    });
  });
});
