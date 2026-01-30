import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Источник данных для daily recall.
 */
export interface RecallSource {
  type: 'message' | 'interaction';
  id: string;
  preview: string;
}

/**
 * Контекст daily summary, сохраняемый для follow-up запросов.
 */
export interface DailyContext {
  dateStr: string;
  lastAnswer: string;
  sources: RecallSource[];
  model?: 'haiku' | 'sonnet' | 'opus';
}

const CACHE_KEY_PREFIX = 'daily-context:';
const MAX_MEMORY_CONTEXTS = 100;

/**
 * DailyContextCacheService — cache для daily summary контекстов.
 *
 * Использует Redis если доступен, иначе fallback на in-memory Map.
 * In-memory fallback теряет данные при рестарте, но позволяет работать без Redis.
 */
@Injectable()
export class DailyContextCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DailyContextCacheService.name);
  private redis: Redis | null = null;
  private redisAvailable = false;
  private ttlSeconds: number;

  // Fallback in-memory cache when Redis is unavailable
  private memoryCache = new Map<number, DailyContext>();

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    const redisUrl = this.configService.get<string>('redis.url', 'redis://localhost:6379');
    this.ttlSeconds = this.configService.get<number>('redis.dailyContextTtl', 86400);

    try {
      this.redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          if (times > 3) {
            this.logger.warn('Redis connection failed after 3 retries, using in-memory fallback');
            return null;
          }
          return Math.min(times * 200, 2000);
        },
        lazyConnect: true, // Don't connect immediately
      });

      this.redis.on('connect', () => {
        this.redisAvailable = true;
        this.logger.log('Connected to Redis for daily context cache');
      });

      this.redis.on('error', (err) => {
        if (this.redisAvailable) {
          this.logger.error(`Redis error: ${err.message}`);
        }
        this.redisAvailable = false;
      });

      this.redis.on('close', () => {
        this.redisAvailable = false;
      });

      // Try to connect
      await this.redis.connect();
    } catch (error) {
      this.logger.warn(`Redis unavailable (${(error as Error).message}), using in-memory fallback`);
      this.redisAvailable = false;
    }
  }

  async onModuleDestroy() {
    if (this.redis) {
      try {
        await this.redis.quit();
        this.logger.log('Redis connection closed');
      } catch {
        // Ignore errors on shutdown
      }
    }
  }

  /**
   * Сохранить контекст daily summary.
   */
  async set(messageId: number, context: DailyContext): Promise<void> {
    if (this.redisAvailable && this.redis) {
      const key = `${CACHE_KEY_PREFIX}${messageId}`;
      try {
        await this.redis.setex(key, this.ttlSeconds, JSON.stringify(context));
        this.logger.debug(`[redis] Saved daily context for messageId=${messageId}`);
        return;
      } catch (error) {
        this.logger.warn(`[redis] Failed to save, falling back to memory: ${error}`);
      }
    }

    // Fallback to in-memory
    this.memoryCache.set(messageId, context);
    this.cleanupMemoryCache();
    this.logger.debug(`[memory] Saved daily context for messageId=${messageId}`);
  }

  /**
   * Получить контекст daily summary.
   */
  async get(messageId: number): Promise<DailyContext | null> {
    if (this.redisAvailable && this.redis) {
      const key = `${CACHE_KEY_PREFIX}${messageId}`;
      try {
        const data = await this.redis.get(key);
        if (data) {
          this.logger.debug(`[redis] Found context for messageId=${messageId}`);
          return JSON.parse(data) as DailyContext;
        }
      } catch (error) {
        this.logger.warn(`[redis] Failed to get, checking memory: ${error}`);
      }
    }

    // Try memory cache (even if Redis available - might have been saved before Redis was up)
    const memoryResult = this.memoryCache.get(messageId);
    if (memoryResult) {
      this.logger.debug(`[memory] Found context for messageId=${messageId}`);
      return memoryResult;
    }

    this.logger.debug(`[cache] No context found for messageId=${messageId}`);
    return null;
  }

  /**
   * Удалить контекст.
   */
  async delete(messageId: number): Promise<void> {
    // Delete from both stores
    this.memoryCache.delete(messageId);

    if (this.redisAvailable && this.redis) {
      const key = `${CACHE_KEY_PREFIX}${messageId}`;
      try {
        await this.redis.del(key);
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Cleanup in-memory cache to prevent memory leak.
   */
  private cleanupMemoryCache(): void {
    if (this.memoryCache.size > MAX_MEMORY_CONTEXTS) {
      const keysToDelete = Array.from(this.memoryCache.keys()).slice(
        0,
        this.memoryCache.size - MAX_MEMORY_CONTEXTS,
      );
      for (const key of keysToDelete) {
        this.memoryCache.delete(key);
      }
    }
  }
}
