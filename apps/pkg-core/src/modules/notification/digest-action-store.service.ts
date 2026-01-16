import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { randomBytes } from 'crypto';

/**
 * Service for storing digest action data in Redis.
 *
 * Telegram callback_data has a 64-byte limit. When we need to reference
 * multiple event UUIDs (each 36 chars), we exceed this limit.
 *
 * Solution: Store event IDs in Redis with a short key, use the short key
 * in callback_data.
 */
@Injectable()
export class DigestActionStoreService {
  private readonly logger = new Logger(DigestActionStoreService.name);
  private readonly KEY_PREFIX = 'digest:action:';
  private readonly TTL_SECONDS = 86400; // 24 hours

  constructor(
    @InjectRedis()
    private readonly redis: Redis,
  ) {}

  /**
   * Store event IDs and return a short ID for callback_data.
   *
   * @param eventIds - Array of event UUIDs to store
   * @returns Short ID (e.g., "d_a1b2c3d4e5f6") that fits in callback_data
   */
  async store(eventIds: string[]): Promise<string> {
    if (eventIds.length === 0) {
      throw new Error('Cannot store empty event list');
    }

    // Generate short ID: "d_" + 12 hex chars = 14 chars total
    const shortId = `d_${randomBytes(6).toString('hex')}`;
    const key = `${this.KEY_PREFIX}${shortId}`;

    await this.redis.setex(key, this.TTL_SECONDS, JSON.stringify(eventIds));

    this.logger.debug(`Stored ${eventIds.length} event IDs with key ${shortId}`);
    return shortId;
  }

  /**
   * Retrieve event IDs by short ID.
   *
   * @param shortId - Short ID from callback_data
   * @returns Array of event UUIDs or null if not found/expired
   */
  async get(shortId: string): Promise<string[] | null> {
    const key = `${this.KEY_PREFIX}${shortId}`;
    const data = await this.redis.get(key);

    if (!data) {
      this.logger.warn(`Digest action not found: ${shortId}`);
      return null;
    }

    try {
      return JSON.parse(data) as string[];
    } catch (error) {
      this.logger.error(`Failed to parse digest action data: ${shortId}`);
      return null;
    }
  }

  /**
   * Delete stored action (e.g., after processing).
   *
   * @param shortId - Short ID to delete
   */
  async delete(shortId: string): Promise<void> {
    const key = `${this.KEY_PREFIX}${shortId}`;
    await this.redis.del(key);
    this.logger.debug(`Deleted digest action: ${shortId}`);
  }
}
