import { Test, TestingModule } from '@nestjs/testing';
import { CarouselCallbackHandler } from './carousel-callback.handler';
import { PkgCoreApiService, CarouselNavResponse } from '../../api/pkg-core-api.service';
import { BotService } from '../bot.service';
import { Context } from 'telegraf';

describe('CarouselCallbackHandler', () => {
  let handler: CarouselCallbackHandler;
  let pkgCoreApi: jest.Mocked<PkgCoreApiService>;
  let botService: jest.Mocked<BotService>;

  const mockContext = {
    callbackQuery: {
      data: '',
    },
    editMessageText: jest.fn().mockResolvedValue(undefined),
    answerCbQuery: jest.fn().mockResolvedValue(undefined),
  } as unknown as Context;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CarouselCallbackHandler,
        {
          provide: PkgCoreApiService,
          useValue: {
            carouselNext: jest.fn(),
            carouselPrev: jest.fn(),
            carouselConfirm: jest.fn(),
            carouselReject: jest.fn(),
          },
        },
        {
          provide: BotService,
          useValue: {
            editMessage: jest.fn(),
          },
        },
      ],
    }).compile();

    handler = module.get<CarouselCallbackHandler>(CarouselCallbackHandler);
    pkgCoreApi = module.get(PkgCoreApiService);
    botService = module.get(BotService);
  });

  describe('canHandle', () => {
    it('should return true for car_p: prefix', () => {
      expect(handler.canHandle('car_p:c_abc123')).toBe(true);
    });

    it('should return true for car_n: prefix', () => {
      expect(handler.canHandle('car_n:c_abc123')).toBe(true);
    });

    it('should return true for car_c: prefix', () => {
      expect(handler.canHandle('car_c:c_abc123')).toBe(true);
    });

    it('should return true for car_r: prefix', () => {
      expect(handler.canHandle('car_r:c_abc123')).toBe(true);
    });

    it('should return false for unknown prefix', () => {
      expect(handler.canHandle('d_c:abc123')).toBe(false);
      expect(handler.canHandle('other:data')).toBe(false);
    });
  });

  describe('handle', () => {
    describe('navigation', () => {
      it('should call carouselPrev for car_p action', async () => {
        const ctx = createMockContext('car_p:c_test123');
        const response: CarouselNavResponse = {
          success: true,
          complete: false,
          message: 'Event card',
          buttons: [[{ text: '✅', callback_data: 'car_c:c_test123' }]],
        };
        pkgCoreApi.carouselPrev.mockResolvedValue(response);

        await handler.handle(ctx);

        expect(pkgCoreApi.carouselPrev).toHaveBeenCalledWith('c_test123');
        expect(ctx.editMessageText).toHaveBeenCalledWith(
          'Event card',
          expect.objectContaining({ parse_mode: 'HTML' }),
        );
        expect(ctx.answerCbQuery).toHaveBeenCalledWith('◀️');
      });

      it('should call carouselNext for car_n action', async () => {
        const ctx = createMockContext('car_n:c_test123');
        const response: CarouselNavResponse = {
          success: true,
          complete: false,
          message: 'Next event',
          buttons: [[{ text: '✅', callback_data: 'car_c:c_test123' }]],
        };
        pkgCoreApi.carouselNext.mockResolvedValue(response);

        await handler.handle(ctx);

        expect(pkgCoreApi.carouselNext).toHaveBeenCalledWith('c_test123');
        expect(ctx.answerCbQuery).toHaveBeenCalledWith('▶️');
      });
    });

    describe('actions', () => {
      it('should call carouselConfirm for car_c action', async () => {
        const ctx = createMockContext('car_c:c_test123');
        const response: CarouselNavResponse = {
          success: true,
          complete: false,
          message: 'Next event after confirm',
          buttons: [[{ text: '✅', callback_data: 'car_c:c_test123' }]],
        };
        pkgCoreApi.carouselConfirm.mockResolvedValue(response);

        await handler.handle(ctx);

        expect(pkgCoreApi.carouselConfirm).toHaveBeenCalledWith('c_test123');
        expect(ctx.answerCbQuery).toHaveBeenCalledWith('✅ Подтверждено');
      });

      it('should call carouselReject for car_r action', async () => {
        const ctx = createMockContext('car_r:c_test123');
        const response: CarouselNavResponse = {
          success: true,
          complete: false,
          message: 'Next event after reject',
          buttons: [[{ text: '✅', callback_data: 'car_c:c_test123' }]],
        };
        pkgCoreApi.carouselReject.mockResolvedValue(response);

        await handler.handle(ctx);

        expect(pkgCoreApi.carouselReject).toHaveBeenCalledWith('c_test123');
        expect(ctx.answerCbQuery).toHaveBeenCalledWith('❌ Отклонено');
      });
    });

    describe('completion', () => {
      it('should show completion message when carousel is complete', async () => {
        const ctx = createMockContext('car_c:c_test123');
        const response: CarouselNavResponse = {
          success: true,
          complete: true,
          message: 'Все события обработаны',
          processedCount: 5,
        };
        pkgCoreApi.carouselConfirm.mockResolvedValue(response);

        await handler.handle(ctx);

        expect(ctx.editMessageText).toHaveBeenCalledWith(
          'Все события обработаны',
          { parse_mode: 'HTML' },
        );
        expect(ctx.answerCbQuery).toHaveBeenCalledWith('Обработано 5 событий');
      });
    });

    describe('error handling', () => {
      it('should show error message on API failure', async () => {
        const ctx = createMockContext('car_n:c_test123');
        const response: CarouselNavResponse = {
          success: false,
          complete: false,
          error: 'Carousel expired',
        };
        pkgCoreApi.carouselNext.mockResolvedValue(response);

        await handler.handle(ctx);

        expect(ctx.answerCbQuery).toHaveBeenCalledWith('Carousel expired');
      });

      it('should handle API exception gracefully', async () => {
        const ctx = createMockContext('car_n:c_test123');
        pkgCoreApi.carouselNext.mockRejectedValue(new Error('Network error'));

        await handler.handle(ctx);

        expect(ctx.answerCbQuery).toHaveBeenCalledWith('Ошибка сервера');
      });

      it('should silently handle message not modified error', async () => {
        const ctx = createMockContext('car_n:c_test123');
        const error = new Error('Bad Request: message is not modified');
        pkgCoreApi.carouselNext.mockRejectedValue(error);

        await handler.handle(ctx);

        // Should just answer callback without error
        expect(ctx.answerCbQuery).toHaveBeenCalledWith();
      });

      it('should handle missing callback query', async () => {
        const ctx = { callbackQuery: undefined } as unknown as Context;

        await handler.handle(ctx);

        // Should not throw
      });

      it('should handle unknown action', async () => {
        const ctx = createMockContext('car_x:c_test123');

        await handler.handle(ctx);

        expect(ctx.answerCbQuery).toHaveBeenCalledWith('Unknown action');
      });
    });
  });

  function createMockContext(callbackData: string): Context {
    return {
      callbackQuery: {
        data: callbackData,
      },
      editMessageText: jest.fn().mockResolvedValue(undefined),
      answerCbQuery: jest.fn().mockResolvedValue(undefined),
    } as unknown as Context;
  }
});
