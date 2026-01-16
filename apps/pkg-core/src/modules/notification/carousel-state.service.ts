import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import Redis from 'ioredis';
import { randomBytes } from 'crypto';
import { ExtractedEvent } from '@pkg/entities';

/**
 * Carousel state stored in Redis
 */
export interface CarouselState {
  /** All event IDs in the carousel */
  eventIds: string[];
  /** Current position (0-based index) */
  currentIndex: number;
  /** IDs of events that have been processed (confirmed/rejected) */
  processedIds: string[];
  /** Telegram chat ID where carousel was sent */
  chatId: string;
  /** Telegram message ID for editMessage */
  messageId: number;
  /** Creation timestamp for debugging */
  createdAt: number;
}

/**
 * Result of navigation operations
 */
export interface CarouselNavResult {
  event: ExtractedEvent;
  index: number;
  total: number;
  remaining: number;
}

/**
 * Service for managing carousel state in Redis.
 *
 * Carousel allows processing extracted events one by one with navigation
 * buttons (◀️ ▶️) instead of showing a list with "confirm all / reject all".
 *
 * Redis key format: carousel:{carouselId}
 * TTL: 24 hours
 */
@Injectable()
export class CarouselStateService {
  private readonly logger = new Logger(CarouselStateService.name);
  private readonly KEY_PREFIX = 'carousel:';
  private readonly TTL_SECONDS = 86400; // 24 hours

  constructor(
    @InjectRedis()
    private readonly redis: Redis,
    @InjectRepository(ExtractedEvent)
    private readonly extractedEventRepo: Repository<ExtractedEvent>,
  ) {}

  /**
   * Create a new carousel and return its ID.
   *
   * @param chatId - Telegram chat ID
   * @param messageId - Telegram message ID for later editMessage calls
   * @param eventIds - Array of event UUIDs to include in carousel
   * @returns Carousel ID for callback_data (e.g., "c_a1b2c3d4e5f6")
   */
  async create(
    chatId: string,
    messageId: number,
    eventIds: string[],
  ): Promise<string> {
    if (eventIds.length === 0) {
      throw new Error('Cannot create carousel with empty event list');
    }

    // Generate short ID: "c_" + 12 hex chars = 14 chars total
    const carouselId = `c_${randomBytes(6).toString('hex')}`;
    const key = `${this.KEY_PREFIX}${carouselId}`;

    const state: CarouselState = {
      eventIds,
      currentIndex: 0,
      processedIds: [],
      chatId,
      messageId,
      createdAt: Date.now(),
    };

    await this.redis.setex(key, this.TTL_SECONDS, JSON.stringify(state));

    this.logger.log(
      `Created carousel ${carouselId} with ${eventIds.length} events for chat ${chatId}`,
    );

    return carouselId;
  }

  /**
   * Get carousel state by ID.
   *
   * @param carouselId - Carousel ID from callback_data
   * @returns CarouselState or null if not found/expired
   */
  async get(carouselId: string): Promise<CarouselState | null> {
    const key = `${this.KEY_PREFIX}${carouselId}`;
    const data = await this.redis.get(key);

    if (!data) {
      this.logger.warn(`Carousel not found: ${carouselId}`);
      return null;
    }

    try {
      return JSON.parse(data) as CarouselState;
    } catch (error) {
      this.logger.error(`Failed to parse carousel state: ${carouselId}`);
      return null;
    }
  }

  /**
   * Get the current event in the carousel.
   *
   * @param carouselId - Carousel ID
   * @returns Current event with position info, or null if carousel finished/invalid
   */
  async getCurrentEvent(carouselId: string): Promise<CarouselNavResult | null> {
    const state = await this.get(carouselId);
    if (!state) return null;

    // Find next unprocessed event starting from currentIndex
    const unprocessedIndex = this.findNextUnprocessed(state, state.currentIndex);

    if (unprocessedIndex === -1) {
      // All events processed
      return null;
    }

    const eventId = state.eventIds[unprocessedIndex];
    const event = await this.extractedEventRepo.findOne({
      where: { id: eventId },
    });

    if (!event) {
      this.logger.warn(`Event not found: ${eventId}`);
      // Mark as processed and try next
      await this.markProcessed(carouselId, eventId);
      return this.getCurrentEvent(carouselId);
    }

    const remaining = state.eventIds.filter(
      (id) => !state.processedIds.includes(id),
    ).length;

    return {
      event,
      index: unprocessedIndex,
      total: state.eventIds.length,
      remaining,
    };
  }

