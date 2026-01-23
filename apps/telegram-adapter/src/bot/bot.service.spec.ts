import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BotService } from './bot.service';
import { RecallHandler } from './handlers/recall.handler';
import { PrepareHandler } from './handlers/prepare.handler';
import { ActHandler } from './handlers/act.handler';
import { DigestHandler } from './handlers/digest.handler';
import { EventCallbackHandler } from './handlers/event-callback.handler';
import { CarouselCallbackHandler } from './handlers/carousel-callback.handler';
import { ApprovalCallbackHandler } from './handlers/approval-callback.handler';
import { BriefCallbackHandler } from './handlers/brief-callback.handler';

// Mock Telegraf
jest.mock('telegraf', () => ({
  Telegraf: jest.fn().mockImplementation(() => ({
    use: jest.fn(),
    start: jest.fn(),
    help: jest.fn(),
    command: jest.fn(),
    on: jest.fn(),
    catch: jest.fn(),
    launch: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn(),
    telegram: {
      setMyCommands: jest.fn().mockResolvedValue(undefined),
    },
  })),
}));

describe('BotService', () => {
  let service: BotService;
  let configService: jest.Mocked<ConfigService>;

  const mockRecallHandler = { handle: jest.fn() };
  const mockPrepareHandler = { handle: jest.fn() };
  const mockActHandler = { handle: jest.fn() };
  const mockDigestHandler = {
    handleMorning: jest.fn(),
    handleDigest: jest.fn(),
    handleDaily: jest.fn(),
  };
  const mockEventCallbackHandler = { canHandle: jest.fn(), handle: jest.fn() };
  const mockCarouselCallbackHandler = { canHandle: jest.fn(), handle: jest.fn() };
  const mockApprovalCallbackHandler = {
    canHandle: jest.fn(),
    handle: jest.fn(),
    isInEditMode: jest.fn(),
    handleTextMessage: jest.fn(),
  };
  const mockBriefCallbackHandler = { canHandle: jest.fn(), handle: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BotService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
        {
          provide: RecallHandler,
          useValue: mockRecallHandler,
        },
        {
          provide: PrepareHandler,
          useValue: mockPrepareHandler,
        },
        {
          provide: ActHandler,
          useValue: mockActHandler,
        },
        {
          provide: DigestHandler,
          useValue: mockDigestHandler,
        },
        {
          provide: EventCallbackHandler,
          useValue: mockEventCallbackHandler,
        },
        {
          provide: CarouselCallbackHandler,
          useValue: mockCarouselCallbackHandler,
        },
        {
          provide: ApprovalCallbackHandler,
          useValue: mockApprovalCallbackHandler,
        },
        {
          provide: BriefCallbackHandler,
          useValue: mockBriefCallbackHandler,
        },
      ],
    }).compile();

    service = module.get<BotService>(BotService);
    configService = module.get(ConfigService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('should not start bot when token is not configured', async () => {
      configService.get.mockReturnValue(undefined);

      await service.onModuleInit();

      // Bot should not be initialized
      expect(service['bot']).toBeNull();
    });

    it('should warn when no allowed users configured', async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === 'telegram.botToken') return 'test-token';
        if (key === 'telegram.allowedUsers') return [];
        return undefined;
      });

      const warnSpy = jest.spyOn(service['logger'], 'warn');

      await service.onModuleInit();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('TELEGRAM_BOT_ALLOWED_USERS not configured'),
      );
    });

    it('should log allowed users count when configured', async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === 'telegram.botToken') return 'test-token';
        if (key === 'telegram.allowedUsers') return [123456, 789012];
        return undefined;
      });

      const logSpy = jest.spyOn(service['logger'], 'log');

      await service.onModuleInit();

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Bot access restricted to 2 user(s)'),
      );
    });
  });

  describe('authorization middleware', () => {
    // Test the middleware logic directly
    it('should store allowed users from config', async () => {
      const allowedUsers = [864381617, 123456789];
      configService.get.mockImplementation((key: string) => {
        if (key === 'telegram.botToken') return 'test-token';
        if (key === 'telegram.allowedUsers') return allowedUsers;
        return undefined;
      });

      await service.onModuleInit();

      expect(service['allowedUsers']).toEqual(allowedUsers);
    });

    it('should default to empty array when allowedUsers not set', async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === 'telegram.botToken') return 'test-token';
        if (key === 'telegram.allowedUsers') return undefined;
        return undefined;
      });

      await service.onModuleInit();

      expect(service['allowedUsers']).toEqual([]);
    });
  });
});
