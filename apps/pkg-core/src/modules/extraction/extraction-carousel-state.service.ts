import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { randomBytes } from 'crypto';
import {
  ExtractedProject,
  ExtractedTask,
  ExtractedCommitment,
} from './daily-synthesis-extraction.types';

/**
 * Unified item type for carousel navigation.
 * Wraps different extraction types into a single navigable format.
 */
export type ExtractionItemType = 'project' | 'task' | 'commitment';

export interface ExtractionCarouselItem {
  /** Unique ID within this carousel (e.g., "project_0", "task_1") */
  id: string;
  /** Item type */
  type: ExtractionItemType;
  /** Original extracted data */
  data: ExtractedProject | ExtractedTask | ExtractedCommitment;
}

/**
 * Carousel state stored in Redis.
 * Contains all extracted items for confirmation flow.
 *
 * Note: Uses source-agnostic field names. Adapters (Telegram, etc.)
 * are responsible for mapping their specific IDs to these generic fields.
 */
export interface ExtractionCarouselState {
  /** All items in the carousel (projects, tasks, commitments) */
  items: ExtractionCarouselItem[];
  /** Current position (0-based index) */
  currentIndex: number;
  /** IDs of items that have been processed (confirmed/skipped) */
  processedIds: string[];
  /** IDs of items that were confirmed (subset of processedIds) */
  confirmedIds: string[];
  /** Conversation/chat ID (source-agnostic) */
  conversationId: string;
  /** Message reference for updates (source-agnostic) */
  messageRef: string;
  /** Original synthesis date if provided */
  synthesisDate?: string;
  /** Original focus topic if provided */
  focusTopic?: string;
  /** Creation timestamp */
  createdAt: number;
}

/**
 * Result of navigation operations.
 */
export interface ExtractionCarouselNavResult {
  item: ExtractionCarouselItem;
  index: number;
  total: number;
  remaining: number;
}

/**
 * Input for creating extraction carousel.
 * Uses source-agnostic identifiers.
 */
export interface CreateExtractionCarouselInput {
  /** Conversation/chat ID (source-agnostic) */
  conversationId: string;
  /** Message reference for updates (source-agnostic, string for flexibility) */
  messageRef: string;
  projects: ExtractedProject[];
  tasks: ExtractedTask[];
  commitments: ExtractedCommitment[];
  synthesisDate?: string;
  focusTopic?: string;
}

/**
 * Service for managing extraction carousel state in Redis.
 *
 * Unlike CarouselStateService (for ExtractedEvents from DB),
 * this stores the extracted items directly in Redis since they
 * haven't been persisted to the database yet.
 *
 * Flow:
 * 1. User triggers extraction from /daily synthesis
 * 2. Claude extracts projects, tasks, commitments
 * 3. Carousel is created with all items
 * 4. User navigates and confirms/skips each item
 * 5. Confirmed items are created as Activities/Commitments
 *
 * Redis key format: extraction_carousel:{carouselId}
 * TTL: 1 hour (shorter than event carousel since these are temporary)
 */
@Injectable()
export class ExtractionCarouselStateService {
  private readonly logger = new Logger(ExtractionCarouselStateService.name);
  private readonly KEY_PREFIX = 'extraction_carousel:';
  private readonly TTL_SECONDS = 3600; // 1 hour

  constructor(
    @InjectRedis()
    private readonly redis: Redis,
  ) {}

  /**
   * Create a new extraction carousel and return its ID.
   *
   * Items are ordered: projects first, then tasks, then commitments.
   *
   * @param input - Extraction results and Telegram context
   * @returns Carousel ID for callback_data (e.g., "ec_a1b2c3d4e5f6")
   */
  async create(input: CreateExtractionCarouselInput): Promise<string> {
    // Build unified items list
    const items: ExtractionCarouselItem[] = [];

    // Defensive: ensure arrays exist
    const projects = input.projects ?? [];
    const tasks = input.tasks ?? [];
    const commitments = input.commitments ?? [];

    // Add projects
    projects.forEach((project, idx) => {
      items.push({
        id: `project_${idx}`,
        type: 'project',
        data: project,
      });
    });

    // Add tasks
    tasks.forEach((task, idx) => {
      items.push({
        id: `task_${idx}`,
        type: 'task',
        data: task,
      });
    });

    // Add commitments
    commitments.forEach((commitment, idx) => {
      items.push({
        id: `commitment_${idx}`,
        type: 'commitment',
        data: commitment,
      });
    });

    if (items.length === 0) {
      throw new Error('Cannot create carousel with no extracted items');
    }

    // Generate short ID: "ec_" + 12 hex chars = 15 chars total
    const carouselId = `ec_${randomBytes(6).toString('hex')}`;
    const key = `${this.KEY_PREFIX}${carouselId}`;

    const state: ExtractionCarouselState = {
      items,
      currentIndex: 0,
      processedIds: [],
      confirmedIds: [],
      conversationId: input.conversationId,
      messageRef: input.messageRef,
      synthesisDate: input.synthesisDate,
      focusTopic: input.focusTopic,
      createdAt: Date.now(),
    };

    await this.redis.setex(key, this.TTL_SECONDS, JSON.stringify(state));

    this.logger.log(
      `Created extraction carousel ${carouselId} with ${items.length} items ` +
        `(${projects.length} projects, ${tasks.length} tasks, ` +
        `${commitments.length} commitments) for conversation ${input.conversationId}`,
    );

    return carouselId;
  }

