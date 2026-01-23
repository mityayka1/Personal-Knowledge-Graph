import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  EntityEvent,
  EventStatus,
  ExtractedEvent,
  ExtractedEventStatus,
  EntityFact,
  BriefItem,
  BriefState,
} from '@pkg/entities';
import { BriefStateService } from './brief-state.service';

/**
 * Business logic service for Morning Brief operations.
 *
 * Encapsulates:
 * - Brief state retrieval and manipulation
 * - Status updates for different source types (entity_event, extracted_event, entity_fact)
 *
 * Separates business logic from HTTP/presentation concerns in BriefController.
 */
@Injectable()
export class BriefService {
  private readonly logger = new Logger(BriefService.name);

  constructor(
    private readonly briefStateService: BriefStateService,
    @InjectRepository(EntityEvent)
    private readonly entityEventRepo: Repository<EntityEvent>,
    @InjectRepository(ExtractedEvent)
    private readonly extractedEventRepo: Repository<ExtractedEvent>,
    @InjectRepository(EntityFact)
    private readonly entityFactRepo: Repository<EntityFact>,
  ) {}

  /**
   * Get brief state by ID.
   *
   * @throws NotFoundException if brief not found or expired
   */
  async getBrief(briefId: string): Promise<BriefState> {
    const state = await this.briefStateService.get(briefId);
    if (!state) {
      throw new NotFoundException('Brief not found or expired');
    }
    return state;
  }

  /**
   * Expand an item in the brief.
   *
   * @throws NotFoundException if brief not found
   */
  async expand(briefId: string, index: number): Promise<BriefState> {
    const state = await this.briefStateService.expand(briefId, index);
    if (!state) {
      throw new NotFoundException('Brief not found or expired');
    }
    return state;
  }

  /**
   * Collapse all items in the brief.
   *
   * @throws NotFoundException if brief not found
   */
  async collapse(briefId: string): Promise<BriefState> {
    const state = await this.briefStateService.collapse(briefId);
    if (!state) {
      throw new NotFoundException('Brief not found or expired');
    }
    return state;
  }

  /**
   * Mark item as done (completed).
   *
   * Updates source entity status and removes item from brief.
   *
   * @returns Updated state and whether all items are done
   * @throws NotFoundException if item or brief not found
   */
  async markDone(
    briefId: string,
    index: number,
  ): Promise<{ state: BriefState; allDone: boolean }> {
    const item = await this.briefStateService.getItem(briefId, index);
    if (!item) {
      throw new NotFoundException('Item not found');
    }

    await this.updateSourceStatus(item, EventStatus.COMPLETED);

    const state = await this.briefStateService.removeItem(briefId, index);
    if (!state) {
      throw new NotFoundException('Brief not found or expired');
    }

    this.logger.log(
      `Marked item as done: ${item.title} (${item.sourceType}:${item.sourceId})`,
    );

    return { state, allDone: state.items.length === 0 };
  }

  /**
   * Mark item as dismissed (not relevant/not going to do).
   *
   * Updates source entity status and removes item from brief.
   *
   * @returns Updated state and whether all items are processed
   * @throws NotFoundException if item or brief not found
   */
  async markDismissed(
    briefId: string,
    index: number,
  ): Promise<{ state: BriefState; allDone: boolean }> {
    const item = await this.briefStateService.getItem(briefId, index);
    if (!item) {
      throw new NotFoundException('Item not found');
    }

    await this.updateSourceStatus(item, EventStatus.DISMISSED);

    const state = await this.briefStateService.removeItem(briefId, index);
    if (!state) {
      throw new NotFoundException('Brief not found or expired');
    }

    this.logger.log(
      `Dismissed item: ${item.title} (${item.sourceType}:${item.sourceId})`,
    );

    return { state, allDone: state.items.length === 0 };
  }

  /**
   * Get a specific item from the brief.
   *
   * @throws NotFoundException if item not found
   */
  async getItem(briefId: string, index: number): Promise<BriefItem> {
    const item = await this.briefStateService.getItem(briefId, index);
    if (!item) {
      throw new NotFoundException('Item not found');
    }
    return item;
  }

  // ─────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────

  /**
   * Update status of the source entity based on sourceType.
   *
   * - entity_event: Update EventStatus
   * - extracted_event: Update ExtractedEventStatus (CONFIRMED for done, REJECTED for dismissed)
   * - entity_fact: Set validUntil to now (mark as no longer valid)
   * - entity: No status update needed (just removes from brief)
   */
  private async updateSourceStatus(
    item: BriefItem,
    status: EventStatus,
  ): Promise<void> {
    switch (item.sourceType) {
      case 'entity_event':
        await this.entityEventRepo.update(item.sourceId, { status });
        break;

      case 'extracted_event': {
        // Map EventStatus to ExtractedEventStatus
        const extractedStatus =
          status === EventStatus.COMPLETED
            ? ExtractedEventStatus.CONFIRMED
            : ExtractedEventStatus.REJECTED;
        await this.extractedEventRepo.update(item.sourceId, {
          status: extractedStatus,
          userResponseAt: new Date(),
        });
        break;
      }

      case 'entity_fact':
        // Mark fact as no longer valid by setting validUntil
        await this.entityFactRepo.update(item.sourceId, {
          validUntil: new Date(),
        });
        break;

      case 'entity':
        // Entity items don't have a status to update
        // They are informational only (e.g., birthdays)
        this.logger.debug(
          `Skipping status update for entity source: ${item.sourceId}`,
        );
        break;

      default:
        this.logger.warn(`Unknown sourceType: ${item.sourceType}`);
    }
  }
}
