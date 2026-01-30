import { Test, TestingModule } from '@nestjs/testing';
import { DailySummaryHandler } from './daily-summary.handler';
import { PkgCoreApiService } from '../../api/pkg-core-api.service';
import { DailyContextCacheService } from '../../common/cache';
import { Context } from 'telegraf';

describe('DailySummaryHandler', () => {
  let handler: DailySummaryHandler;
  let pkgCoreApi: jest.Mocked<PkgCoreApiService>;
  let dailyContextCache: jest.Mocked<DailyContextCacheService>;

  const mockCtx = () => {
    const ctx = {
      chat: { id: 123456 },
      from: { id: 789 },
      callbackQuery: {
        data: '',
        message: { message_id: 100 },
      },
      message: {
        text: '/daily',
        message_id: 50,
        reply_to_message: null,
      },
      reply: jest.fn().mockResolvedValue({ message_id: 101 }),
      answerCbQuery: jest.fn().mockResolvedValue(true),
      telegram: {
        editMessageText: jest.fn().mockResolvedValue(true),
        editMessageReplyMarkup: jest.fn().mockResolvedValue(true),
        deleteMessage: jest.fn().mockResolvedValue(true),
      },
    } as unknown as Context;
    return ctx;
  };

  beforeEach(async () => {
    const mockPkgCoreApi = {
      recall: jest.fn(),
      followupRecall: jest.fn(),
      getRecallSession: jest.fn(),
      saveRecallSession: jest.fn(),
      extractFromSession: jest.fn(),
      createExtractionCarousel: jest.fn(),
      extractionCarouselPrev: jest.fn(),
      extractionCarouselNext: jest.fn(),
      extractionCarouselConfirm: jest.fn(),
      extractionCarouselSkip: jest.fn(),
      getExtractionCarouselStats: jest.fn(),
      getOwnerEntity: jest.fn(),
      persistExtractionCarousel: jest.fn(),
    };

    const mockDailyContextCache = {
      getSessionId: jest.fn(),
      setSessionId: jest.fn(),
      deleteSessionId: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DailySummaryHandler,
        { provide: PkgCoreApiService, useValue: mockPkgCoreApi },
        { provide: DailyContextCacheService, useValue: mockDailyContextCache },
      ],
    }).compile();

    handler = module.get<DailySummaryHandler>(DailySummaryHandler);
    pkgCoreApi = module.get(PkgCoreApiService);
    dailyContextCache = module.get(DailyContextCacheService);
  });

  describe('canHandle', () => {
    it('should return true for daily summary callbacks', () => {
      expect(handler.canHandle('ds_save:123')).toBe(true);
      expect(handler.canHandle('ds_extract:123')).toBe(true);
      expect(handler.canHandle('ds_noop')).toBe(true);
    });

    it('should return true for extraction carousel callbacks', () => {
      expect(handler.canHandle('exc_prev:carousel123')).toBe(true);
      expect(handler.canHandle('exc_next:carousel123')).toBe(true);
      expect(handler.canHandle('exc_confirm:carousel123')).toBe(true);
      expect(handler.canHandle('exc_skip:carousel123')).toBe(true);
    });

    it('should return false for other callbacks', () => {
      expect(handler.canHandle('other_callback')).toBe(false);
      expect(handler.canHandle('brief_123')).toBe(false);
    });
  });

  describe('handleCallback - save', () => {
    it('should save session successfully', async () => {
      const ctx = mockCtx();
      (ctx.callbackQuery as any).data = 'ds_save:100';

      dailyContextCache.getSessionId.mockResolvedValue('rs_abc123');
      pkgCoreApi.saveRecallSession.mockResolvedValue({
        success: true,
        alreadySaved: false,
        factId: 'fact-uuid-123',
      });

      await handler.handleCallback(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('💾 Сохраняю...');
      expect(pkgCoreApi.saveRecallSession).toHaveBeenCalledWith('rs_abc123', '789');
    });

    it('should handle already saved (idempotency)', async () => {
      const ctx = mockCtx();
      (ctx.callbackQuery as any).data = 'ds_save:100';

      dailyContextCache.getSessionId.mockResolvedValue('rs_abc123');
      pkgCoreApi.saveRecallSession.mockResolvedValue({
        success: true,
        alreadySaved: true,
        factId: 'existing-fact-uuid',
      });

      await handler.handleCallback(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('💾 Сохраняю...');
      // Should still update button status on success
    });

    it('should handle session not found (expired)', async () => {
      const ctx = mockCtx();
      (ctx.callbackQuery as any).data = 'ds_save:100';

      dailyContextCache.getSessionId.mockResolvedValue(null);

      await handler.handleCallback(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Саммари не найден (возможно, устарел)');
      expect(pkgCoreApi.saveRecallSession).not.toHaveBeenCalled();
    });

    it('should handle invalid callback format', async () => {
      const ctx = mockCtx();
      (ctx.callbackQuery as any).data = 'ds_save:invalid';

      await handler.handleCallback(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Неверный формат');
    });

    it('should handle API error', async () => {
      const ctx = mockCtx();
      (ctx.callbackQuery as any).data = 'ds_save:100';

      dailyContextCache.getSessionId.mockResolvedValue('rs_abc123');
      pkgCoreApi.saveRecallSession.mockResolvedValue({
        success: false,
        error: 'Database error',
      });

      await handler.handleCallback(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('❌ Ошибка сохранения: Database error');
    });
  });

  describe('handleCallback - extract', () => {
    it('should extract and create carousel successfully', async () => {
      const ctx = mockCtx();
      (ctx.callbackQuery as any).data = 'ds_extract:100';

      dailyContextCache.getSessionId.mockResolvedValue('rs_abc123');
      pkgCoreApi.getRecallSession.mockResolvedValue({
        success: true,
        data: {
          sessionId: 'rs_abc123',
          query: 'test',
          dateStr: '2026-01-30',
          answer: 'Test answer',
          sources: [],
          model: 'sonnet',
          createdAt: Date.now(),
        },
      });
      pkgCoreApi.extractFromSession.mockResolvedValue({
        success: true,
        data: {
          projects: [{ name: 'Project A', isNew: true, participants: [], confidence: 0.9 }],
          tasks: [],
          commitments: [],
          inferredRelations: [],
          extractionSummary: 'Found 1 project',
          tokensUsed: 100,
          durationMs: 500,
        },
      });
      pkgCoreApi.createExtractionCarousel.mockResolvedValue({
        success: true,
        carouselId: 'carousel-123',
        message: 'Project A',
        buttons: [[{ text: '✅', callback_data: 'exc_confirm:carousel-123' }]],
      });

      await handler.handleCallback(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('📈 Извлекаю структуру...');
      expect(pkgCoreApi.extractFromSession).toHaveBeenCalledWith('rs_abc123', undefined, 'sonnet');
    });

    it('should handle no structured data found', async () => {
      const ctx = mockCtx();
      (ctx.callbackQuery as any).data = 'ds_extract:100';

      dailyContextCache.getSessionId.mockResolvedValue('rs_abc123');
      pkgCoreApi.getRecallSession.mockResolvedValue({
        success: true,
        data: {
          sessionId: 'rs_abc123',
          query: 'test',
          dateStr: '2026-01-30',
          answer: 'Test answer',
          sources: [],
          model: 'sonnet',
          createdAt: Date.now(),
        },
      });
      pkgCoreApi.extractFromSession.mockResolvedValue({
        success: true,
        data: {
          projects: [],
          tasks: [],
          commitments: [],
          inferredRelations: [],
          extractionSummary: 'No data found',
          tokensUsed: 50,
          durationMs: 200,
        },
      });

      await handler.handleCallback(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('ℹ️ Структурированных данных не обнаружено.');
    });

    it('should handle session not found', async () => {
      const ctx = mockCtx();
      (ctx.callbackQuery as any).data = 'ds_extract:100';

      dailyContextCache.getSessionId.mockResolvedValue(null);

      await handler.handleCallback(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Саммари не найден (возможно, устарел)');
    });
  });

  describe('handleCallback - carousel navigation', () => {
    it('should handle prev navigation', async () => {
      const ctx = mockCtx();
      (ctx.callbackQuery as any).data = 'exc_prev:carousel-123';

      pkgCoreApi.extractionCarouselPrev.mockResolvedValue({
        success: true,
        complete: false,
        message: 'Previous item',
        buttons: [[{ text: '✅', callback_data: 'exc_confirm:carousel-123' }]],
        chatId: '123456',
        messageId: 100,
      });

      await handler.handleCallback(ctx);

      expect(pkgCoreApi.extractionCarouselPrev).toHaveBeenCalledWith('carousel-123');
    });

    it('should handle next navigation', async () => {
      const ctx = mockCtx();
      (ctx.callbackQuery as any).data = 'exc_next:carousel-123';

      pkgCoreApi.extractionCarouselNext.mockResolvedValue({
        success: true,
        complete: false,
        message: 'Next item',
        buttons: [[{ text: '✅', callback_data: 'exc_confirm:carousel-123' }]],
        chatId: '123456',
        messageId: 100,
      });

      await handler.handleCallback(ctx);

      expect(pkgCoreApi.extractionCarouselNext).toHaveBeenCalledWith('carousel-123');
    });

    it('should handle confirm action', async () => {
      const ctx = mockCtx();
      (ctx.callbackQuery as any).data = 'exc_confirm:carousel-123';

      pkgCoreApi.extractionCarouselConfirm.mockResolvedValue({
        success: true,
        complete: false,
        message: 'Confirmed, next item',
        buttons: [[{ text: '✅', callback_data: 'exc_confirm:carousel-123' }]],
        chatId: '123456',
        messageId: 100,
      });

      await handler.handleCallback(ctx);

      expect(pkgCoreApi.extractionCarouselConfirm).toHaveBeenCalledWith('carousel-123');
    });

    it('should handle skip action', async () => {
      const ctx = mockCtx();
      (ctx.callbackQuery as any).data = 'exc_skip:carousel-123';

      pkgCoreApi.extractionCarouselSkip.mockResolvedValue({
        success: true,
        complete: false,
        message: 'Skipped, next item',
        buttons: [[{ text: '✅', callback_data: 'exc_confirm:carousel-123' }]],
        chatId: '123456',
        messageId: 100,
      });

      await handler.handleCallback(ctx);

      expect(pkgCoreApi.extractionCarouselSkip).toHaveBeenCalledWith('carousel-123');
    });

    it('should handle carousel complete', async () => {
      const ctx = mockCtx();
      (ctx.callbackQuery as any).data = 'exc_confirm:carousel-123';

      pkgCoreApi.extractionCarouselConfirm.mockResolvedValue({
        success: true,
        complete: true,
        message: 'All done',
        chatId: '123456',
        messageId: 100,
      });
      pkgCoreApi.getExtractionCarouselStats.mockResolvedValue({
        success: true,
        stats: { confirmed: 2, skipped: 1, total: 3, processed: 3, confirmedByType: { projects: 1, tasks: 1, commitments: 0 } },
      });
      pkgCoreApi.getOwnerEntity.mockResolvedValue({ id: 'owner-uuid', name: 'Test Owner' });
      pkgCoreApi.persistExtractionCarousel.mockResolvedValue({
        success: true,
        result: { projectsCreated: 1, tasksCreated: 1, commitmentsCreated: 0, activityIds: ['act-1'], commitmentIds: [], errors: [] },
      });

      await handler.handleCallback(ctx);

      expect(pkgCoreApi.persistExtractionCarousel).toHaveBeenCalledWith('carousel-123', 'owner-uuid');
    });

    it('should handle invalid carousel callback format', async () => {
      const ctx = mockCtx();
      (ctx.callbackQuery as any).data = 'exc_invalid:carousel-123';

      await handler.handleCallback(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Неверный формат');
    });
  });

  describe('handleCallback - noop', () => {
    it('should just answer callback query for noop', async () => {
      const ctx = mockCtx();
      (ctx.callbackQuery as any).data = 'ds_noop';

      await handler.handleCallback(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalled();
    });
  });

  describe('handle (command)', () => {
    it('should execute daily summary query', async () => {
      const ctx = mockCtx();
      (ctx.message as any).text = '/daily';

      pkgCoreApi.recall.mockResolvedValue({
        success: true,
        data: {
          sessionId: 'rs_abc123',
          answer: 'Daily summary here',
          sources: [],
          toolsUsed: ['search_messages'],
        },
      });

      await handler.handle(ctx);

      expect(pkgCoreApi.recall).toHaveBeenCalledWith(
        expect.stringContaining('Подготовь подробное саммари за сегодня'),
        180000,
        undefined,
      );
      expect(dailyContextCache.setSessionId).toHaveBeenCalled();
    });

    it('should handle focus topic', async () => {
      const ctx = mockCtx();
      (ctx.message as any).text = '/daily Панавто';

      pkgCoreApi.recall.mockResolvedValue({
        success: true,
        data: {
          sessionId: 'rs_abc123',
          answer: 'Summary about Панавто',
          sources: [],
          toolsUsed: [],
        },
      });

      await handler.handle(ctx);

      expect(pkgCoreApi.recall).toHaveBeenCalledWith(
        expect.stringContaining('Особый фокус на: Панавто'),
        180000,
        undefined,
      );
    });

    it('should handle --model flag', async () => {
      const ctx = mockCtx();
      (ctx.message as any).text = '/daily --model haiku';

      pkgCoreApi.recall.mockResolvedValue({
        success: true,
        data: {
          sessionId: 'rs_abc123',
          answer: 'Summary',
          sources: [],
          toolsUsed: [],
        },
      });

      await handler.handle(ctx);

      expect(pkgCoreApi.recall).toHaveBeenCalledWith(
        expect.any(String),
        180000,
        'haiku',
      );
    });
  });

  describe('handleReply', () => {
    it('should handle follow-up reply', async () => {
      const ctx = mockCtx();
      (ctx.message as any).text = 'А что насчёт дедлайнов?';
      (ctx.message as any).reply_to_message = { message_id: 50 };

      dailyContextCache.getSessionId.mockResolvedValue('rs_abc123');
      pkgCoreApi.followupRecall.mockResolvedValue({
        success: true,
        data: {
          sessionId: 'rs_abc123',
          answer: 'Дедлайны: ...',
          sources: [],
          toolsUsed: [],
        },
      });
      pkgCoreApi.getRecallSession.mockResolvedValue({
        success: true,
        data: {
          sessionId: 'rs_abc123',
          query: 'test',
          dateStr: '2026-01-30',
          answer: 'Answer',
          sources: [],
          createdAt: Date.now(),
        },
      });

      const result = await handler.handleReply(ctx);

      expect(result).toBe(true);
      expect(pkgCoreApi.followupRecall).toHaveBeenCalledWith('rs_abc123', 'А что насчёт дедлайнов?');
    });

    it('should return false when no reply_to_message', async () => {
      const ctx = mockCtx();
      (ctx.message as any).reply_to_message = null;

      const result = await handler.handleReply(ctx);

      expect(result).toBe(false);
    });

    it('should return false when session not found for reply', async () => {
      const ctx = mockCtx();
      (ctx.message as any).text = 'Follow up';
      (ctx.message as any).reply_to_message = { message_id: 999 };

      dailyContextCache.getSessionId.mockResolvedValue(null);

      const result = await handler.handleReply(ctx);

      expect(result).toBe(false);
    });
  });
});
