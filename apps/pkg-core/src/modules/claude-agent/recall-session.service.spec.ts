import { Test, TestingModule } from '@nestjs/testing';
import { RecallSessionService, RecallSession } from './recall-session.service';

// Mock ioredis injection token (matches @nestjs-modules/ioredis default)
const IOREDIS_TOKEN = 'default_IORedisModuleConnectionToken';

describe('RecallSessionService', () => {
  let service: RecallSessionService;
  let mockRedis: {
    setex: jest.Mock;
    get: jest.Mock;
    del: jest.Mock;
    eval: jest.Mock;
  };

  const mockSession: RecallSession = {
    id: 'rs_test123456',
    query: 'test query',
    dateStr: '2026-01-30',
    answer: 'Test answer',
    sources: [{ type: 'message', id: 'msg-uuid', preview: 'preview' }],
    model: 'sonnet',
    userId: 'user123',
    createdAt: Date.now(),
  };

  beforeEach(async () => {
    mockRedis = {
      setex: jest.fn().mockResolvedValue('OK'),
      get: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
      eval: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecallSessionService,
        {
          provide: IOREDIS_TOKEN,
          useValue: mockRedis,
        },
      ],
    }).compile();

    service = module.get<RecallSessionService>(RecallSessionService);

    // Manually call onModuleInit to load Lua scripts
    service.onModuleInit();
  });

  describe('create', () => {
    it('should create session and return ID', async () => {
      const sessionId = await service.create({
        query: 'test query',
        dateStr: '2026-01-30',
        answer: 'Test answer',
        sources: [],
        model: 'sonnet',
        userId: 'user123',
      });

      expect(sessionId).toMatch(/^rs_[a-f0-9]{12}$/);
      expect(mockRedis.setex).toHaveBeenCalledWith(
        `recall-session:${sessionId}`,
        86400,
        expect.any(String),
      );
    });
  });

  describe('get', () => {
    it('should return session if found', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(mockSession));

      const result = await service.get('rs_test123456');

      expect(result).toEqual(mockSession);
    });

    it('should return null if not found', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await service.get('rs_nonexistent');

      expect(result).toBeNull();
    });

    it('should return null and delete corrupted data', async () => {
      mockRedis.get.mockResolvedValue('invalid json {{{');

      const result = await service.get('rs_corrupted');

      expect(result).toBeNull();
      expect(mockRedis.del).toHaveBeenCalled();
    });
  });

  describe('verifyUser', () => {
    it('should return true when userId matches', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(mockSession));

      const result = await service.verifyUser('rs_test123456', 'user123');

      expect(result).toBe(true);
    });

    it('should return false when userId does not match', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(mockSession));

      const result = await service.verifyUser('rs_test123456', 'other_user');

      expect(result).toBe(false);
    });

    it('should return true when session has no userId (backward compatibility)', async () => {
      const sessionNoUser = { ...mockSession, userId: undefined };
      mockRedis.get.mockResolvedValue(JSON.stringify(sessionNoUser));

      const result = await service.verifyUser('rs_test123456', 'any_user');

      expect(result).toBe(true);
    });

    it('should return false when session not found', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await service.verifyUser('rs_nonexistent', 'user123');

      expect(result).toBe(false);
    });
  });

  describe('markAsSaved', () => {
    const factId = 'fact-uuid-123';

    it('should mark session as saved successfully', async () => {
      mockRedis.eval.mockResolvedValue(JSON.stringify({ success: true }));

      const result = await service.markAsSaved('rs_test123456', factId, 'user123');

      expect(result).toEqual({ success: true, alreadySaved: false });
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining('savedAt'),
        1,
        'recall-session:rs_test123456',
        factId,
        'user123',
        '86400',
        expect.any(String),
      );
    });

    it('should return alreadySaved when session was already saved', async () => {
      const existingFactId = 'existing-fact-uuid';
      mockRedis.eval.mockResolvedValue(
        JSON.stringify({ alreadySaved: true, existingFactId }),
      );

      const result = await service.markAsSaved('rs_test123456', factId, 'user123');

      expect(result).toEqual({
        success: false,
        alreadySaved: true,
        existingFactId,
      });
    });

    it('should return failure when session not found', async () => {
      mockRedis.eval.mockResolvedValue(
        JSON.stringify({ error: 'not_found' }),
      );

      const result = await service.markAsSaved('rs_nonexistent', factId);

      expect(result).toEqual({ success: false, alreadySaved: false });
    });

    it('should return failure when userId unauthorized', async () => {
      mockRedis.eval.mockResolvedValue(
        JSON.stringify({ error: 'unauthorized' }),
      );

      const result = await service.markAsSaved('rs_test123456', factId, 'wrong_user');

      expect(result).toEqual({ success: false, alreadySaved: false });
    });
  });

  describe('updateAnswer', () => {
    it('should update answer successfully', async () => {
      const updatedSession = { ...mockSession, answer: 'Updated answer' };
      mockRedis.eval.mockResolvedValue(JSON.stringify(updatedSession));

      const result = await service.updateAnswer(
        'rs_test123456',
        'Updated answer',
        undefined,
        'user123',
      );

      expect(result).toEqual(updatedSession);
    });

    it('should return null when session not found', async () => {
      mockRedis.eval.mockResolvedValue(null);

      const result = await service.updateAnswer('rs_nonexistent', 'Updated');

      expect(result).toBeNull();
    });

    it('should return null when userId unauthorized', async () => {
      mockRedis.eval.mockResolvedValue(
        JSON.stringify({ error: 'unauthorized' }),
      );

      const result = await service.updateAnswer(
        'rs_test123456',
        'Updated',
        undefined,
        'wrong_user',
      );

      expect(result).toBeNull();
    });

    it('should update sources when provided', async () => {
      const newSources = [{ type: 'message' as const, id: 'new-id', preview: 'new' }];
      const updatedSession = { ...mockSession, sources: newSources };
      mockRedis.eval.mockResolvedValue(JSON.stringify(updatedSession));

      const result = await service.updateAnswer(
        'rs_test123456',
        'Updated',
        newSources,
        'user123',
      );

      expect(result?.sources).toEqual(newSources);
    });
  });

  describe('delete', () => {
    it('should delete session', async () => {
      await service.delete('rs_test123456');

      expect(mockRedis.del).toHaveBeenCalledWith('recall-session:rs_test123456');
    });
  });
});
