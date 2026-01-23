import { Test, TestingModule } from '@nestjs/testing';
import { BriefStateService, BriefItem, BriefState } from './brief-state.service';

// Mock ioredis injection token
const IOREDIS_TOKEN = 'default_IORedisModuleConnectionToken';

describe('BriefStateService', () => {
  let service: BriefStateService;
  let mockRedis: Record<string, jest.Mock>;

  const createMockItem = (index: number, type: BriefItem['type'] = 'task'): BriefItem => ({
    type,
    title: `Task ${index}`,
    entityName: `Person ${index}`,
    sourceType: 'entity_event',
    sourceId: `event-uuid-${index}`,
    details: `Details for task ${index}`,
    entityId: `entity-uuid-${index}`,
  });

  beforeEach(async () => {
    mockRedis = {
      setex: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BriefStateService,
        {
          provide: IOREDIS_TOKEN,
          useValue: mockRedis,
        },
      ],
    }).compile();

    service = module.get<BriefStateService>(BriefStateService);
  });

  describe('create', () => {
    it('should create brief and return ID', async () => {
      const items = [createMockItem(1), createMockItem(2)];

      const briefId = await service.create('123456', 789, items);

      expect(briefId).toMatch(/^b_[a-f0-9]{12}$/);
      expect(mockRedis.setex).toHaveBeenCalledTimes(1);

      const [key, ttl, data] = mockRedis.setex.mock.calls[0];
      expect(key).toBe(`brief:${briefId}`);
      expect(ttl).toBe(172800); // 48 hours
      const state = JSON.parse(data) as BriefState;
      expect(state.items).toHaveLength(2);
      expect(state.expandedIndex).toBeNull();
    });

    it('should throw error for empty item list', async () => {
      await expect(service.create('123456', 789, [])).rejects.toThrow(
        'Cannot create brief with empty item list',
      );
    });

    it('should limit items to 10', async () => {
      const items = Array.from({ length: 15 }, (_, i) => createMockItem(i));

      await service.create('123456', 789, items);

      const [, , data] = mockRedis.setex.mock.calls[0];
      const state = JSON.parse(data) as BriefState;
      expect(state.items).toHaveLength(10);
    });
  });

  describe('get', () => {
    it('should return brief state if exists', async () => {
      const state: BriefState = {
        id: 'b_test123456ab',
        chatId: '123456',
        messageId: 789,
        items: [createMockItem(1)],
        expandedIndex: null,
        createdAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(state));

      const result = await service.get('b_test123456ab');

      expect(result).toEqual(state);
    });

    it('should return null if not found', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await service.get('b_nonexistent');

      expect(result).toBeNull();
    });

    it('should return null on parse error', async () => {
      mockRedis.get.mockResolvedValue('invalid json');

      const result = await service.get('b_test123456ab');

      expect(result).toBeNull();
    });

    it('should delete corrupted data on parse error', async () => {
      mockRedis.get.mockResolvedValue('invalid json {{{');

      await service.get('b_test123456ab');

      expect(mockRedis.del).toHaveBeenCalledWith('brief:b_test123456ab');
    });
  });

  describe('expand', () => {
    it('should expand item at given index', async () => {
      const state: BriefState = {
        id: 'b_test123456ab',
        chatId: '123456',
        messageId: 789,
        items: [createMockItem(1), createMockItem(2), createMockItem(3)],
        expandedIndex: null,
        createdAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(state));

      const result = await service.expand('b_test123456ab', 1);

      expect(result?.expandedIndex).toBe(1);
      expect(mockRedis.setex).toHaveBeenCalled();
    });

    it('should return null if brief not found', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await service.expand('b_nonexistent', 0);

      expect(result).toBeNull();
    });

    it('should not change state for invalid index', async () => {
      const state: BriefState = {
        id: 'b_test123456ab',
        chatId: '123456',
        messageId: 789,
        items: [createMockItem(1)],
        expandedIndex: null,
        createdAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(state));

      const result = await service.expand('b_test123456ab', 5);

      expect(result?.expandedIndex).toBeNull();
    });

    it('should handle negative index', async () => {
      const state: BriefState = {
        id: 'b_test123456ab',
        chatId: '123456',
        messageId: 789,
        items: [createMockItem(1)],
        expandedIndex: null,
        createdAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(state));

      const result = await service.expand('b_test123456ab', -1);

      expect(result?.expandedIndex).toBeNull();
    });
  });

  describe('collapse', () => {
    it('should collapse all items', async () => {
      const state: BriefState = {
        id: 'b_test123456ab',
        chatId: '123456',
        messageId: 789,
        items: [createMockItem(1), createMockItem(2)],
        expandedIndex: 1,
        createdAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(state));

      const result = await service.collapse('b_test123456ab');

      expect(result?.expandedIndex).toBeNull();
    });

    it('should return null if brief not found', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await service.collapse('b_nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('removeItem', () => {
    it('should remove item at given index', async () => {
      const state: BriefState = {
        id: 'b_test123456ab',
        chatId: '123456',
        messageId: 789,
        items: [createMockItem(1), createMockItem(2), createMockItem(3)],
        expandedIndex: null,
        createdAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(state));

      const result = await service.removeItem('b_test123456ab', 1);

      expect(result?.items).toHaveLength(2);
      expect(result?.items[0].title).toBe('Task 1');
      expect(result?.items[1].title).toBe('Task 3');
    });

    it('should collapse if removed item was expanded', async () => {
      const state: BriefState = {
        id: 'b_test123456ab',
        chatId: '123456',
        messageId: 789,
        items: [createMockItem(1), createMockItem(2), createMockItem(3)],
        expandedIndex: 1,
        createdAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(state));

      const result = await service.removeItem('b_test123456ab', 1);

      expect(result?.expandedIndex).toBeNull();
    });

    it('should shift expanded index if removed item was before expanded', async () => {
      const state: BriefState = {
        id: 'b_test123456ab',
        chatId: '123456',
        messageId: 789,
        items: [createMockItem(1), createMockItem(2), createMockItem(3)],
        expandedIndex: 2,
        createdAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(state));

      const result = await service.removeItem('b_test123456ab', 0);

      expect(result?.expandedIndex).toBe(1);
    });

    it('should not change expanded index if removed item was after expanded', async () => {
      const state: BriefState = {
        id: 'b_test123456ab',
        chatId: '123456',
        messageId: 789,
        items: [createMockItem(1), createMockItem(2), createMockItem(3)],
        expandedIndex: 0,
        createdAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(state));

      const result = await service.removeItem('b_test123456ab', 2);

      expect(result?.expandedIndex).toBe(0);
    });

    it('should return null if brief not found', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await service.removeItem('b_nonexistent', 0);

      expect(result).toBeNull();
    });

    it('should not change state for invalid index', async () => {
      const state: BriefState = {
        id: 'b_test123456ab',
        chatId: '123456',
        messageId: 789,
        items: [createMockItem(1)],
        expandedIndex: null,
        createdAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(state));

      const result = await service.removeItem('b_test123456ab', 5);

      expect(result?.items).toHaveLength(1);
    });
  });

  describe('getItem', () => {
    it('should return item at given index', async () => {
      const items = [createMockItem(1), createMockItem(2)];
      const state: BriefState = {
        id: 'b_test123456ab',
        chatId: '123456',
        messageId: 789,
        items,
        expandedIndex: null,
        createdAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(state));

      const result = await service.getItem('b_test123456ab', 1);

      expect(result).toEqual(items[1]);
    });

    it('should return null if brief not found', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await service.getItem('b_nonexistent', 0);

      expect(result).toBeNull();
    });

    it('should return null for invalid index', async () => {
      const state: BriefState = {
        id: 'b_test123456ab',
        chatId: '123456',
        messageId: 789,
        items: [createMockItem(1)],
        expandedIndex: null,
        createdAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(state));

      const result = await service.getItem('b_test123456ab', 5);

      expect(result).toBeNull();
    });
  });

  describe('updateMessageId', () => {
    it('should update message ID', async () => {
      const state: BriefState = {
        id: 'b_test123456ab',
        chatId: '123456',
        messageId: 0,
        items: [createMockItem(1)],
        expandedIndex: null,
        createdAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(state));

      await service.updateMessageId('b_test123456ab', 999);

      const [, , data] = mockRedis.setex.mock.calls[0];
      const updatedState = JSON.parse(data) as BriefState;
      expect(updatedState.messageId).toBe(999);
    });

    it('should do nothing if brief not found', async () => {
      mockRedis.get.mockResolvedValue(null);

      await service.updateMessageId('b_nonexistent', 999);

      expect(mockRedis.setex).not.toHaveBeenCalled();
    });
  });

  describe('isEmpty', () => {
    it('should return true if no items', async () => {
      const state: BriefState = {
        id: 'b_test123456ab',
        chatId: '123456',
        messageId: 789,
        items: [],
        expandedIndex: null,
        createdAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(state));

      const result = await service.isEmpty('b_test123456ab');

      expect(result).toBe(true);
    });

    it('should return false if has items', async () => {
      const state: BriefState = {
        id: 'b_test123456ab',
        chatId: '123456',
        messageId: 789,
        items: [createMockItem(1)],
        expandedIndex: null,
        createdAt: Date.now(),
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(state));

      const result = await service.isEmpty('b_test123456ab');

      expect(result).toBe(false);
    });

    it('should return true if brief not found', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await service.isEmpty('b_nonexistent');

      expect(result).toBe(true);
    });
  });

  describe('delete', () => {
    it('should delete brief from Redis', async () => {
      await service.delete('b_test123456ab');

      expect(mockRedis.del).toHaveBeenCalledWith('brief:b_test123456ab');
    });
  });
});
