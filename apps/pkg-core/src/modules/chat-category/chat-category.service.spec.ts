import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { ChatCategoryRecord, ChatCategory } from '@pkg/entities';
import { ChatCategoryService } from './chat-category.service';
import { SettingsService } from '../settings/settings.service';

describe('ChatCategoryService', () => {
  let service: ChatCategoryService;
  let repo: jest.Mocked<Repository<ChatCategoryRecord>>;
  let settingsService: jest.Mocked<SettingsService>;

  const mockRepo = {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockSettingsService = {
    getValue: jest.fn(),
  };

  const mockHttpService = {
    get: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn().mockReturnValue('http://localhost:3001'),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatCategoryService,
        {
          provide: getRepositoryToken(ChatCategoryRecord),
          useValue: mockRepo,
        },
        {
          provide: SettingsService,
          useValue: mockSettingsService,
        },
        {
          provide: HttpService,
          useValue: mockHttpService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<ChatCategoryService>(ChatCategoryService);
    repo = module.get(getRepositoryToken(ChatCategoryRecord));
    settingsService = module.get(SettingsService);

    jest.clearAllMocks();
    mockSettingsService.getValue.mockResolvedValue(20); // default threshold
  });

  describe('determineCategory', () => {
    it('should return PERSONAL for private chats', async () => {
      const result = await service.determineCategory('private', 2);
      expect(result).toBe(ChatCategory.PERSONAL);
    });

    it('should return PERSONAL for private chats even with null count', async () => {
      const result = await service.determineCategory('private', null);
      expect(result).toBe(ChatCategory.PERSONAL);
    });

    it('should return WORKING for small groups (<=20)', async () => {
      const result = await service.determineCategory('group', 10);
      expect(result).toBe(ChatCategory.WORKING);
    });

    it('should return WORKING for groups exactly at threshold', async () => {
      const result = await service.determineCategory('group', 20);
      expect(result).toBe(ChatCategory.WORKING);
    });

    it('should return MASS for large groups (>20)', async () => {
      const result = await service.determineCategory('group', 21);
      expect(result).toBe(ChatCategory.MASS);
    });

    it('should return MASS for groups with unknown participant count', async () => {
      const result = await service.determineCategory('group', null);
      expect(result).toBe(ChatCategory.MASS);
    });

    it('should return MASS for groups with undefined participant count', async () => {
      const result = await service.determineCategory('group', undefined);
      expect(result).toBe(ChatCategory.MASS);
    });

    it('should return WORKING for small supergroups', async () => {
      const result = await service.determineCategory('supergroup', 15);
      expect(result).toBe(ChatCategory.WORKING);
    });

    it('should return MASS for large supergroups', async () => {
      const result = await service.determineCategory('supergroup', 100);
      expect(result).toBe(ChatCategory.MASS);
    });

    it('should return WORKING for forum chats with few participants', async () => {
      const result = await service.determineCategory('forum', 5);
      expect(result).toBe(ChatCategory.WORKING);
    });

    it('should return MASS for forum chats with many participants', async () => {
      const result = await service.determineCategory('forum', 500);
      expect(result).toBe(ChatCategory.MASS);
    });

    it('should return MASS for channels', async () => {
      const result = await service.determineCategory('channel', 1000);
      expect(result).toBe(ChatCategory.MASS);
    });

    it('should respect custom threshold from settings', async () => {
      mockSettingsService.getValue.mockResolvedValue(10);

      const result1 = await service.determineCategory('group', 10);
      expect(result1).toBe(ChatCategory.WORKING);

      const result2 = await service.determineCategory('group', 11);
      expect(result2).toBe(ChatCategory.MASS);
    });
  });

  describe('categorize', () => {
    it('should return existing category if found', async () => {
      const existingRecord = {
        id: '123',
        telegramChatId: 'chat-123',
        category: ChatCategory.PERSONAL,
        autoExtractionEnabled: true,
        participantsCount: 2,
      };
      mockRepo.findOne.mockResolvedValue(existingRecord);

      const result = await service.categorize({
        telegramChatId: 'chat-123',
        chatType: 'private',
        participantsCount: 2,
      });

      expect(result.category).toBe(ChatCategory.PERSONAL);
      expect(result.autoExtractionEnabled).toBe(true);
      expect(result.isNew).toBe(false);
      expect(mockRepo.create).not.toHaveBeenCalled();
    });

    it('should create new category record for new chat', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      mockRepo.create.mockReturnValue({
        telegramChatId: 'new-chat',
        category: ChatCategory.PERSONAL,
        autoExtractionEnabled: true,
        participantsCount: 2,
      });
      mockRepo.save.mockResolvedValue({
        id: 'new-id',
        telegramChatId: 'new-chat',
        category: ChatCategory.PERSONAL,
        autoExtractionEnabled: true,
        participantsCount: 2,
      });

      const result = await service.categorize({
        telegramChatId: 'new-chat',
        chatType: 'private',
        participantsCount: 2,
      });

      expect(result.category).toBe(ChatCategory.PERSONAL);
      expect(result.isNew).toBe(true);
      expect(mockRepo.create).toHaveBeenCalled();
      expect(mockRepo.save).toHaveBeenCalled();
    });

    it('should create WORKING category for small group', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      mockRepo.create.mockImplementation((data) => ({
        ...data,
        autoExtractionEnabled: data.category !== ChatCategory.MASS,
      }));
      mockRepo.save.mockImplementation((data) => Promise.resolve({ id: 'new-id', ...data }));

      const result = await service.categorize({
        telegramChatId: 'small-group',
        chatType: 'group',
        participantsCount: 10,
      });

      expect(result.category).toBe(ChatCategory.WORKING);
      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          category: ChatCategory.WORKING,
          participantsCount: 10,
        })
      );
    });

    it('should create MASS category for large group', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      mockRepo.create.mockImplementation((data) => ({
        ...data,
        autoExtractionEnabled: data.category !== ChatCategory.MASS,
      }));
      mockRepo.save.mockImplementation((data) => Promise.resolve({ id: 'new-id', ...data }));

      const result = await service.categorize({
        telegramChatId: 'large-group',
        chatType: 'group',
        participantsCount: 100,
      });

      expect(result.category).toBe(ChatCategory.MASS);
    });
  });

  describe('updateParticipantsCount', () => {
    it('should return null if chat not found', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      const result = await service.updateParticipantsCount('unknown-chat', 50);

      expect(result).toBeNull();
    });

    it('should update count without changing PERSONAL category', async () => {
      const existingRecord = {
        id: '123',
        telegramChatId: 'chat-123',
        category: ChatCategory.PERSONAL,
        participantsCount: 2,
        autoExtractionEnabled: true,
      };
      mockRepo.findOne.mockResolvedValue(existingRecord);
      mockRepo.save.mockResolvedValue(existingRecord);

      const result = await service.updateParticipantsCount('chat-123', 3);

      expect(result?.category).toBe(ChatCategory.PERSONAL);
      expect(existingRecord.participantsCount).toBe(3);
    });

    it('should change category from WORKING to MASS when count increases', async () => {
      const existingRecord = {
        id: '123',
        telegramChatId: 'chat-123',
        category: ChatCategory.WORKING,
        participantsCount: 15,
        autoExtractionEnabled: true,
      };
      mockRepo.findOne.mockResolvedValue(existingRecord);
      mockRepo.save.mockResolvedValue(existingRecord);

      const result = await service.updateParticipantsCount('chat-123', 25);

      expect(result?.category).toBe(ChatCategory.MASS);
      expect(existingRecord.category).toBe(ChatCategory.MASS);
    });

    it('should change category from MASS to WORKING when count decreases', async () => {
      const existingRecord = {
        id: '123',
        telegramChatId: 'chat-123',
        category: ChatCategory.MASS,
        participantsCount: 50,
        autoExtractionEnabled: false,
      };
      mockRepo.findOne.mockResolvedValue(existingRecord);
      mockRepo.save.mockResolvedValue(existingRecord);

      const result = await service.updateParticipantsCount('chat-123', 15);

      expect(result?.category).toBe(ChatCategory.WORKING);
      expect(existingRecord.category).toBe(ChatCategory.WORKING);
    });

    it('should not change category if still within same range', async () => {
      const existingRecord = {
        id: '123',
        telegramChatId: 'chat-123',
        category: ChatCategory.WORKING,
        participantsCount: 10,
        autoExtractionEnabled: true,
      };
      mockRepo.findOne.mockResolvedValue(existingRecord);
      mockRepo.save.mockResolvedValue(existingRecord);

      const result = await service.updateParticipantsCount('chat-123', 15);

      expect(result?.category).toBe(ChatCategory.WORKING);
    });

    it('should NOT recategorize when isManualOverride is true', async () => {
      const existingRecord = {
        id: '123',
        telegramChatId: 'chat-123',
        category: ChatCategory.PERSONAL,
        participantsCount: 5,
        autoExtractionEnabled: true,
        isManualOverride: true,
      };
      mockRepo.findOne.mockResolvedValue(existingRecord);
      mockRepo.save.mockResolvedValue(existingRecord);

      // Try to update with count that would normally trigger MASS category
      const result = await service.updateParticipantsCount('chat-123', 100);

      // Category should remain PERSONAL because isManualOverride = true
      expect(result?.category).toBe(ChatCategory.PERSONAL);
      expect(existingRecord.category).toBe(ChatCategory.PERSONAL);
      expect(existingRecord.participantsCount).toBe(100); // Count still updated
    });
  });

  describe('updateCategory (manual override)', () => {
    it('should update category and set isManualOverride to true', async () => {
      const existingRecord = {
        id: '123',
        telegramChatId: 'chat-123',
        category: ChatCategory.MASS,
        participantsCount: 100,
        autoExtractionEnabled: false,
        isManualOverride: false,
      };
      mockRepo.findOne.mockResolvedValue(existingRecord);
      mockRepo.save.mockImplementation((record) => Promise.resolve(record));

      const result = await service.updateCategory('chat-123', ChatCategory.PERSONAL);

      expect(result.category).toBe(ChatCategory.PERSONAL);
      expect(result.isManualOverride).toBe(true);
      expect(mockRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          category: ChatCategory.PERSONAL,
          isManualOverride: true,
        }),
      );
    });

    it('should create new record with isManualOverride = true if chat not exists', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      mockRepo.create.mockImplementation((data) => ({
        id: 'new-id',
        ...data,
      }));
      mockRepo.save.mockImplementation((record) => Promise.resolve(record));

      const result = await service.updateCategory('new-chat', ChatCategory.WORKING);

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          telegramChatId: 'new-chat',
          category: ChatCategory.WORKING,
          isManualOverride: true,
        }),
      );
      expect(result.isManualOverride).toBe(true);
    });
  });

  describe('resetManualOverride', () => {
    it('should reset isManualOverride to false', async () => {
      const existingRecord = {
        id: '123',
        telegramChatId: 'chat-123',
        category: ChatCategory.PERSONAL,
        isManualOverride: true,
      };
      mockRepo.findOne.mockResolvedValue(existingRecord);
      mockRepo.save.mockImplementation((record) => Promise.resolve(record));

      const result = await service.resetManualOverride('chat-123');

      expect(result?.isManualOverride).toBe(false);
      expect(mockRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ isManualOverride: false }),
      );
    });

    it('should return null if chat not found', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      const result = await service.resetManualOverride('unknown-chat');

      expect(result).toBeNull();
      expect(mockRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('isAutoExtractionEnabled', () => {
    it('should return true for PERSONAL chats', async () => {
      mockRepo.findOne.mockResolvedValue({
        category: ChatCategory.PERSONAL,
        autoExtractionEnabled: true,
      });

      const result = await service.isAutoExtractionEnabled('chat-123');
      expect(result).toBe(true);
    });

    it('should return true for WORKING chats', async () => {
      mockRepo.findOne.mockResolvedValue({
        category: ChatCategory.WORKING,
        autoExtractionEnabled: true,
      });

      const result = await service.isAutoExtractionEnabled('chat-123');
      expect(result).toBe(true);
    });

    it('should return false for MASS chats', async () => {
      mockRepo.findOne.mockResolvedValue({
        category: ChatCategory.MASS,
        autoExtractionEnabled: false,
      });

      const result = await service.isAutoExtractionEnabled('chat-123');
      expect(result).toBe(false);
    });

    it('should return false for unknown chats', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      const result = await service.isAutoExtractionEnabled('unknown-chat');
      expect(result).toBe(false);
    });
  });

  describe('getStats', () => {
    it('should return category statistics', async () => {
      const mockQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { category: ChatCategory.PERSONAL, count: '10' },
          { category: ChatCategory.WORKING, count: '5' },
          { category: ChatCategory.MASS, count: '3' },
        ]),
      };
      mockRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder as any);

      const result = await service.getStats();

      expect(result.total).toBe(18);
      expect(result.personal).toBe(10);
      expect(result.working).toBe(5);
      expect(result.mass).toBe(3);
    });

    it('should handle empty statistics', async () => {
      const mockQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      mockRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder as any);

      const result = await service.getStats();

      expect(result.total).toBe(0);
      expect(result.personal).toBe(0);
      expect(result.working).toBe(0);
      expect(result.mass).toBe(0);
    });
  });
});
