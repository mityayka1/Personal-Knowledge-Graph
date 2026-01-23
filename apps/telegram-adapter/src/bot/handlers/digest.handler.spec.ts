import { Test, TestingModule } from '@nestjs/testing';
import { DigestHandler } from './digest.handler';
import { PkgCoreApiService } from '../../api/pkg-core-api.service';
import { Context } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';

describe('DigestHandler', () => {
  let handler: DigestHandler;
  let pkgCoreApi: jest.Mocked<PkgCoreApiService>;

  const mockContext = (): Partial<Context> =>
    ({
      message: {
        text: '/morning',
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
    }) as unknown as Partial<Context>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DigestHandler,
        {
          provide: PkgCoreApiService,
          useValue: {
            triggerMorningBrief: jest.fn(),
            triggerHourlyDigest: jest.fn(),
            triggerDailyDigest: jest.fn(),
          },
        },
      ],
    }).compile();

    handler = module.get<DigestHandler>(DigestHandler);
    pkgCoreApi = module.get(PkgCoreApiService);
  });

  it('should be defined', () => {
    expect(handler).toBeDefined();
  });

  describe('handleMorning', () => {
    it('should send status message and call trigger', async () => {
      const ctx = mockContext() as Context;
      pkgCoreApi.triggerMorningBrief.mockResolvedValue({
        success: true,
        message: 'Morning brief sent',
      });

      await handler.handleMorning(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Готовлю'));
      expect(pkgCoreApi.triggerMorningBrief).toHaveBeenCalled();
    });

    it('should update message on success', async () => {
      const ctx = mockContext() as Context;
      pkgCoreApi.triggerMorningBrief.mockResolvedValue({
        success: true,
        message: 'Sent',
      });

      await handler.handleMorning(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        864381617,
        456,
        undefined,
        expect.stringContaining('отправлен'),
      );
    });

    it('should show error message on API failure', async () => {
      const ctx = mockContext() as Context;
      pkgCoreApi.triggerMorningBrief.mockResolvedValue({
        success: false,
        message: 'Failed',
      });

      await handler.handleMorning(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        864381617,
        456,
        undefined,
        expect.stringContaining('Не удалось отправить'),
      );
    });

    it('should show timeout error on ETIMEDOUT', async () => {
      const ctx = mockContext() as Context;
      pkgCoreApi.triggerMorningBrief.mockRejectedValue(new Error('ETIMEDOUT'));

      await handler.handleMorning(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        864381617,
        456,
        undefined,
        expect.stringContaining('слишком много времени'),
      );
    });

    it('should show generic error on exception', async () => {
      const ctx = mockContext() as Context;
      pkgCoreApi.triggerMorningBrief.mockRejectedValue(new Error('Network error'));

      await handler.handleMorning(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        864381617,
        456,
        undefined,
        expect.stringContaining('Ошибка при подготовке'),
      );
    });

    it('should use correct emoji for morning', async () => {
      const ctx = mockContext() as Context;
      pkgCoreApi.triggerMorningBrief.mockResolvedValue({ success: true, message: '' });

      await handler.handleMorning(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/^🌅/));
    });

    it('should use correct name for morning brief', async () => {
      const ctx = mockContext() as Context;
      pkgCoreApi.triggerMorningBrief.mockResolvedValue({ success: true, message: '' });

      await handler.handleMorning(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Утренний бриф'));
    });
  });

  describe('handleDigest', () => {
    it('should send status message and call trigger', async () => {
      const ctx = mockContext() as Context;
      pkgCoreApi.triggerHourlyDigest.mockResolvedValue({
        success: true,
        message: 'Digest sent',
      });

      await handler.handleDigest(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Дайджест'));
      expect(pkgCoreApi.triggerHourlyDigest).toHaveBeenCalled();
    });

    it('should update message on success', async () => {
      const ctx = mockContext() as Context;
      pkgCoreApi.triggerHourlyDigest.mockResolvedValue({
        success: true,
        message: 'Sent',
      });

      await handler.handleDigest(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        864381617,
        456,
        undefined,
        expect.stringContaining('отправлен'),
      );
    });

    it('should show timeout error on timeout message', async () => {
      const ctx = mockContext() as Context;
      pkgCoreApi.triggerHourlyDigest.mockRejectedValue(new Error('Request timeout'));

      await handler.handleDigest(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        864381617,
        456,
        undefined,
        expect.stringContaining('слишком много времени'),
      );
    });

    it('should use correct emoji for hourly', async () => {
      const ctx = mockContext() as Context;
      pkgCoreApi.triggerHourlyDigest.mockResolvedValue({ success: true, message: '' });

      await handler.handleDigest(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/^📋/));
    });

    it('should use correct name for hourly digest', async () => {
      const ctx = mockContext() as Context;
      pkgCoreApi.triggerHourlyDigest.mockResolvedValue({ success: true, message: '' });

      await handler.handleDigest(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Дайджест событий'));
    });
  });

  describe('handleDaily', () => {
    it('should send status message and call trigger', async () => {
      const ctx = mockContext() as Context;
      pkgCoreApi.triggerDailyDigest.mockResolvedValue({
        success: true,
        message: 'Daily digest sent',
      });

      await handler.handleDaily(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Дневной'));
      expect(pkgCoreApi.triggerDailyDigest).toHaveBeenCalled();
    });

    it('should update message on success', async () => {
      const ctx = mockContext() as Context;
      pkgCoreApi.triggerDailyDigest.mockResolvedValue({
        success: true,
        message: 'Sent',
      });

      await handler.handleDaily(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        864381617,
        456,
        undefined,
        expect.stringContaining('отправлен'),
      );
    });

    it('should show timeout error on ECONNABORTED', async () => {
      const ctx = mockContext() as Context;
      pkgCoreApi.triggerDailyDigest.mockRejectedValue(new Error('ECONNABORTED'));

      await handler.handleDaily(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        864381617,
        456,
        undefined,
        expect.stringContaining('слишком много времени'),
      );
    });

    it('should use correct emoji for daily', async () => {
      const ctx = mockContext() as Context;
      pkgCoreApi.triggerDailyDigest.mockResolvedValue({ success: true, message: '' });

      await handler.handleDaily(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/^📊/));
    });

    it('should use correct name for daily digest', async () => {
      const ctx = mockContext() as Context;
      pkgCoreApi.triggerDailyDigest.mockResolvedValue({ success: true, message: '' });

      await handler.handleDaily(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Дневной дайджест'));
    });
  });

  describe('isTimeoutError detection', () => {
    it('should detect ETIMEDOUT as timeout', async () => {
      const ctx = mockContext() as Context;
      pkgCoreApi.triggerMorningBrief.mockRejectedValue(new Error('Connection ETIMEDOUT'));

      await handler.handleMorning(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        864381617,
        456,
        undefined,
        expect.stringContaining('слишком много времени'),
      );
    });

    it('should detect timeout keyword as timeout', async () => {
      const ctx = mockContext() as Context;
      pkgCoreApi.triggerMorningBrief.mockRejectedValue(new Error('Request timeout exceeded'));

      await handler.handleMorning(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        864381617,
        456,
        undefined,
        expect.stringContaining('слишком много времени'),
      );
    });

    it('should detect ECONNABORTED as timeout', async () => {
      const ctx = mockContext() as Context;
      pkgCoreApi.triggerMorningBrief.mockRejectedValue(new Error('ECONNABORTED'));

      await handler.handleMorning(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        864381617,
        456,
        undefined,
        expect.stringContaining('слишком много времени'),
      );
    });

    it('should not detect network error as timeout', async () => {
      const ctx = mockContext() as Context;
      pkgCoreApi.triggerMorningBrief.mockRejectedValue(new Error('Network error'));

      await handler.handleMorning(ctx);

      expect(ctx.telegram.editMessageText).toHaveBeenCalledWith(
        864381617,
        456,
        undefined,
        expect.stringContaining('Ошибка при подготовке'),
      );
    });
  });

  describe('editMessage error handling', () => {
    it('should handle edit message failure gracefully', async () => {
      const ctx = mockContext() as Context;
      pkgCoreApi.triggerMorningBrief.mockResolvedValue({
        success: true,
        message: 'Sent',
      });
      (ctx.telegram.editMessageText as jest.Mock).mockRejectedValue(
        new Error('Message not modified'),
      );

      // Should not throw
      await expect(handler.handleMorning(ctx)).resolves.not.toThrow();
    });
  });
});
