import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
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
      // New PendingApproval API methods
      extractAndSave: jest.fn(),
      listPendingApprovals: jest.fn(),
      getPendingApproval: jest.fn(),
      getPendingApprovalBatchStats: jest.fn(),
      approvePendingItem: jest.fn(),
      rejectPendingItem: jest.fn(),
      approvePendingBatch: jest.fn(),
      rejectPendingBatch: jest.fn(),
    };

    const mockDailyContextCache = {
      getSessionId: jest.fn(),
      setSessionId: jest.fn(),
      deleteSessionId: jest.fn(),
    };

    const mockConfigService = {
      get: jest.fn().mockReturnValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DailySummaryHandler,
        { provide: PkgCoreApiService, useValue: mockPkgCoreApi },
        { provide: DailyContextCacheService, useValue: mockDailyContextCache },
        { provide: ConfigService, useValue: mockConfigService },
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

    it('should return true for pending approval callbacks', () => {
      expect(handler.canHandle('pa_approve_all:batch123')).toBe(true);
      expect(handler.canHandle('pa_reject_all:batch123')).toBe(true);
      expect(handler.canHandle('pa_list:batch123:0')).toBe(true);
      expect(handler.canHandle('pa_approve:item123')).toBe(true);
      expect(handler.canHandle('pa_reject:item123')).toBe(true);
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
    it('should extract and save with new pending approval flow', async () => {
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
      pkgCoreApi.getOwnerEntity.mockResolvedValue({ id: 'owner-uuid', name: 'Me' });
      pkgCoreApi.extractAndSave.mockResolvedValue({
        batchId: 'batch-123',
        counts: { projects: 1, tasks: 2, commitments: 0 },
        approvals: [
          { id: 'pa-1', itemType: 'project', targetId: 'proj-1', confidence: 0.9 },
          { id: 'pa-2', itemType: 'task', targetId: 'task-1', confidence: 0.85 },
          { id: 'pa-3', itemType: 'task', targetId: 'task-2', confidence: 0.8 },
        ],
        extraction: {
          projectsExtracted: 1,
          tasksExtracted: 2,
          commitmentsExtracted: 0,
          relationsInferred: 0,
          summary: 'Extracted 1 project, 2 tasks',
          tokensUsed: 100,
          durationMs: 500,
        },
      });

      await handler.handleCallback(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('📈 Извлекаю структуру...');
      expect(pkgCoreApi.extractAndSave).toHaveBeenCalledWith({
        synthesisText: 'Test answer',
        ownerEntityId: 'owner-uuid',
        date: '2026-01-30',
        messageRef: 'telegram:chat:123456:msg:100',
        sourceInteractionId: undefined,
      });
      // Should show summary with buttons
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('📈 <b>Извлечённая структура</b>'),
        expect.objectContaining({
          parse_mode: 'HTML',
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.arrayContaining([
              expect.arrayContaining([
                expect.objectContaining({ text: '✅ Подтвердить все' }),
                expect.objectContaining({ text: '❌ Отклонить все' }),
              ]),
            ]),
          }),
        }),
      );
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
      pkgCoreApi.getOwnerEntity.mockResolvedValue({ id: 'owner-uuid', name: 'Me' });
      pkgCoreApi.extractAndSave.mockResolvedValue({
        batchId: 'batch-empty',
        counts: { projects: 0, tasks: 0, commitments: 0 },
        approvals: [],
        extraction: {
          projectsExtracted: 0,
          tasksExtracted: 0,
          commitmentsExtracted: 0,
          relationsInferred: 0,
          summary: 'No data found',
          tokensUsed: 50,
          durationMs: 200,
        },
      });

      await handler.handleCallback(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('ℹ️ Структурированных данных не обнаружено.');
    });

    it('should handle owner not found', async () => {
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
      pkgCoreApi.getOwnerEntity.mockResolvedValue(null);

      await handler.handleCallback(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Владелец не найден');
      expect(ctx.reply).toHaveBeenCalledWith(
        '⚠️ Не найден владелец (entity "me"). Используйте /settings для настройки.',
      );
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

  describe('handleCallback - pending approval', () => {
    it('should approve all items in batch', async () => {
      const ctx = mockCtx();
      (ctx.callbackQuery as any).data = 'pa_approve_all:batch-123';

      pkgCoreApi.approvePendingBatch.mockResolvedValue({
        batchId: 'batch-123',
        processed: 5,
        failed: 0,
      });

      await handler.handleCallback(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('✅ Подтверждаю все...');
      expect(pkgCoreApi.approvePendingBatch).toHaveBeenCalledWith('batch-123');
      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        123456,
        100,
        undefined,
        expect.stringContaining('Все элементы подтверждены'),
        expect.objectContaining({ parse_mode: 'HTML' }),
      );
    });

    it('should reject all items in batch', async () => {
      const ctx = mockCtx();
      (ctx.callbackQuery as any).data = 'pa_reject_all:batch-123';

      pkgCoreApi.rejectPendingBatch.mockResolvedValue({
        batchId: 'batch-123',
        processed: 5,
        failed: 0,
      });

      await handler.handleCallback(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('❌ Отклоняю все...');
      expect(pkgCoreApi.rejectPendingBatch).toHaveBeenCalledWith('batch-123');
      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        123456,
        100,
        undefined,
        expect.stringContaining('Все элементы отклонены'),
        expect.objectContaining({ parse_mode: 'HTML' }),
      );
    });

    it('should list pending items for review', async () => {
      const ctx = mockCtx();
      (ctx.callbackQuery as any).data = 'pa_list:batch-123:0';

      pkgCoreApi.listPendingApprovals.mockResolvedValue({
        items: [
          {
            id: 'pa-1',
            itemType: 'project' as const,
            targetId: 'proj-1',
            batchId: 'batch-123',
            status: 'pending' as const,
            confidence: 0.9,
            sourceQuote: 'Project Alpha launch',
            createdAt: new Date().toISOString(),
          },
        ],
        total: 3,
        limit: 1,
        offset: 0,
      });

      await handler.handleCallback(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalled();
      expect(pkgCoreApi.listPendingApprovals).toHaveBeenCalledWith({
        batchId: 'batch-123',
        status: 'pending',
        limit: 1,
        offset: 0,
      });
      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        123456,
        100,
        undefined,
        expect.stringContaining('🏗 Проект'),
        expect.objectContaining({
          parse_mode: 'HTML',
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.arrayContaining([
              expect.arrayContaining([
                expect.objectContaining({ text: '✅ Подтвердить' }),
                expect.objectContaining({ text: '❌ Отклонить' }),
              ]),
            ]),
          }),
        }),
      );
    });

    it('should show completion when no more pending items', async () => {
      const ctx = mockCtx();
      (ctx.callbackQuery as any).data = 'pa_list:batch-123:0';

      pkgCoreApi.listPendingApprovals.mockResolvedValue({
        items: [],
        total: 0,
        limit: 1,
        offset: 0,
      });
      pkgCoreApi.getPendingApprovalBatchStats.mockResolvedValue({
        batchId: 'batch-123',
        total: 3,
        pending: 0,
        approved: 2,
        rejected: 1,
      });

      await handler.handleCallback(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        123456,
        100,
        undefined,
        expect.stringContaining('Обработка завершена'),
        expect.objectContaining({ parse_mode: 'HTML' }),
      );
    });

    it('should approve single item and continue to next', async () => {
      const ctx = mockCtx();
      (ctx.callbackQuery as any).data = 'pa_approve:pa-1';

      pkgCoreApi.approvePendingItem.mockResolvedValue({ success: true, id: 'pa-1' });
      pkgCoreApi.getPendingApproval.mockResolvedValue({
        id: 'pa-1',
        itemType: 'project' as const,
        targetId: 'proj-1',
        batchId: 'batch-123',
        status: 'approved' as const,
        confidence: 0.9,
        createdAt: new Date().toISOString(),
      });
      pkgCoreApi.listPendingApprovals.mockResolvedValue({
        items: [],
        total: 0,
        limit: 1,
        offset: 0,
      });
      pkgCoreApi.getPendingApprovalBatchStats.mockResolvedValue({
        batchId: 'batch-123',
        total: 1,
        pending: 0,
        approved: 1,
        rejected: 0,
      });

      await handler.handleCallback(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('✅ Подтверждаю...');
      expect(pkgCoreApi.approvePendingItem).toHaveBeenCalledWith('pa-1');
    });

    it('should reject single item and continue to next', async () => {
      const ctx = mockCtx();
      (ctx.callbackQuery as any).data = 'pa_reject:pa-1';

      pkgCoreApi.rejectPendingItem.mockResolvedValue({ success: true, id: 'pa-1' });
      pkgCoreApi.getPendingApproval.mockResolvedValue({
        id: 'pa-1',
        itemType: 'project' as const,
        targetId: 'proj-1',
        batchId: 'batch-123',
        status: 'rejected' as const,
        confidence: 0.9,
        createdAt: new Date().toISOString(),
      });
      pkgCoreApi.listPendingApprovals.mockResolvedValue({
        items: [],
        total: 0,
        limit: 1,
        offset: 0,
      });
      pkgCoreApi.getPendingApprovalBatchStats.mockResolvedValue({
        batchId: 'batch-123',
        total: 1,
        pending: 0,
        approved: 0,
        rejected: 1,
      });

      await handler.handleCallback(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('❌ Отклоняю...');
      expect(pkgCoreApi.rejectPendingItem).toHaveBeenCalledWith('pa-1');
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
