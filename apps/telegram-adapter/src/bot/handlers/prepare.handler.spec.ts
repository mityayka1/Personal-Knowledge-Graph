import { Test, TestingModule } from '@nestjs/testing';
import { PrepareHandler } from './prepare.handler';
import {
  PkgCoreApiService,
  PrepareResponse,
  EntitiesResponse,
  EntitySearchResult,
} from '../../api/pkg-core-api.service';
import { Context } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';

describe('PrepareHandler', () => {
  let handler: PrepareHandler;
  let pkgCoreApi: jest.Mocked<PkgCoreApiService>;

  const mockContext = (text: string): Partial<Context> => ({
    message: {
      text,
      message_id: 123,
      date: Date.now(),
      chat: { id: 864381617, type: 'private' },
    } as Message.TextMessage,
    from: { id: 864381617, is_bot: false, first_name: 'Test' },
    chat: { id: 864381617, type: 'private' },
    reply: jest.fn().mockResolvedValue({ message_id: 456 }),
    telegram: {
      editMessageText: jest.fn().mockResolvedValue({}),
    },
  } as unknown as Partial<Context>);

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrepareHandler,
        {
          provide: PkgCoreApiService,
          useValue: {
            searchEntities: jest.fn(),
            prepare: jest.fn(),
          },
        },
      ],
    }).compile();

    handler = module.get<PrepareHandler>(PrepareHandler);
    pkgCoreApi = module.get(PkgCoreApiService);
  });

  it('should be defined', () => {
    expect(handler).toBeDefined();
  });

  describe('handle', () => {
    it('should prompt for name when empty', async () => {
      const ctx = mockContext('/prepare') as Context;
      await handler.handle(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Укажите имя контакта'),
      );
      expect(pkgCoreApi.searchEntities).not.toHaveBeenCalled();
    });

    it('should prompt for name when only whitespace', async () => {
      const ctx = mockContext('/prepare   ') as Context;
      await handler.handle(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Укажите имя контакта'),
      );
    });

    it('should search for entity by name', async () => {
      const ctx = mockContext('/prepare Иван Петров') as Context;
      const mockEntity: EntitySearchResult = {
        id: 'uuid-123',
        name: 'Иван Петров',
        type: 'person',
        createdAt: '2025-01-01',
      };
      pkgCoreApi.searchEntities.mockResolvedValue({
        items: [mockEntity],
        total: 1,
      });
      pkgCoreApi.prepare.mockResolvedValue({
        success: true,
        data: {
          entityId: 'uuid-123',
          entityName: 'Иван Петров',
          brief: 'Тестовый бриф',
          recentInteractions: 5,
          openQuestions: [],
        },
      });

      await handler.handle(ctx);

      expect(pkgCoreApi.searchEntities).toHaveBeenCalledWith('Иван Петров', 5);
      expect(pkgCoreApi.prepare).toHaveBeenCalledWith('uuid-123');
    });

    it('should show not found message when no entities match', async () => {
      const ctx = mockContext('/prepare Несуществующий') as Context;
      pkgCoreApi.searchEntities.mockResolvedValue({
        items: [],
        total: 0,
      });

      await handler.handle(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        864381617,
        456,
        undefined,
        expect.stringContaining('не найден'),
        expect.any(Object),
      );
    });

    it('should show selection when multiple entities found', async () => {
      const ctx = mockContext('/prepare Иван') as Context;
      pkgCoreApi.searchEntities.mockResolvedValue({
        items: [
          { id: '1', name: 'Иван Петров', type: 'person', createdAt: '2025-01-01' },
          { id: '2', name: 'Иван Сидоров', type: 'person', createdAt: '2025-01-02' },
        ],
        total: 2,
      });

      await handler.handle(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        864381617,
        456,
        undefined,
        expect.stringContaining('Найдено несколько'),
        expect.any(Object),
      );
      expect(pkgCoreApi.prepare).not.toHaveBeenCalled();
    });

    it('should format briefing with all sections', async () => {
      const ctx = mockContext('/prepare Тест') as Context;
      pkgCoreApi.searchEntities.mockResolvedValue({
        items: [{ id: '1', name: 'Тест', type: 'person', createdAt: '2025-01-01' }],
        total: 1,
      });
      pkgCoreApi.prepare.mockResolvedValue({
        success: true,
        data: {
          entityId: '1',
          entityName: 'Тест',
          brief: 'Описание контакта',
          recentInteractions: 10,
          openQuestions: ['Вопрос 1', 'Вопрос 2'],
        },
      });

      await handler.handle(ctx);

      const callArgs = (ctx.telegram.editMessageText as jest.Mock).mock.calls[1]; // Second call is the brief
      const messageText = callArgs[3];
      expect(messageText).toContain('Тест');
      expect(messageText).toContain('Описание контакта');
      expect(messageText).toContain('10');
      expect(messageText).toContain('Вопрос 1');
      expect(messageText).toContain('Вопрос 2');
    });

    it('should show error when prepare fails', async () => {
      const ctx = mockContext('/prepare Тест') as Context;
      pkgCoreApi.searchEntities.mockResolvedValue({
        items: [{ id: '1', name: 'Тест', type: 'person', createdAt: '2025-01-01' }],
        total: 1,
      });
      pkgCoreApi.prepare.mockResolvedValue({
        success: false,
        data: {
          entityId: '',
          entityName: '',
          brief: '',
          recentInteractions: 0,
          openQuestions: [],
        },
      });

      await handler.handle(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenLastCalledWith(
        864381617,
        456,
        undefined,
        expect.stringContaining('Не удалось подготовить'),
        expect.any(Object),
      );
    });

    it('should handle timeout error', async () => {
      const ctx = mockContext('/prepare Тест') as Context;
      pkgCoreApi.searchEntities.mockResolvedValue({
        items: [{ id: '1', name: 'Тест', type: 'person', createdAt: '2025-01-01' }],
        total: 1,
      });
      pkgCoreApi.prepare.mockRejectedValue(new Error('ETIMEDOUT'));

      await handler.handle(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenLastCalledWith(
        864381617,
        456,
        undefined,
        expect.stringContaining('слишком много времени'),
        expect.any(Object),
      );
    });

    it('should handle generic errors', async () => {
      const ctx = mockContext('/prepare Тест') as Context;
      pkgCoreApi.searchEntities.mockRejectedValue(new Error('Network error'));

      await handler.handle(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        864381617,
        456,
        undefined,
        expect.stringContaining('Ошибка'),
        expect.any(Object),
      );
    });
  });

  describe('formatBriefing', () => {
    it('should format brief with open questions', async () => {
      const ctx = mockContext('/prepare Тест') as Context;
      pkgCoreApi.searchEntities.mockResolvedValue({
        items: [{ id: '1', name: 'Тест', type: 'person', createdAt: '2025-01-01' }],
        total: 1,
      });
      pkgCoreApi.prepare.mockResolvedValue({
        success: true,
        data: {
          entityId: '1',
          entityName: 'Тест',
          brief: 'Brief text',
          recentInteractions: 3,
          openQuestions: ['Question 1', 'Question 2'],
        },
      });

      await handler.handle(ctx);

      const callArgs = (ctx.telegram.editMessageText as jest.Mock).mock.calls[1];
      const messageText = callArgs[3];
      expect(messageText).toContain('Открытые вопросы');
      expect(messageText).toContain('Question 1');
      expect(messageText).toContain('Question 2');
    });

    it('should format brief without open questions section when empty', async () => {
      const ctx = mockContext('/prepare Тест') as Context;
      pkgCoreApi.searchEntities.mockResolvedValue({
        items: [{ id: '1', name: 'Тест', type: 'person', createdAt: '2025-01-01' }],
        total: 1,
      });
      pkgCoreApi.prepare.mockResolvedValue({
        success: true,
        data: {
          entityId: '1',
          entityName: 'Тест',
          brief: 'Brief text',
          recentInteractions: 3,
          openQuestions: [],
        },
      });

      await handler.handle(ctx);

      const callArgs = (ctx.telegram.editMessageText as jest.Mock).mock.calls[1];
      const messageText = callArgs[3];
      expect(messageText).not.toContain('Открытые вопросы');
    });
  });

  describe('markdownToTelegramHtml', () => {
    it('should convert markdown formatting', async () => {
      const ctx = mockContext('/prepare Тест') as Context;
      pkgCoreApi.searchEntities.mockResolvedValue({
        items: [{ id: '1', name: 'Тест', type: 'person', createdAt: '2025-01-01' }],
        total: 1,
      });
      pkgCoreApi.prepare.mockResolvedValue({
        success: true,
        data: {
          entityId: '1',
          entityName: 'Тест',
          brief: '**Bold** and _italic_ text',
          recentInteractions: 1,
          openQuestions: [],
        },
      });

      await handler.handle(ctx);

      const callArgs = (ctx.telegram.editMessageText as jest.Mock).mock.calls[1];
      const messageText = callArgs[3];
      expect(messageText).toContain('<b>Bold</b>');
      expect(messageText).toContain('<i>italic</i>');
    });

    it('should handle HTML special characters in ampersands', async () => {
      const ctx = mockContext('/prepare Тест') as Context;
      pkgCoreApi.searchEntities.mockResolvedValue({
        items: [{ id: '1', name: 'Тест', type: 'person', createdAt: '2025-01-01' }],
        total: 1,
      });
      pkgCoreApi.prepare.mockResolvedValue({
        success: true,
        data: {
          entityId: '1',
          entityName: 'Тест',
          brief: 'Text with & ampersand',
          recentInteractions: 1,
          openQuestions: [],
        },
      });

      await handler.handle(ctx);

      const callArgs = (ctx.telegram.editMessageText as jest.Mock).mock.calls[1];
      const messageText = callArgs[3];
      expect(messageText).toContain('&amp;');
    });
  });
});
