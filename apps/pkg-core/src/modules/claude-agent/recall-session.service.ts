import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { randomBytes } from 'crypto';

/**
 * Source used in recall answer.
 */
export interface RecallSessionSource {
  type: 'message' | 'interaction';
  id: string;
  preview: string;
}

/**
 * Recall session state stored in Redis.
 * Contains LLM synthesis results and sources for follow-up operations.
 */
export interface RecallSession {
  /** Session ID (e.g., "rs_a1b2c3d4e5f6") */
  id: string;
  /** Original query */
  query: string;
  /** Date string for context (YYYY-MM-DD) */
  dateStr: string;
  /** LLM synthesis answer */
  answer: string;
  /** Sources used in the answer */
  sources: RecallSessionSource[];
  /** Model used for synthesis */
  model?: 'haiku' | 'sonnet' | 'opus';
  /** Creation timestamp */
  createdAt: number;
  /** Optional: Telegram chat ID for adapter reference */
  chatId?: string;
  /** User ID who created the session (for multi-user safety) */
  userId?: string;
  /** Timestamp when insights were saved (for idempotency) */
  savedAt?: number;
  /** Fact ID if insights were saved */
  savedFactId?: string;
}

/**
 * Service for managing Recall session state in Redis.
 *
 * Stores LLM synthesis results (answer, sources) for follow-up operations:
 * - Extract structure from synthesis
 * - Continue conversation with context
 *
 * This data belongs to PKG Core (not adapters) because it contains
 * LLM-generated content and references to core entities.
 *
 * Redis key format: recall-session:{sessionId}
 * TTL: 24 hours (session is relevant for daily follow-ups)
 */
@Injectable()
export class RecallSessionService {
  private readonly logger = new Logger(RecallSessionService.name);
  private readonly KEY_PREFIX = 'recall-session:';
  private readonly TTL_SECONDS = 86400; // 24 hours

  constructor(
    @InjectRedis()
    private readonly redis: Redis,
  ) {}

  /**
   * Create a new recall session and return its ID.
   *
   * @param params - Session parameters
   * @returns Session ID for reference (e.g., "rs_a1b2c3d4e5f6")
   */
  async create(params: {
    query: string;
    dateStr: string;
    answer: string;
    sources: RecallSessionSource[];
    model?: 'haiku' | 'sonnet' | 'opus';
    chatId?: string;
    userId?: string;
  }): Promise<string> {
    // Generate short ID: "rs_" + 12 hex chars = 15 chars total
    const sessionId = `rs_${randomBytes(6).toString('hex')}`;
    const key = `${this.KEY_PREFIX}${sessionId}`;

    const session: RecallSession = {
      id: sessionId,
      query: params.query,
      dateStr: params.dateStr,
      answer: params.answer,
      sources: params.sources,
      model: params.model,
      chatId: params.chatId,
      userId: params.userId,
      createdAt: Date.now(),
    };

    await this.redis.setex(key, this.TTL_SECONDS, JSON.stringify(session));

    this.logger.log(
      `Created recall session ${sessionId} for user ${params.userId || 'unknown'} with ${params.sources.length} sources`,
    );

    return sessionId;
  }

  /**
   * Get recall session by ID.
   *
   * @param sessionId - Session ID from recall response
   * @returns RecallSession or null if not found/expired
   */
  async get(sessionId: string): Promise<RecallSession | null> {
    const key = `${this.KEY_PREFIX}${sessionId}`;
    const data = await this.redis.get(key);

    if (!data) {
      this.logger.debug(`Recall session not found: ${sessionId}`);
      return null;
    }

    try {
      return JSON.parse(data) as RecallSession;
    } catch (error) {
      this.logger.error(`Failed to parse recall session: ${sessionId}`, error);
      // Delete corrupted data
      await this.redis.del(key);
      return null;
    }
  }

  /**
   * Update session answer (for follow-up queries).
   * Uses Lua script for atomic read-modify-write to prevent race conditions.
   *
   * @param sessionId - Session ID
   * @param answer - New answer text
   * @param sources - Updated sources (optional)
   * @param userId - Optional user ID for verification
   * @returns Updated session or null if not found/unauthorized
   */
  async updateAnswer(
    sessionId: string,
    answer: string,
    sources?: RecallSessionSource[],
    userId?: string,
  ): Promise<RecallSession | null> {
    const key = `${this.KEY_PREFIX}${sessionId}`;

    // Lua script for atomic update with optional userId verification
    const luaScript = `
      local key = KEYS[1]
      local newAnswer = ARGV[1]
      local newSources = ARGV[2]
      local userId = ARGV[3]
      local ttl = tonumber(ARGV[4])

      local data = redis.call('GET', key)
      if not data then
        return nil
      end

      local session = cjson.decode(data)

      -- Verify userId if provided and session has userId
      if userId ~= '' and session.userId and session.userId ~= userId then
        return cjson.encode({ error = 'unauthorized' })
      end

      -- Update answer
      session.answer = newAnswer

      -- Update sources if provided
      if newSources ~= '' then
        session.sources = cjson.decode(newSources)
      end

      -- Save with refreshed TTL
      redis.call('SETEX', key, ttl, cjson.encode(session))

      return cjson.encode(session)
    `;

    const result = await this.redis.eval(
      luaScript,
      1,
      key,
      answer,
      sources ? JSON.stringify(sources) : '',
      userId || '',
      this.TTL_SECONDS.toString(),
    ) as string | null;

    if (!result) {
      this.logger.debug(`Recall session not found: ${sessionId}`);
      return null;
    }

    try {
      const parsed = JSON.parse(result);
      if (parsed.error === 'unauthorized') {
        this.logger.warn(`Unauthorized update attempt on session ${sessionId} by user ${userId}`);
        return null;
      }
      this.logger.debug(`Updated recall session ${sessionId}`);
      return parsed as RecallSession;
    } catch {
      this.logger.error(`Failed to parse update result for session ${sessionId}`);
      return null;
    }
  }

