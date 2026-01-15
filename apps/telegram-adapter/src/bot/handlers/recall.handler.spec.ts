import { Test, TestingModule } from '@nestjs/testing';
import { RecallHandler } from './recall.handler';
import { PkgCoreApiService, RecallResponse, RecallSource } from '../../api/pkg-core-api.service';
import { Context } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';

describe('RecallHandler', () => {
  let handler: RecallHandler;
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
        RecallHandler,
        {
          provide: PkgCoreApiService,
          useValue: {
            recall: jest.fn(),
          },
        },
      ],
    }).compile();

    handler = module.get<RecallHandler>(RecallHandler);
    pkgCoreApi = module.get(PkgCoreApiService);
  });

  it('should be defined', () => {
    expect(handler).toBeDefined();
  });

  describe('handle', () => {
    it('should prompt for query when empty', async () => {
      const ctx = mockContext('/recall') as Context;
      await handler.handle(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Укажите поисковый запрос'),
      );
      expect(pkgCoreApi.recall).not.toHaveBeenCalled();
    });

    it('should prompt for query when only whitespace', async () => {
      const ctx = mockContext('/recall   ') as Context;
      await handler.handle(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Укажите поисковый запрос'),
      );
    });

    it('should call recall API with query', async () => {
      const ctx = mockContext('/recall кто советовал юриста?') as Context;
      const mockResponse: RecallResponse = {
        success: true,
        data: {
          answer: 'Иван советовал юриста в августе 2025.',
          sources: [
            { type: 'message', id: 'msg-1', preview: 'Привет! Рекомендую юриста...' },
          ],
          toolsUsed: ['search_messages'],
        },
      };
      pkgCoreApi.recall.mockResolvedValue(mockResponse);

      await handler.handle(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Ищу'));
      expect(pkgCoreApi.recall).toHaveBeenCalledWith('кто советовал юриста?');
      expect(ctx.telegram.editMessageText).toHaveBeenCalled();
    });

    it('should show error message when API returns failure', async () => {
      const ctx = mockContext('/recall test query') as Context;
      pkgCoreApi.recall.mockResolvedValue({
        success: false,
        data: { answer: '', sources: [], toolsUsed: [] },
      });

      await handler.handle(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        864381617,
        456,
        undefined,
        expect.stringContaining('Ошибка поиска'),
        expect.any(Object),
      );
    });

    it('should show timeout error message', async () => {
      const ctx = mockContext('/recall test') as Context;
      pkgCoreApi.recall.mockRejectedValue(new Error('ETIMEDOUT'));

      await handler.handle(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        864381617,
        456,
        undefined,
        expect.stringContaining('слишком много времени'),
        expect.any(Object),
      );
    });

    it('should show generic error message on exception', async () => {
      const ctx = mockContext('/recall test') as Context;
      pkgCoreApi.recall.mockRejectedValue(new Error('Network error'));

      await handler.handle(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        864381617,
        456,
        undefined,
        expect.stringContaining('Ошибка при поиске'),
        expect.any(Object),
      );
    });

    it('should format response with sources', async () => {
      const ctx = mockContext('/recall test') as Context;
      const sources: RecallSource[] = [
        { type: 'message', id: '1', preview: 'Source 1 preview text' },
        { type: 'message', id: '2', preview: 'Source 2 preview text' },
      ];
      pkgCoreApi.recall.mockResolvedValue({
        success: true,
        data: {
          answer: 'Test answer',
          sources,
          toolsUsed: [],
        },
      });

      await handler.handle(ctx);

      // The editMessageText should be called with formatted sources
      const callArgs = (ctx.telegram.editMessageText as jest.Mock).mock.calls[0];
      const messageText = callArgs[3];
      expect(messageText).toContain('Источники');
      expect(messageText).toContain('Source 1');
    });

    it('should truncate long source previews', async () => {
      const ctx = mockContext('/recall test') as Context;
      const longPreview = 'A'.repeat(200);
      pkgCoreApi.recall.mockResolvedValue({
        success: true,
        data: {
          answer: 'Test',
          sources: [{ type: 'message', id: '1', preview: longPreview }],
          toolsUsed: [],
        },
      });

      await handler.handle(ctx);

      const callArgs = (ctx.telegram.editMessageText as jest.Mock).mock.calls[0];
      const messageText = callArgs[3];
      expect(messageText.length).toBeLessThan(longPreview.length + 200);
    });

    it('should limit sources to 5', async () => {
      const ctx = mockContext('/recall test') as Context;
      const sources: RecallSource[] = Array.from({ length: 10 }, (_, i) => ({
        type: 'message' as const,
        id: `${i}`,
        preview: `Source ${i}`,
      }));
      pkgCoreApi.recall.mockResolvedValue({
        success: true,
        data: { answer: 'Test', sources, toolsUsed: [] },
      });

      await handler.handle(ctx);

      const callArgs = (ctx.telegram.editMessageText as jest.Mock).mock.calls[0];
      const messageText = callArgs[3];
      // Should contain only 5 sources
      expect((messageText.match(/Source/g) || []).length).toBeLessThanOrEqual(6); // 1 in answer + 5 sources max
    });
  });

  describe('markdownToTelegramHtml', () => {
    it('should convert bold markdown to HTML', async () => {
      const ctx = mockContext('/recall test') as Context;
      pkgCoreApi.recall.mockResolvedValue({
        success: true,
        data: {
          answer: '**Bold text** here',
          sources: [],
          toolsUsed: [],
        },
      });

      await handler.handle(ctx);

      const callArgs = (ctx.telegram.editMessageText as jest.Mock).mock.calls[0];
      expect(callArgs[3]).toContain('<b>Bold text</b>');
    });

    it('should convert headers to bold with emoji', async () => {
      const ctx = mockContext('/recall test') as Context;
      pkgCoreApi.recall.mockResolvedValue({
        success: true,
        data: {
          answer: '### Header Text',
          sources: [],
          toolsUsed: [],
        },
      });

      await handler.handle(ctx);

      const callArgs = (ctx.telegram.editMessageText as jest.Mock).mock.calls[0];
      expect(callArgs[3]).toContain('<b>Header Text</b>');
    });

    it('should convert inline code to code tags', async () => {
      const ctx = mockContext('/recall test') as Context;
      pkgCoreApi.recall.mockResolvedValue({
        success: true,
        data: {
          answer: 'Use `code` here',
          sources: [],
          toolsUsed: [],
        },
      });

      await handler.handle(ctx);

      const callArgs = (ctx.telegram.editMessageText as jest.Mock).mock.calls[0];
      expect(callArgs[3]).toContain('<code>code</code>');
    });

    it('should convert list items to bullets', async () => {
      const ctx = mockContext('/recall test') as Context;
      pkgCoreApi.recall.mockResolvedValue({
        success: true,
        data: {
          answer: '- Item 1\n- Item 2',
          sources: [],
          toolsUsed: [],
        },
      });

      await handler.handle(ctx);

      const callArgs = (ctx.telegram.editMessageText as jest.Mock).mock.calls[0];
      expect(callArgs[3]).toContain('• Item 1');
      expect(callArgs[3]).toContain('• Item 2');
    });

    it('should remove backslash escapes', async () => {
      const ctx = mockContext('/recall test') as Context;
      pkgCoreApi.recall.mockResolvedValue({
        success: true,
        data: {
          answer: 'Text with \\_escaped\\_ chars',
          sources: [],
          toolsUsed: [],
        },
      });

      await handler.handle(ctx);

      const callArgs = (ctx.telegram.editMessageText as jest.Mock).mock.calls[0];
      expect(callArgs[3]).not.toContain('\\');
    });
  });
});
