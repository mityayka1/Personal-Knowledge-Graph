import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { randomBytes } from 'crypto';

/**
 * Type of source for a brief item
 */
export type BriefSourceType = 'entity_event' | 'extracted_event' | 'entity_fact' | 'entity';

/**
 * Type of brief item
 */
export type BriefItemType = 'meeting' | 'task' | 'followup' | 'overdue' | 'birthday';

/**
 * Single item in the brief (accordion section)
 */
export interface BriefItem {
  /** Type of the item (determines available actions) */
  type: BriefItemType;
  /** Short title shown in collapsed state */
  title: string;
  /** Entity name (person/org) */
  entityName: string;
  /** Source type for routing operations */
  sourceType: BriefSourceType;
  /** Source entity ID (EntityEvent.id, ExtractedEvent.id, etc.) */
  sourceId: string;
  /** Detailed description shown when expanded */
  details: string;
  /** Original message ID for context link */
  sourceMessageId?: string;
  /** Deep link to source message */
  sourceMessageLink?: string;
  /** Entity ID for actions */
  entityId?: string;
}

/**
 * Brief state stored in Redis
 */
export interface BriefState {
  /** Unique brief ID */
  id: string;
  /** Telegram chat ID */
  chatId: string;
  /** Telegram message ID for editMessage */
  messageId: number;
  /** All items in the brief */
  items: BriefItem[];
  /** Currently expanded item index (null = all collapsed) */
  expandedIndex: number | null;
  /** Creation timestamp */
  createdAt: number;
}

/**
 * Service for managing Morning Brief accordion state in Redis.
 *
 * Accordion UI allows user to expand/collapse items and take quick actions
 * (mark done, dismiss, write message) directly from the brief.
 *
 * Redis key format: brief:{briefId}
 * TTL: 48 hours (brief is relevant throughout the day)
 */
@Injectable()
export class BriefStateService {
  private readonly logger = new Logger(BriefStateService.name);
  private readonly KEY_PREFIX = 'brief:';
  private readonly TTL_SECONDS = 172800; // 48 hours
  private readonly MAX_ITEMS = 10;

  constructor(
    @InjectRedis()
    private readonly redis: Redis,
  ) {}

  /**
   * Create a new brief and return its ID.
   *
   * @param chatId - Telegram chat ID
   * @param messageId - Telegram message ID (0 if not yet sent)
   * @param items - Array of brief items
   * @returns Brief ID for callback_data (e.g., "b_a1b2c3d4e5f6")
   */
  async create(chatId: string, messageId: number, items: BriefItem[]): Promise<string> {
    if (items.length === 0) {
      throw new Error('Cannot create brief with empty item list');
    }

    // Limit items to prevent UI overflow
    const limitedItems = items.slice(0, this.MAX_ITEMS);

    // Generate short ID: "b_" + 12 hex chars = 14 chars total
    const briefId = `b_${randomBytes(6).toString('hex')}`;
    const key = `${this.KEY_PREFIX}${briefId}`;

    const state: BriefState = {
      id: briefId,
      chatId,
      messageId,
      items: limitedItems,
      expandedIndex: null,
      createdAt: Date.now(),
    };

    await this.redis.setex(key, this.TTL_SECONDS, JSON.stringify(state));

    this.logger.log(`Created brief ${briefId} with ${limitedItems.length} items for chat ${chatId}`);

    return briefId;
  }

  /**
   * Get brief state by ID.
   *
   * @param briefId - Brief ID from callback_data
   * @returns BriefState or null if not found/expired
   */
  async get(briefId: string): Promise<BriefState | null> {
    const key = `${this.KEY_PREFIX}${briefId}`;
    const data = await this.redis.get(key);

    if (!data) {
      this.logger.warn(`Brief not found: ${briefId}`);
      return null;
    }

    try {
      return JSON.parse(data) as BriefState;
    } catch (error) {
      this.logger.error(`Failed to parse brief state: ${briefId}`, error);
      // Delete corrupted data to prevent repeated parse errors
      await this.redis.del(key);
      return null;
    }
  }