  /**
   * Get carousel state by ID.
   *
   * @param carouselId - Carousel ID from callback_data
   * @returns ExtractionCarouselState or null if not found/expired
   */
  async get(carouselId: string): Promise<ExtractionCarouselState | null> {
    const key = `${this.KEY_PREFIX}${carouselId}`;
    const data = await this.redis.get(key);

    if (!data) {
      this.logger.warn(`Extraction carousel not found: ${carouselId}`);
      return null;
    }

    try {
      return JSON.parse(data) as ExtractionCarouselState;
    } catch (error) {
      this.logger.error(`Failed to parse extraction carousel state: ${carouselId}`);
      return null;
    }
  }

  /**
   * Get the current item in the carousel.
   *
   * @param carouselId - Carousel ID
   * @returns Current item with position info, or null if carousel finished/invalid
   */
  async getCurrentItem(carouselId: string): Promise<ExtractionCarouselNavResult | null> {
    const state = await this.get(carouselId);
    if (!state) return null;

    // Find next unprocessed item starting from currentIndex
    const unprocessedIndex = this.findNextUnprocessed(state, state.currentIndex);

    if (unprocessedIndex === -1) {
      // All items processed
      return null;
    }

    const item = state.items[unprocessedIndex];
    const remaining = state.items.filter(
      (i) => !state.processedIds.includes(i.id),
    ).length;

    // Update currentIndex if it changed
    if (unprocessedIndex !== state.currentIndex) {
      state.currentIndex = unprocessedIndex;
      await this.save(carouselId, state);
    }

    return {
      item,
      index: unprocessedIndex,
      total: state.items.length,
      remaining,
    };
  }

  /**
   * Navigate to the next unprocessed item.
   *
   * @param carouselId - Carousel ID
   * @returns Next item or null if no more items
   */
  async next(carouselId: string): Promise<ExtractionCarouselNavResult | null> {
    const state = await this.get(carouselId);
    if (!state) return null;

    // Find next unprocessed item after currentIndex
    const nextIndex = this.findNextUnprocessed(state, state.currentIndex + 1);

    if (nextIndex === -1) {
      // Wrap around to beginning
      const wrappedIndex = this.findNextUnprocessed(state, 0);
      if (wrappedIndex === -1 || wrappedIndex === state.currentIndex) {
        // No more unprocessed items
        return null;
      }
      state.currentIndex = wrappedIndex;
    } else {
      state.currentIndex = nextIndex;
    }

    await this.save(carouselId, state);
    return this.getCurrentItem(carouselId);
  }

  /**
   * Navigate to the previous unprocessed item.
   *
   * @param carouselId - Carousel ID
   * @returns Previous item or null if no more items
   */
  async prev(carouselId: string): Promise<ExtractionCarouselNavResult | null> {
    const state = await this.get(carouselId);
    if (!state) return null;

    // Find previous unprocessed item before currentIndex
    const prevIndex = this.findPrevUnprocessed(state, state.currentIndex - 1);

    if (prevIndex === -1) {
      // Wrap around to end
      const wrappedIndex = this.findPrevUnprocessed(state, state.items.length - 1);
      if (wrappedIndex === -1 || wrappedIndex === state.currentIndex) {
        // No more unprocessed items
        return null;
      }
      state.currentIndex = wrappedIndex;
    } else {
      state.currentIndex = prevIndex;
    }

    await this.save(carouselId, state);
    return this.getCurrentItem(carouselId);
  }

  /**
   * Mark an item as confirmed (will be created).
   *
   * @param carouselId - Carousel ID
   * @param itemId - Item ID to confirm
   */
  async confirm(carouselId: string, itemId: string): Promise<void> {
    const state = await this.get(carouselId);
    if (!state) return;

    if (!state.processedIds.includes(itemId)) {
      state.processedIds.push(itemId);
    }
    if (!state.confirmedIds.includes(itemId)) {
      state.confirmedIds.push(itemId);
    }

    await this.save(carouselId, state);
    this.logger.debug(`Confirmed item ${itemId} in carousel ${carouselId}`);
  }

