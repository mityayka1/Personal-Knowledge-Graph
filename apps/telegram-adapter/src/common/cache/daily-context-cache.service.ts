import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

const CACHE_KEY_PREFIX = 'daily-session:';
const MAX_MEMORY_ENTRIES = 100;

/**
 * DailyContextCacheService — lightweight cache for messageId → sessionId mapping.
 *
 * The actual recall session data (answer, sources, model) is stored in PKG Core.
 * This service only stores the mapping to enable follow-up operations from Telegram.
 *
 * Architecture:
 * - PKG Core owns RecallSession data (via RecallSessionService)
 * - Telegram Adapter stores only messageId → sessionId mapping
 * - Follow-up requests use sessionId to fetch/update session from PKG Core
 *
 * Uses Redis if available, otherwise fallback to in-memory Map.
 * In-memory fallback loses data on restart, but allows operation without Redis.
 */
@Injectable()
export class DailyContextCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DailyContextCacheService.name);
  private redis: Redis | null = null;
  private redisAvailable = false;
  private ttlSeconds: number;

  // Fallback in-memory cache when Redis is unavailable
  // Key format: "chatId:messageId"
  private memoryCache = new Map<string, string>();

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
        this.logger.log('Connected to Redis for daily session mapping');
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
   * Store sessionId for a Telegram message.
   * The actual session data is stored in PKG Core.
   *
   * @param chatId Telegram chat ID (ensures uniqueness across chats)
   * @param messageId Telegram message ID
   * @param sessionId PKG Core recall session ID (e.g., "rs_a1b2c3d4e5f6")
   */
  async setSessionId(chatId: number, messageId: number, sessionId: string): Promise<void> {
    const cacheKey = `${chatId}:${messageId}`;

    if (this.redisAvailable && this.redis) {
      const key = `${CACHE_KEY_PREFIX}${cacheKey}`;
      try {
        await this.redis.setex(key, this.ttlSeconds, sessionId);
        this.logger.debug(`[redis] Saved session mapping: ${cacheKey} → ${sessionId}`);
        return;
      } catch (error) {
        this.logger.warn(`[redis] Failed to save, falling back to memory: ${error}`);
      }
    }

    // Fallback to in-memory
    this.memoryCache.set(cacheKey, sessionId);
    this.cleanupMemoryCache();
    this.logger.debug(`[memory] Saved session mapping: ${cacheKey} → ${sessionId}`);
  }

  /**
   * Get sessionId for a Telegram message.
   *
   * @param chatId Telegram chat ID
   * @param messageId Telegram message ID
   * @returns Session ID or null if not found/expired
   */
  async getSessionId(chatId: number, messageId: number): Promise<string | null> {
    const cacheKey = `${chatId}:${messageId}`;

    if (this.redisAvailable && this.redis) {
      const key = `${CACHE_KEY_PREFIX}${cacheKey}`;
      try {
        const sessionId = await this.redis.get(key);
        if (sessionId) {
          this.logger.debug(`[redis] Found session for ${cacheKey}: ${sessionId}`);
          return sessionId;
        }
      } catch (error) {
        this.logger.warn(`[redis] Failed to get, checking memory: ${error}`);
      }
    }

    // Try memory cache (even if Redis available - might have been saved before Redis was up)
    const memoryResult = this.memoryCache.get(cacheKey);
    if (memoryResult) {
      this.logger.debug(`[memory] Found session for ${cacheKey}: ${memoryResult}`);
      return memoryResult;
    }

    this.logger.debug(`[cache] No session found for ${cacheKey}`);
    return null;
  }

  /**
   * Delete session mapping.
   *
   * @param chatId Telegram chat ID
   * @param messageId Telegram message ID
   */
  async deleteSessionId(chatId: number, messageId: number): Promise<void> {
    const cacheKey = `${chatId}:${messageId}`;

    // Delete from both stores
    this.memoryCache.delete(cacheKey);

    if (this.redisAvailable && this.redis) {
      const key = `${CACHE_KEY_PREFIX}${cacheKey}`;
      try {
        await this.redis.del(key);
      } catch {
        // Ignore
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Backward Compatibility (deprecated - will be removed)
  // ─────────────────────────────────────────────────────────────────

  /**
   * @deprecated Use setSessionId instead. This method exists for migration period only.
   */
  async set(
    chatId: number,
    messageId: number,
    context: { dateStr: string; lastAnswer: string; sources: unknown[]; model?: string },
  ): Promise<void> {
    this.logger.warn(
      `[deprecated] set() called for chatId=${chatId}, messageId=${messageId}. ` +
        `Use setSessionId() instead. Context data should be stored in PKG Core.`,
    );
    // Store a placeholder - actual data should go to PKG Core
    await this.setSessionId(chatId, messageId, `legacy_${chatId}:${messageId}`);
  }

  /**
   * @deprecated Use getSessionId instead. This method exists for migration period only.
   */
  async get(chatId: number, messageId: number): Promise<null> {
    this.logger.warn(
      `[deprecated] get() called for chatId=${chatId}, messageId=${messageId}. ` +
        `Use getSessionId() and fetch session from PKG Core via API.`,
    );
    return null;
  }

  /**
   * @deprecated Use deleteSessionId instead.
   */
  async delete(chatId: number, messageId: number): Promise<void> {
    await this.deleteSessionId(chatId, messageId);
  }

  // ─────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────

  /**
   * Cleanup in-memory cache to prevent memory leak.
   */
  private cleanupMemoryCache(): void {
    if (this.memoryCache.size > MAX_MEMORY_ENTRIES) {
      const keysToDelete = Array.from(this.memoryCache.keys()).slice(
        0,
        this.memoryCache.size - MAX_MEMORY_ENTRIES,
      );
      for (const key of keysToDelete) {
        this.memoryCache.delete(key);
      }
    }
  }
}