  /**
   * Expand an item in the brief.
   *
   * @param briefId - Brief ID
   * @param index - Item index to expand (0-based)
   * @returns Updated BriefState or null if not found
   */
  async expand(briefId: string, index: number): Promise<BriefState | null> {
    const state = await this.get(briefId);
    if (!state) return null;

    if (index < 0 || index >= state.items.length) {
      this.logger.warn(`Invalid expand index ${index} for brief ${briefId}`);
      return state;
    }

    state.expandedIndex = index;
    await this.save(briefId, state);

    this.logger.debug(`Expanded item ${index} in brief ${briefId}`);
    return state;
  }

  /**
   * Collapse all items in the brief.
   *
   * @param briefId - Brief ID
   * @returns Updated BriefState or null if not found
   */
  async collapse(briefId: string): Promise<BriefState | null> {
    const state = await this.get(briefId);
    if (!state) return null;

    state.expandedIndex = null;
    await this.save(briefId, state);

    this.logger.debug(`Collapsed all items in brief ${briefId}`);
    return state;
  }

  /**
   * Remove an item from the brief (after done/dismiss action).
   *
   * @param briefId - Brief ID
   * @param index - Item index to remove
   * @returns Updated BriefState or null if not found
   */
  async removeItem(briefId: string, index: number): Promise<BriefState | null> {
    const state = await this.get(briefId);
    if (!state) return null;

    if (index < 0 || index >= state.items.length) {
      this.logger.warn(`Invalid remove index ${index} for brief ${briefId}`);
      return state;
    }

    // Remove the item
    state.items.splice(index, 1);

    // Adjust expandedIndex if needed
    if (state.expandedIndex !== null) {
      if (state.expandedIndex === index) {
        // Removed item was expanded - collapse
        state.expandedIndex = null;
      } else if (state.expandedIndex > index) {
        // Expanded item was after removed - shift index
        state.expandedIndex--;
      }
    }

    await this.save(briefId, state);

    this.logger.debug(`Removed item ${index} from brief ${briefId}, ${state.items.length} items remaining`);
    return state;
  }

  /**
   * Get a specific item from the brief.
   *
   * @param briefId - Brief ID
   * @param index - Item index
   * @returns BriefItem or null if not found
   */
  async getItem(briefId: string, index: number): Promise<BriefItem | null> {
    const state = await this.get(briefId);
    if (!state) return null;

    if (index < 0 || index >= state.items.length) {
      return null;
    }

    return state.items[index];
  }

  /**
   * Update the message ID for a brief.
   * Used when brief is created before message is sent.
   *
   * @param briefId - Brief ID
   * @param messageId - New Telegram message ID
   */
  async updateMessageId(briefId: string, messageId: number): Promise<void> {
    const state = await this.get(briefId);
    if (!state) {
      this.logger.warn(`Cannot update messageId: brief ${briefId} not found`);
      return;
    }

    state.messageId = messageId;
    await this.save(briefId, state);
    this.logger.debug(`Updated brief ${briefId} messageId to ${messageId}`);
  }

  /**
   * Check if brief is empty (all items removed).
   *
   * @param briefId - Brief ID
   * @returns true if no items remaining
   */
  async isEmpty(briefId: string): Promise<boolean> {
    const state = await this.get(briefId);
    if (!state) return true;

    return state.items.length === 0;
  }

  /**
   * Delete brief state.
   *
   * @param briefId - Brief ID to delete
   */
  async delete(briefId: string): Promise<void> {
    const key = `${this.KEY_PREFIX}${briefId}`;
    await this.redis.del(key);
    this.logger.debug(`Deleted brief: ${briefId}`);
  }

  // ─────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────

  /**
   * Save brief state to Redis.
   */
  private async save(briefId: string, state: BriefState): Promise<void> {
    const key = `${this.KEY_PREFIX}${briefId}`;
    // Refresh TTL on each save
    await this.redis.setex(key, this.TTL_SECONDS, JSON.stringify(state));
  }
}
