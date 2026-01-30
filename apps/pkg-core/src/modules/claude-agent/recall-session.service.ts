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
      createdAt: Date.now(),
    };

    await this.redis.setex(key, this.TTL_SECONDS, JSON.stringify(session));

    this.logger.log(
      `Created recall session ${sessionId} with ${params.sources.length} sources`,
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
   *
   * @param sessionId - Session ID
   * @param answer - New answer text
   * @param sources - Updated sources (optional)
   * @returns Updated session or null if not found
   */
  async updateAnswer(
    sessionId: string,
    answer: string,
    sources?: RecallSessionSource[],
  ): Promise<RecallSession | null> {
    const session = await this.get(sessionId);
    if (!session) return null;

    session.answer = answer;
    if (sources) {
      session.sources = sources;
    }

    await this.save(sessionId, session);

    this.logger.debug(`Updated recall session ${sessionId}`);
    return session;
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
