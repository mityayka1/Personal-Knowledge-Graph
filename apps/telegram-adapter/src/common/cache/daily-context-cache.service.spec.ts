import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DailyContextCacheService } from './daily-context-cache.service';

describe('DailyContextCacheService', () => {
  let service: DailyContextCacheService;
  let mockRedis: {
    setex: jest.Mock;
    get: jest.Mock;
    del: jest.Mock;
    quit: jest.Mock;
    connect: jest.Mock;
    on: jest.Mock;
  };

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: unknown) => {
      if (key === 'redis.url') return 'redis://localhost:6379';
      if (key === 'redis.dailyContextTtl') return 86400;
      return defaultValue;
    }),
  };

  beforeEach(async () => {
    mockRedis = {
      setex: jest.fn().mockResolvedValue('OK'),
      get: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
      quit: jest.fn().mockResolvedValue('OK'),
      connect: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DailyContextCacheService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<DailyContextCacheService>(DailyContextCacheService);

    // Manually set redis instance for testing
    (service as any).redis = mockRedis;
    (service as any).redisAvailable = true;
    (service as any).ttlSeconds = 86400;
  });

  describe('setSessionId', () => {
    it('should store session mapping in Redis', async () => {
      await service.setSessionId(123456, 789, 'rs_abc123');

      expect(mockRedis.setex).toHaveBeenCalledWith(
        'daily-session:123456:789',
        86400,
        'rs_abc123',
      );
    });

    it('should fall back to memory when Redis unavailable', async () => {
      (service as any).redisAvailable = false;

      await service.setSessionId(123456, 789, 'rs_abc123');

      expect(mockRedis.setex).not.toHaveBeenCalled();
      // Memory cache should store the value
      const result = await service.getSessionId(123456, 789);
      expect(result).toBe('rs_abc123');
    });

    it('should fall back to memory when Redis throws error', async () => {
      mockRedis.setex.mockRejectedValue(new Error('Redis connection failed'));

      await service.setSessionId(123456, 789, 'rs_abc123');

      // Should not throw, should store in memory
      const result = await service.getSessionId(123456, 789);
      expect(result).toBe('rs_abc123');
    });
  });

  describe('getSessionId', () => {
    it('should retrieve session from Redis', async () => {
      mockRedis.get.mockResolvedValue('rs_abc123');

      const result = await service.getSessionId(123456, 789);

      expect(result).toBe('rs_abc123');
      expect(mockRedis.get).toHaveBeenCalledWith('daily-session:123456:789');
    });

    it('should return null when session not found in Redis', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await service.getSessionId(123456, 789);

      expect(result).toBeNull();
    });

    it('should check memory cache when Redis unavailable', async () => {
      (service as any).redisAvailable = false;
      (service as any).memoryCache.set('123456:789', 'rs_memory123');

      const result = await service.getSessionId(123456, 789);

      expect(result).toBe('rs_memory123');
    });

    it('should check memory cache even when Redis available but value not in Redis', async () => {
      mockRedis.get.mockResolvedValue(null);
      (service as any).memoryCache.set('123456:789', 'rs_memory123');

      const result = await service.getSessionId(123456, 789);

      expect(result).toBe('rs_memory123');
    });

    it('should return null when session not found anywhere', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await service.getSessionId(123456, 999);

      expect(result).toBeNull();
    });
  });

  describe('deleteSessionId', () => {
    it('should delete from both Redis and memory', async () => {
      (service as any).memoryCache.set('123456:789', 'rs_abc123');

      await service.deleteSessionId(123456, 789);

      expect(mockRedis.del).toHaveBeenCalledWith('daily-session:123456:789');
      expect((service as any).memoryCache.has('123456:789')).toBe(false);
    });

    it('should delete from memory even when Redis unavailable', async () => {
      (service as any).redisAvailable = false;
      (service as any).memoryCache.set('123456:789', 'rs_abc123');

      await service.deleteSessionId(123456, 789);

      expect((service as any).memoryCache.has('123456:789')).toBe(false);
    });
  });

  describe('memory cache cleanup', () => {
    it('should cleanup oldest entries when exceeding MAX_MEMORY_ENTRIES', async () => {
      (service as any).redisAvailable = false;
      const MAX_ENTRIES = 100;

      // Fill cache beyond limit
      for (let i = 0; i < MAX_ENTRIES + 10; i++) {
        await service.setSessionId(1, i, `rs_${i}`);
      }

      // Should have cleaned up to MAX_ENTRIES
      expect((service as any).memoryCache.size).toBeLessThanOrEqual(MAX_ENTRIES);
    });
  });

  describe('onModuleDestroy', () => {
    it('should close Redis connection on module destroy', async () => {
      await service.onModuleDestroy();

      expect(mockRedis.quit).toHaveBeenCalled();
    });

    it('should not throw when Redis quit fails', async () => {
      mockRedis.quit.mockRejectedValue(new Error('Already disconnected'));

      await expect(service.onModuleDestroy()).resolves.not.toThrow();
    });
  });

  describe('deprecated methods (backward compatibility)', () => {
    it('set() should call setSessionId with legacy prefix', async () => {
      const setSessionIdSpy = jest.spyOn(service, 'setSessionId');

      await service.set(123, 456, {
        dateStr: '2026-01-30',
        lastAnswer: 'test',
        sources: [],
      });

      expect(setSessionIdSpy).toHaveBeenCalledWith(123, 456, 'legacy_123:456');
    });

    it('get() should return null (deprecated)', async () => {
      mockRedis.get.mockResolvedValue('rs_abc123');

      const result = await service.get(123, 456);

      expect(result).toBeNull();
    });

    it('delete() should call deleteSessionId', async () => {
      const deleteSessionIdSpy = jest.spyOn(service, 'deleteSessionId');

      await service.delete(123, 456);

      expect(deleteSessionIdSpy).toHaveBeenCalledWith(123, 456);
    });
  });
});
