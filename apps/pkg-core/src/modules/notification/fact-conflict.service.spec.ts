import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EntityFact, EntityRecord, FactSource, FactCategory, FactType } from '@pkg/entities';
import { FactConflictService, FactConflictData } from './fact-conflict.service';
import { TelegramNotifierService } from './telegram-notifier.service';
import { DigestActionStoreService } from './digest-action-store.service';
import { CreateFactDto } from '../entity/dto/create-entity.dto';

describe('FactConflictService', () => {
  let service: FactConflictService;
  let mockTelegramNotifier: jest.Mocked<Partial<TelegramNotifierService>>;
  let mockDigestActionStore: jest.Mocked<Partial<DigestActionStoreService>>;
  let mockFactRepo: jest.Mocked<Partial<Repository<EntityFact>>>;
  let mockEntityRepo: jest.Mocked<Partial<Repository<EntityRecord>>>;

  const mockExistingFact: Partial<EntityFact> = {
    id: 'fact-123',
    entityId: 'entity-456',
    factType: FactType.POSITION,
    category: FactCategory.PROFESSIONAL,
    value: 'Работает в Сбербанке',
    source: FactSource.EXTRACTED,
    rank: 'normal',
    needsReview: false,
    confirmationCount: 1,
    createdAt: new Date('2025-01-15'),
  };

  const mockNewFactDto: CreateFactDto = {
    type: FactType.POSITION,
    category: FactCategory.PROFESSIONAL,
    value: 'Работает в Тинькофф',
    source: FactSource.EXTRACTED,
  };

  const mockEntity: Partial<EntityRecord> = {
    id: 'entity-456',
    name: 'Иван Петров',
  };

  beforeEach(async () => {
    mockTelegramNotifier = {
      sendWithButtons: jest.fn().mockResolvedValue(true),
    };

    mockDigestActionStore = {
      store: jest.fn().mockResolvedValue('d_abc123def456'),
      get: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    mockFactRepo = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      create: jest.fn().mockImplementation((dto) => ({ ...dto, id: 'new-fact-789' })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve({ ...entity, id: 'new-fact-789' })),
    };

    mockEntityRepo = {
      findOne: jest.fn().mockResolvedValue(mockEntity),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FactConflictService,
        {
          provide: TelegramNotifierService,
          useValue: mockTelegramNotifier,
        },
        {
          provide: DigestActionStoreService,
          useValue: mockDigestActionStore,
        },
        {
          provide: getRepositoryToken(EntityFact),
          useValue: mockFactRepo,
        },
        {
          provide: getRepositoryToken(EntityRecord),
          useValue: mockEntityRepo,
        },
      ],
    }).compile();

    service = module.get<FactConflictService>(FactConflictService);
  });

  describe('notifyConflict', () => {
    it('should send Telegram notification with buttons', async () => {
      const shortId = await service.notifyConflict(
        mockExistingFact as EntityFact,
        mockNewFactDto,
        'entity-456',
        'Противоречивые факты о месте работы',
      );

      expect(shortId).toBe('d_abc123def456');
      expect(mockDigestActionStore.store).toHaveBeenCalledTimes(1);
      expect(mockTelegramNotifier.sendWithButtons).toHaveBeenCalledTimes(1);

      // Check buttons format (using standardized short prefixes)
      const [message, buttons, parseMode] = (mockTelegramNotifier.sendWithButtons as jest.Mock).mock.calls[0];
      expect(parseMode).toBe('HTML');
      expect(buttons).toHaveLength(1);
      expect(buttons[0]).toHaveLength(3);
      expect(buttons[0][0].text).toBe('✅ Новый');
      expect(buttons[0][0].callback_data).toBe('f_n:d_abc123def456');
      expect(buttons[0][1].text).toBe('❌ Старый');
      expect(buttons[0][1].callback_data).toBe('f_o:d_abc123def456');
      expect(buttons[0][2].text).toBe('🔀 Оба');
      expect(buttons[0][2].callback_data).toBe('f_b:d_abc123def456');
    });

    it('should format message with entity name and fact values', async () => {
      await service.notifyConflict(
        mockExistingFact as EntityFact,
        mockNewFactDto,
        'entity-456',
        'Разные компании',
      );

      const [message] = (mockTelegramNotifier.sendWithButtons as jest.Mock).mock.calls[0];
      expect(message).toContain('Иван Петров');
      expect(message).toContain('Работает в Сбербанке');
      expect(message).toContain('Работает в Тинькофф');
      expect(message).toContain('position');
    });
  });

  describe('resolveConflict', () => {
    const mockConflictData: FactConflictData = {
      existingFactId: 'fact-123',
      newFactData: mockNewFactDto,
      entityId: 'entity-456',
      entityName: 'Иван Петров',
    };

    beforeEach(() => {
      mockDigestActionStore.get = jest.fn().mockResolvedValue([JSON.stringify(mockConflictData)]);
      mockFactRepo.findOne = jest.fn().mockResolvedValue(mockExistingFact);
    });

    it('should return error if shortId not found', async () => {
      mockDigestActionStore.get = jest.fn().mockResolvedValue(null);

      const result = await service.resolveConflict('invalid', 'new');

      expect(result.success).toBe(false);
      expect(result.error).toContain('не найдены');
    });

    describe('resolution: new', () => {
      it('should create new fact and deprecate old', async () => {
        const result = await service.resolveConflict('d_abc123def456', 'new');

        expect(result.success).toBe(true);
        expect(result.action).toBe('used_new');
        expect(result.factId).toBe('new-fact-789');

        // Check that old fact is deprecated
        expect(mockFactRepo.update).toHaveBeenCalledWith('fact-123', expect.objectContaining({
          rank: 'deprecated',
          needsReview: false,
        }));

        // Check that new fact is created with preferred rank
        expect(mockFactRepo.create).toHaveBeenCalledWith(expect.objectContaining({
          rank: 'preferred',
        }));

        // Check cleanup
        expect(mockDigestActionStore.delete).toHaveBeenCalledWith('d_abc123def456');
      });
    });

    describe('resolution: old', () => {
      it('should keep old fact and increase confirmation', async () => {
        const result = await service.resolveConflict('d_abc123def456', 'old');

        expect(result.success).toBe(true);
        expect(result.action).toBe('kept_old');
        expect(result.factId).toBe('fact-123');

        // Check that old fact is updated
        expect(mockFactRepo.update).toHaveBeenCalledWith('fact-123', expect.objectContaining({
          needsReview: false,
          confirmationCount: 2,
        }));

        // Check cleanup
        expect(mockDigestActionStore.delete).toHaveBeenCalledWith('d_abc123def456');
      });
    });

    describe('resolution: both', () => {
      it('should keep both facts', async () => {
        const result = await service.resolveConflict('d_abc123def456', 'both');

        expect(result.success).toBe(true);
        expect(result.action).toBe('created_both');
        expect(result.factId).toBe('new-fact-789');

        // Check that old fact review flag is cleared
        expect(mockFactRepo.update).toHaveBeenCalledWith('fact-123', expect.objectContaining({
          needsReview: false,
        }));

        // Check that new fact is created with normal rank
        expect(mockFactRepo.create).toHaveBeenCalledWith(expect.objectContaining({
          rank: 'normal',
        }));

        // Check cleanup
        expect(mockDigestActionStore.delete).toHaveBeenCalledWith('d_abc123def456');
      });
    });
  });
});