  /**
   * Mark an item as skipped (will not be created).
   *
   * @param carouselId - Carousel ID
   * @param itemId - Item ID to skip
   */
  async skip(carouselId: string, itemId: string): Promise<void> {
    const state = await this.get(carouselId);
    if (!state) return;

    if (!state.processedIds.includes(itemId)) {
      state.processedIds.push(itemId);
    }
    // Don't add to confirmedIds - this is the difference from confirm()

    await this.save(carouselId, state);
    this.logger.debug(`Skipped item ${itemId} in carousel ${carouselId}`);
  }

  /**
   * Check if all items in carousel have been processed.
   *
   * @param carouselId - Carousel ID
   * @returns true if all items processed
   */
  async isComplete(carouselId: string): Promise<boolean> {
    const state = await this.get(carouselId);
    if (!state) return true;

    return state.processedIds.length >= state.items.length;
  }

  /**
   * Get all confirmed items for persistence.
   *
   * @param carouselId - Carousel ID
   * @returns Confirmed items grouped by type
   */
  async getConfirmedItems(carouselId: string): Promise<{
    projects: ExtractedProject[];
    tasks: ExtractedTask[];
    commitments: ExtractedCommitment[];
  } | null> {
    const state = await this.get(carouselId);
    if (!state) return null;

    const projects: ExtractedProject[] = [];
    const tasks: ExtractedTask[] = [];
    const commitments: ExtractedCommitment[] = [];

    for (const itemId of state.confirmedIds) {
      const item = state.items.find((i) => i.id === itemId);
      if (!item) continue;

      switch (item.type) {
        case 'project':
          projects.push(item.data as ExtractedProject);
          break;
        case 'task':
          tasks.push(item.data as ExtractedTask);
          break;
        case 'commitment':
          commitments.push(item.data as ExtractedCommitment);
          break;
      }
    }

    return { projects, tasks, commitments };
  }

  /**
   * Get summary statistics for carousel completion.
   *
   * @param carouselId - Carousel ID
   * @returns Stats about confirmed/skipped items
   */
  async getStats(carouselId: string): Promise<{
    total: number;
    processed: number;
    confirmed: number;
    skipped: number;
    confirmedByType: { projects: number; tasks: number; commitments: number };
  } | null> {
    const state = await this.get(carouselId);
    if (!state) return null;

    const confirmedByType = { projects: 0, tasks: 0, commitments: 0 };

    for (const itemId of state.confirmedIds) {
      const item = state.items.find((i) => i.id === itemId);
      if (!item) continue;

      switch (item.type) {
        case 'project':
          confirmedByType.projects++;
          break;
        case 'task':
          confirmedByType.tasks++;
          break;
        case 'commitment':
          confirmedByType.commitments++;
          break;
      }
    }

    return {
      total: state.items.length,
      processed: state.processedIds.length,
      confirmed: state.confirmedIds.length,
      skipped: state.processedIds.length - state.confirmedIds.length,
      confirmedByType,
    };
  }

  /**
   * Delete carousel state.
   *
   * @param carouselId - Carousel ID to delete
   */
  async delete(carouselId: string): Promise<void> {
    const key = `${this.KEY_PREFIX}${carouselId}`;
    await this.redis.del(key);
    this.logger.debug(`Deleted extraction carousel: ${carouselId}`);
  }

  /**
   * Update the message reference for a carousel.
   * Used when carousel is created before message is sent.
   *
   * @param carouselId - Carousel ID
   * @param messageRef - New message reference (source-agnostic)
   */
  async updateMessageRef(carouselId: string, messageRef: string): Promise<void> {
    const state = await this.get(carouselId);
    if (!state) {
      this.logger.warn(`Cannot update messageRef: carousel ${carouselId} not found`);
      return;
    }

    state.messageRef = messageRef;
    await this.save(carouselId, state);
    this.logger.debug(`Updated carousel ${carouselId} messageRef to ${messageRef}`);
  }

  // ─────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────

  /**
   * Save carousel state to Redis.
   */
  private async save(carouselId: string, state: ExtractionCarouselState): Promise<void> {
    const key = `${this.KEY_PREFIX}${carouselId}`;
    // Refresh TTL on each save
    await this.redis.setex(key, this.TTL_SECONDS, JSON.stringify(state));
  }

  /**
   * Find next unprocessed item index starting from given index.
   * Returns -1 if none found.
   */
  private findNextUnprocessed(
    state: ExtractionCarouselState,
    startIndex: number,
  ): number {
    for (let i = startIndex; i < state.items.length; i++) {
      if (!state.processedIds.includes(state.items[i].id)) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Find previous unprocessed item index starting from given index.
   * Returns -1 if none found.
   */
  private findPrevUnprocessed(
    state: ExtractionCarouselState,
    startIndex: number,
  ): number {
    for (let i = startIndex; i >= 0; i--) {
      if (!state.processedIds.includes(state.items[i].id)) {
        return i;
      }
    }
    return -1;
  }
}
