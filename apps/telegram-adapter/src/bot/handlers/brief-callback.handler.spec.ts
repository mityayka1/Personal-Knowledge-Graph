import { Test, TestingModule } from '@nestjs/testing';
import { BriefCallbackHandler } from './brief-callback.handler';
import { PkgCoreApiService, BriefResponse } from '../../api/pkg-core-api.service';
import { BotService } from '../bot.service';
import { Context } from 'telegraf';

describe('BriefCallbackHandler', () => {
  let handler: BriefCallbackHandler;
  let pkgCoreApi: jest.Mocked<PkgCoreApiService>;

  const mockContext = (callbackData: string): Partial<Context> =>
    ({
      callbackQuery: {
        data: callbackData,
        id: 'query-123',
      },
      answerCbQuery: jest.fn().mockResolvedValue(true),
      editMessageText: jest.fn().mockResolvedValue({}),
      reply: jest.fn().mockResolvedValue({ message_id: 456 }),
    }) as unknown as Partial<Context>;

  const createMockBriefResponse = (overrides: Partial<BriefResponse> = {}): BriefResponse => ({
    success: true,
    state: {
      id: 'b_test123456ab',
      chatId: '123456',
      messageId: 789,
      items: [
        {
          type: 'task',
          title: 'Test task',
          entityName: 'John Doe',
          sourceType: 'entity_event',
          sourceId: 'event-uuid-1',
          details: 'Test details',
          entityId: 'entity-uuid-1',
        },
      ],
      expandedIndex: null,
      createdAt: Date.now(),
    },
    formattedMessage: '<b>Test message</b>',
    buttons: [[{ text: '1', callback_data: 'br_e:b_test123456ab:0' }]],
    ...overrides,
  });

  beforeEach(async () => {
    pkgCoreApi = {
      briefExpand: jest.fn(),
      briefCollapse: jest.fn(),
      briefMarkDone: jest.fn(),
      briefMarkDismissed: jest.fn(),
      briefAction: jest.fn(),
    } as unknown as jest.Mocked<PkgCoreApiService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BriefCallbackHandler,
        {
          provide: PkgCoreApiService,
          useValue: pkgCoreApi,
        },
        {
          provide: BotService,
          useValue: {},
        },
      ],
    }).compile();

    handler = module.get<BriefCallbackHandler>(BriefCallbackHandler);
  });

  describe('canHandle', () => {
    it('should return true for br_e callback', () => {
      expect(handler.canHandle('br_e:b_123:0')).toBe(true);
    });

    it('should return true for br_c callback', () => {
      expect(handler.canHandle('br_c:b_123')).toBe(true);
    });

    it('should return true for br_d callback', () => {
      expect(handler.canHandle('br_d:b_123:0')).toBe(true);
    });

    it('should return true for br_x callback', () => {
      expect(handler.canHandle('br_x:b_123:0')).toBe(true);
    });

    it('should return true for br_w callback', () => {
      expect(handler.canHandle('br_w:b_123:0')).toBe(true);
    });

    it('should return true for br_r callback', () => {
      expect(handler.canHandle('br_r:b_123:0')).toBe(true);
    });

    it('should return true for br_p callback', () => {
      expect(handler.canHandle('br_p:b_123:0')).toBe(true);
    });

    it('should return false for other callbacks', () => {
      expect(handler.canHandle('car_n:c_123')).toBe(false);
      expect(handler.canHandle('d_c:abc123')).toBe(false);
      expect(handler.canHandle('other:data')).toBe(false);
    });
  });

  describe('handle - expand', () => {
    it('should expand item and update message', async () => {
      const ctx = mockContext('br_e:b_test123456ab:0') as Context;
      pkgCoreApi.briefExpand.mockResolvedValue(createMockBriefResponse());

      await handler.handle(ctx);

      expect(pkgCoreApi.briefExpand).toHaveBeenCalledWith('b_test123456ab', 0);
      expect(ctx.editMessageText).toHaveBeenCalledWith(
        '<b>Test message</b>',
        expect.objectContaining({ parse_mode: 'HTML' }),
      );
      expect(ctx.answerCbQuery).toHaveBeenCalled();
    });

    it('should show error if expand fails', async () => {
      const ctx = mockContext('br_e:b_test123456ab:0') as Context;
      pkgCoreApi.briefExpand.mockResolvedValue({
        success: false,
        error: 'Brief not found',
      });

      await handler.handle(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Brief not found');
      expect(ctx.editMessageText).not.toHaveBeenCalled();
    });
  });

  describe('handle - collapse', () => {
    it('should collapse and update message', async () => {
      const ctx = mockContext('br_c:b_test123456ab') as Context;
      pkgCoreApi.briefCollapse.mockResolvedValue(createMockBriefResponse());

      await handler.handle(ctx);

      expect(pkgCoreApi.briefCollapse).toHaveBeenCalledWith('b_test123456ab');
      expect(ctx.editMessageText).toHaveBeenCalled();
    });
  });

  describe('handle - mark done', () => {
    it('should mark item as done and update message', async () => {
      const ctx = mockContext('br_d:b_test123456ab:0') as Context;
      pkgCoreApi.briefMarkDone.mockResolvedValue(createMockBriefResponse());

      await handler.handle(ctx);

      expect(pkgCoreApi.briefMarkDone).toHaveBeenCalledWith('b_test123456ab', 0);
      expect(ctx.answerCbQuery).toHaveBeenCalledWith('✅ Готово');
    });

    it('should show completion message when all done', async () => {
      const ctx = mockContext('br_d:b_test123456ab:0') as Context;
      pkgCoreApi.briefMarkDone.mockResolvedValue(
        createMockBriefResponse({
          message: 'Все задачи выполнены!',
          state: {
            id: 'b_test123456ab',
            chatId: '123456',
            messageId: 789,
            items: [],
            expandedIndex: null,
            createdAt: Date.now(),
          },
        }),
      );

      await handler.handle(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Все задачи выполнены!');
    });
  });

  describe('handle - mark dismissed', () => {
    it('should mark item as dismissed and update message', async () => {
      const ctx = mockContext('br_x:b_test123456ab:0') as Context;
      pkgCoreApi.briefMarkDismissed.mockResolvedValue(createMockBriefResponse());

      await handler.handle(ctx);

      expect(pkgCoreApi.briefMarkDismissed).toHaveBeenCalledWith('b_test123456ab', 0);
      expect(ctx.answerCbQuery).toHaveBeenCalledWith('➖ Не актуально');
    });
  });

  describe('handle - write action', () => {
    it('should trigger write action and send prompt', async () => {
      const ctx = mockContext('br_w:b_test123456ab:0') as Context;
      pkgCoreApi.briefAction.mockResolvedValue(createMockBriefResponse());

      await handler.handle(ctx);

      expect(pkgCoreApi.briefAction).toHaveBeenCalledWith('b_test123456ab', 0, 'write');
      expect(ctx.reply).toHaveBeenCalled();
    });

    it('should show error if item not found', async () => {
      const ctx = mockContext('br_w:b_test123456ab:5') as Context;
      pkgCoreApi.briefAction.mockResolvedValue(
        createMockBriefResponse({
          state: {
            id: 'b_test123456ab',
            chatId: '123456',
            messageId: 789,
            items: [], // No items
            expandedIndex: null,
            createdAt: Date.now(),
          },
        }),
      );

      await handler.handle(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Элемент не найден');
    });
  });

  describe('handle - remind action', () => {
    it('should trigger remind action and send prompt', async () => {
      const ctx = mockContext('br_r:b_test123456ab:0') as Context;
      pkgCoreApi.briefAction.mockResolvedValue(createMockBriefResponse());

      await handler.handle(ctx);

      expect(pkgCoreApi.briefAction).toHaveBeenCalledWith('b_test123456ab', 0, 'remind');
      expect(ctx.reply).toHaveBeenCalled();
    });
  });

  describe('handle - prepare action', () => {
    it('should trigger prepare action and send prompt', async () => {
      const ctx = mockContext('br_p:b_test123456ab:0') as Context;
      pkgCoreApi.briefAction.mockResolvedValue(createMockBriefResponse());

      await handler.handle(ctx);

      expect(pkgCoreApi.briefAction).toHaveBeenCalledWith('b_test123456ab', 0, 'prepare');
      expect(ctx.reply).toHaveBeenCalled();
    });
  });

  describe('handle - error cases', () => {
    it('should handle missing callbackQuery', async () => {
      const ctx = { callbackQuery: null } as unknown as Context;

      await handler.handle(ctx);
      // Should not throw
    });

    it('should handle invalid index', async () => {
      const ctx = mockContext('br_e:b_test123456ab') as Context; // Missing index

      await handler.handle(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Invalid index');
    });

    it('should handle server error gracefully', async () => {
      const ctx = mockContext('br_e:b_test123456ab:0') as Context;
      pkgCoreApi.briefExpand.mockRejectedValue(new Error('Server error'));

      await handler.handle(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Ошибка сервера');
    });

    it('should handle "message not modified" error silently', async () => {
      const ctx = mockContext('br_e:b_test123456ab:0') as Context;
      pkgCoreApi.briefExpand.mockRejectedValue(new Error('message is not modified'));

      await handler.handle(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith(); // Empty call
    });

    it('should handle unknown callback data', async () => {
      const ctx = mockContext('unknown:data') as Context;

      await handler.handle(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Unknown action');
    });
  });
});