  /**
   * Delete recall session.
   *
   * @param sessionId - Session ID to delete
   */
  async delete(sessionId: string): Promise<void> {
    const key = `${this.KEY_PREFIX}${sessionId}`;
    await this.redis.del(key);
    this.logger.debug(`Deleted recall session: ${sessionId}`);
  }

  /**
   * Refresh TTL for active session.
   *
   * @param sessionId - Session ID
   */
  async touch(sessionId: string): Promise<void> {
    const session = await this.get(sessionId);
    if (session) {
      await this.save(sessionId, session);
    }
  }

  /**
   * Mark session as saved (idempotency protection).
   * Uses Lua script to atomically check and set savedAt.
   *
   * @param sessionId - Session ID
   * @param factId - Created fact ID
   * @param userId - Optional user ID for verification
   * @returns Object with success status and existing factId if already saved
   */
  async markAsSaved(
    sessionId: string,
    factId: string,
    userId?: string,
  ): Promise<{ success: boolean; alreadySaved: boolean; existingFactId?: string }> {
    const key = `${this.KEY_PREFIX}${sessionId}`;

    // Lua script for atomic idempotent save
    const luaScript = `
      local key = KEYS[1]
      local factId = ARGV[1]
      local userId = ARGV[2]
      local ttl = tonumber(ARGV[3])
      local now = tonumber(ARGV[4])

      local data = redis.call('GET', key)
      if not data then
        return cjson.encode({ error = 'not_found' })
      end

      local session = cjson.decode(data)

      -- Verify userId if provided and session has userId
      if userId ~= '' and session.userId and session.userId ~= userId then
        return cjson.encode({ error = 'unauthorized' })
      end

      -- Check if already saved (idempotency)
      if session.savedAt then
        return cjson.encode({
          alreadySaved = true,
          existingFactId = session.savedFactId
        })
      end

      -- Mark as saved
      session.savedAt = now
      session.savedFactId = factId

      -- Save with refreshed TTL
      redis.call('SETEX', key, ttl, cjson.encode(session))

      return cjson.encode({ success = true })
    `;

    const result = await this.redis.eval(
      luaScript,
      1,
      key,
      factId,
      userId || '',
      this.TTL_SECONDS.toString(),
      Date.now().toString(),
    ) as string;

    try {
      const parsed = JSON.parse(result);

      if (parsed.error === 'not_found') {
        this.logger.debug(`Session not found for save: ${sessionId}`);
        return { success: false, alreadySaved: false };
      }

      if (parsed.error === 'unauthorized') {
        this.logger.warn(`Unauthorized save attempt on session ${sessionId}`);
        return { success: false, alreadySaved: false };
      }

      if (parsed.alreadySaved) {
        this.logger.debug(`Session ${sessionId} already saved as fact ${parsed.existingFactId}`);
        return {
          success: false,
          alreadySaved: true,
          existingFactId: parsed.existingFactId,
        };
      }

      this.logger.log(`Marked session ${sessionId} as saved, factId: ${factId}`);
      return { success: true, alreadySaved: false };
    } catch {
      this.logger.error(`Failed to parse markAsSaved result for session ${sessionId}`);
      return { success: false, alreadySaved: false };
    }
  }

  /**
   * Verify that user has access to session.
   *
   * @param sessionId - Session ID
   * @param userId - User ID to verify
   * @returns true if user has access, false otherwise
   */
  async verifyUser(sessionId: string, userId: string): Promise<boolean> {
    const session = await this.get(sessionId);
    if (!session) return false;

    // If session has no userId, allow access (backward compatibility)
    if (!session.userId) return true;

    return session.userId === userId;
  }

  // ─────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────

  /**
   * Save session to Redis with refreshed TTL.
   */
  private async save(sessionId: string, session: RecallSession): Promise<void> {
    const key = `${this.KEY_PREFIX}${sessionId}`;
    await this.redis.setex(key, this.TTL_SECONDS, JSON.stringify(session));
  }
}
