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

/**
 * DailyContextCacheService — Redis-based cache для daily summary контекстов.
 *
 * Решает проблему потери контекста при перезапуске сервера.
 * Ранее использовался in-memory Map, который терял данные при рестарте.
 */
@Injectable()
export class DailyContextCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DailyContextCacheService.name);
  private redis: Redis;
  private ttlSeconds: number;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    const redisUrl = this.configService.get<string>('redis.url', 'redis://localhost:6379');
    this.ttlSeconds = this.configService.get<number>('redis.dailyContextTtl', 86400); // 24 hours default

    this.redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        if (times > 3) {
          this.logger.error('Redis connection failed after 3 retries');
          return null; // Stop retrying
        }
        return Math.min(times * 200, 2000);
      },
    });

    this.redis.on('connect', () => {
      this.logger.log('Connected to Redis for daily context cache');
    });

    this.redis.on('error', (err) => {
      this.logger.error(`Redis error: ${err.message}`);
    });
  }

  async onModuleDestroy() {
    if (this.redis) {
      await this.redis.quit();
      this.logger.log('Redis connection closed');
    }
  }

  /**
   * Сохранить контекст daily summary.
   *
   * @param messageId - ID сообщения в Telegram (используется как ключ)
   * @param context - Контекст для сохранения
   */
  async set(messageId: number, context: DailyContext): Promise<void> {
    const key = `${CACHE_KEY_PREFIX}${messageId}`;
    try {
      await this.redis.setex(key, this.ttlSeconds, JSON.stringify(context));
      this.logger.debug(`[cache] Saved daily context for messageId=${messageId}, TTL=${this.ttlSeconds}s`);
    } catch (error) {
      this.logger.error(`[cache] Failed to save context for messageId=${messageId}: ${error}`);
    }
  }

  /**
   * Получить контекст daily summary.
   *
   * @param messageId - ID сообщения в Telegram
   * @returns Контекст или null если не найден
   */
  async get(messageId: number): Promise<DailyContext | null> {
    const key = `${CACHE_KEY_PREFIX}${messageId}`;
    try {
      const data = await this.redis.get(key);
      if (!data) {
        this.logger.debug(`[cache] No context found for messageId=${messageId}`);
        return null;
      }
      return JSON.parse(data) as DailyContext;
    } catch (error) {
      this.logger.error(`[cache] Failed to get context for messageId=${messageId}: ${error}`);
      return null;
    }
  }

  /**
   * Удалить контекст (опционально, для cleanup).
   */
  async delete(messageId: number): Promise<void> {
    const key = `${CACHE_KEY_PREFIX}${messageId}`;
    try {
      await this.redis.del(key);
    } catch (error) {
      this.logger.error(`[cache] Failed to delete context for messageId=${messageId}: ${error}`);
    }
  }
}