  /**
   * Navigate to the next unprocessed event.
   *
   * @param carouselId - Carousel ID
   * @returns Next event or null if no more events
   */
  async next(carouselId: string): Promise<CarouselNavResult | null> {
    const state = await this.get(carouselId);
    if (!state) return null;

    // Find next unprocessed event after currentIndex
    const nextIndex = this.findNextUnprocessed(state, state.currentIndex + 1);

    if (nextIndex === -1) {
      // Wrap around to beginning
      const wrappedIndex = this.findNextUnprocessed(state, 0);
      if (wrappedIndex === -1 || wrappedIndex === state.currentIndex) {
        // No more unprocessed events
        return null;
      }
      state.currentIndex = wrappedIndex;
    } else {
      state.currentIndex = nextIndex;
    }

    await this.save(carouselId, state);
    return this.getCurrentEvent(carouselId);
  }

  /**
   * Navigate to the previous unprocessed event.
   *
   * @param carouselId - Carousel ID
   * @returns Previous event or null if no more events
   */
  async prev(carouselId: string): Promise<CarouselNavResult | null> {
    const state = await this.get(carouselId);
    if (!state) return null;

    // Find previous unprocessed event before currentIndex
    const prevIndex = this.findPrevUnprocessed(state, state.currentIndex - 1);

    if (prevIndex === -1) {
      // Wrap around to end
      const wrappedIndex = this.findPrevUnprocessed(
        state,
        state.eventIds.length - 1,
      );
      if (wrappedIndex === -1 || wrappedIndex === state.currentIndex) {
        // No more unprocessed events
        return null;
      }
      state.currentIndex = wrappedIndex;
    } else {
      state.currentIndex = prevIndex;
    }

    await this.save(carouselId, state);
    return this.getCurrentEvent(carouselId);
  }

  /**
   * Mark an event as processed (confirmed or rejected).
   *
   * @param carouselId - Carousel ID
   * @param eventId - Event ID to mark as processed
   */
  async markProcessed(carouselId: string, eventId: string): Promise<void> {
    const state = await this.get(carouselId);
    if (!state) return;

    if (!state.processedIds.includes(eventId)) {
      state.processedIds.push(eventId);
      await this.save(carouselId, state);
      this.logger.debug(
        `Marked event ${eventId} as processed in carousel ${carouselId}`,
      );
    }
  }

  /**
   * Check if all events in carousel have been processed.
   *
   * @param carouselId - Carousel ID
   * @returns true if all events processed
   */
  async isComplete(carouselId: string): Promise<boolean> {
    const state = await this.get(carouselId);
    if (!state) return true;

    return state.processedIds.length >= state.eventIds.length;
  }

  /**
   * Delete carousel state.
   *
   * @param carouselId - Carousel ID to delete
   */
  async delete(carouselId: string): Promise<void> {
    const key = `${this.KEY_PREFIX}${carouselId}`;
    await this.redis.del(key);
    this.logger.debug(`Deleted carousel: ${carouselId}`);
  }

  /**
   * Update the message ID for a carousel.
   * Used when carousel is created before message is sent.
   *
   * @param carouselId - Carousel ID
   * @param messageId - New Telegram message ID
   */
  async updateMessageId(carouselId: string, messageId: number): Promise<void> {
    const state = await this.get(carouselId);
    if (!state) {
      this.logger.warn(`Cannot update messageId: carousel ${carouselId} not found`);
      return;
    }

    state.messageId = messageId;
    await this.save(carouselId, state);
    this.logger.debug(`Updated carousel ${carouselId} messageId to ${messageId}`);
  }

  /**
   * Get multiple events by their IDs (for bulk operations).
   *
   * @param eventIds - Array of event UUIDs
   * @returns Array of ExtractedEvent entities
   */
  async getEventsByIds(eventIds: string[]): Promise<ExtractedEvent[]> {
    if (eventIds.length === 0) return [];

    return this.extractedEventRepo.find({
      where: { id: In(eventIds) },
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────

  /**
   * Save carousel state to Redis.
   */
  private async save(carouselId: string, state: CarouselState): Promise<void> {
    const key = `${this.KEY_PREFIX}${carouselId}`;
    // Refresh TTL on each save
    await this.redis.setex(key, this.TTL_SECONDS, JSON.stringify(state));
  }

  /**
   * Find next unprocessed event index starting from given index.
   * Returns -1 if none found.
   */
  private findNextUnprocessed(
    state: CarouselState,
    startIndex: number,
  ): number {
    for (let i = startIndex; i < state.eventIds.length; i++) {
      if (!state.processedIds.includes(state.eventIds[i])) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Find previous unprocessed event index starting from given index.
   * Returns -1 if none found.
   */
  private findPrevUnprocessed(
    state: CarouselState,
    startIndex: number,
  ): number {
    for (let i = startIndex; i >= 0; i--) {
      if (!state.processedIds.includes(state.eventIds[i])) {
        return i;
      }
    }
    return -1;
  }
}
