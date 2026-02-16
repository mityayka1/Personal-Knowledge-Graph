import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  PendingConfirmation,
  PendingConfirmationStatus,
  PendingConfirmationType,
  PendingConfirmationResolvedBy,
} from '@pkg/entities';
import { CreateConfirmationDto } from './dto/create-confirmation.dto';
import { FactSubjectHandler } from './handlers/fact-subject.handler';
import { FactValueHandler } from './handlers/fact-value.handler';
import { IdentifierAttributionHandler } from './handlers/identifier-attribution.handler';
import { EntityMergeHandler } from './handlers/entity-merge.handler';

/**
 * Default expiry times by confirmation type (in milliseconds)
 */
const DEFAULT_EXPIRY_MS: Record<PendingConfirmationType, number> = {
  [PendingConfirmationType.IDENTIFIER_ATTRIBUTION]: 7 * 24 * 60 * 60 * 1000, // 7 days
  [PendingConfirmationType.ENTITY_MERGE]: 30 * 24 * 60 * 60 * 1000, // 30 days
  [PendingConfirmationType.FACT_SUBJECT]: 7 * 24 * 60 * 60 * 1000, // 7 days
  [PendingConfirmationType.FACT_VALUE]: 7 * 24 * 60 * 60 * 1000, // 7 days
};

@Injectable()
export class ConfirmationService {
  private readonly logger = new Logger(ConfirmationService.name);

  constructor(
    @InjectRepository(PendingConfirmation)
    private readonly repo: Repository<PendingConfirmation>,
    @Optional()
    @Inject(forwardRef(() => FactSubjectHandler))
    private readonly factSubjectHandler: FactSubjectHandler | null,
    @Optional()
    @Inject(forwardRef(() => FactValueHandler))
    private readonly factValueHandler: FactValueHandler | null,
    @Optional()
    @Inject(forwardRef(() => IdentifierAttributionHandler))
    private readonly identifierAttributionHandler: IdentifierAttributionHandler | null,
    @Optional()
    @Inject(forwardRef(() => EntityMergeHandler))
    private readonly entityMergeHandler: EntityMergeHandler | null,
  ) {}

  /**
   * Create a new pending confirmation.
   * Deduplicates if similar confirmation already exists.
   */
  async create(dto: CreateConfirmationDto): Promise<PendingConfirmation> {
    // Check for duplicate
    const existing = await this.findSimilar(dto);
    if (existing) {
      this.logger.debug(`Found existing confirmation ${existing.id} for type ${dto.type}`);
      return existing;
    }

    const confirmation = this.repo.create({
      type: dto.type,
      context: dto.context,
      options: dto.options,
      confidence: dto.confidence ?? null,
      sourceMessageId: dto.sourceMessageId ?? null,
      sourceEntityId: dto.sourceEntityId ?? null,
      sourcePendingFactId: dto.sourcePendingFactId ?? null,
      sourceExtractedEventId: dto.sourceExtractedEventId ?? null,
      status: PendingConfirmationStatus.PENDING,
      expiresAt: this.calculateExpiry(dto.type),
    });

    await this.repo.save(confirmation);
    this.logger.log(`Created confirmation ${confirmation.id} of type ${dto.type}`);

    return confirmation;
  }

  /**
   * Resolve a confirmation with user's selected option.
   * Uses atomic update to prevent race conditions.
   */
  async resolve(
    id: string,
    optionId: string,
    resolution?: Record<string, unknown>,
  ): Promise<PendingConfirmation> {
    // First, get the confirmation to check options and current status
    const confirmation = await this.repo.findOne({ where: { id } });
    if (!confirmation) {
      throw new NotFoundException(`Confirmation ${id} not found`);
    }

    // If already resolved, return as-is (idempotent)
    if (confirmation.status !== PendingConfirmationStatus.PENDING) {
      this.logger.warn(`Confirmation ${id} is already ${confirmation.status}`);
      return confirmation;
    }

    // Check if decline option
    const selectedOption = confirmation.options.find((o) => o.id === optionId);
    const isDecline = selectedOption?.isDecline || optionId === 'decline';
    const newStatus = isDecline
      ? PendingConfirmationStatus.DECLINED
      : PendingConfirmationStatus.CONFIRMED;
    const resolvedAt = new Date();

    // Use atomic update with WHERE status = 'pending' to prevent race conditions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: any = {
      status: newStatus,
      selectedOptionId: optionId,
      resolution: resolution ?? null,
      resolvedAt,
      resolvedBy: PendingConfirmationResolvedBy.USER,
    };
    const updateResult = await this.repo
      .createQueryBuilder()
      .update(PendingConfirmation)
      .set(updateData)
      .where('id = :id', { id })
      .andWhere('status = :status', { status: PendingConfirmationStatus.PENDING })
      .execute();

    // If no rows affected, someone else resolved it concurrently
    if (updateResult.affected === 0) {
      this.logger.warn(`Confirmation ${id} was resolved by another process`);
      // Re-fetch to get the current state
      const current = await this.repo.findOne({ where: { id } });
      if (!current) {
        throw new NotFoundException(`Confirmation ${id} not found`);
      }
      return current;
    }

    this.logger.log(`Resolved confirmation ${id} with option ${optionId}`);

    // Update local object for dispatch and return
    confirmation.status = newStatus;
    confirmation.selectedOptionId = optionId;
    confirmation.resolution = resolution ?? null;
    confirmation.resolvedAt = resolvedAt;
    confirmation.resolvedBy = PendingConfirmationResolvedBy.USER;

    // Dispatch to type-specific handler
    await this.dispatchResolution(confirmation);

    return confirmation;
  }

  /**
   * Dispatch a resolved confirmation to the appropriate handler.
   * Handlers apply side effects (e.g., updating pending facts).
   */
  private async dispatchResolution(
    confirmation: PendingConfirmation,
  ): Promise<void> {
    // Only dispatch confirmed resolutions
    if (confirmation.status !== PendingConfirmationStatus.CONFIRMED) {
      return;
    }

    try {
      switch (confirmation.type) {
        case PendingConfirmationType.FACT_SUBJECT:
          if (this.factSubjectHandler) {
            await this.factSubjectHandler.handle(confirmation);
          } else {
            this.logger.warn(
              `FactSubjectHandler not available for confirmation ${confirmation.id}`,
            );
          }
          break;

        case PendingConfirmationType.FACT_VALUE:
          if (this.factValueHandler) {
            await this.factValueHandler.handle(confirmation);
          } else {
            this.logger.warn(
              `FactValueHandler not available for confirmation ${confirmation.id}`,
            );
          }
          break;

        case PendingConfirmationType.IDENTIFIER_ATTRIBUTION:
          if (this.identifierAttributionHandler) {
            await this.identifierAttributionHandler.handle(confirmation);
          } else {
            this.logger.warn(
              `IdentifierAttributionHandler not available for confirmation ${confirmation.id}`,
            );
          }
          break;

        case PendingConfirmationType.ENTITY_MERGE:
          if (this.entityMergeHandler) {
            await this.entityMergeHandler.handle(confirmation);
          } else {
            this.logger.warn(
              `EntityMergeHandler not available for confirmation ${confirmation.id}`,
            );
          }
          break;

        default:
          this.logger.warn(`Unknown confirmation type: ${confirmation.type}`);
      }
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Failed to dispatch resolution for confirmation ${confirmation.id}: ${err.message}`,
        err.stack,
      );
      // Record handler failure on confirmation so callers can check resolution.handlerError
      await this.repo.update(confirmation.id, {
        resolution: {
          ...(confirmation.resolution as Record<string, unknown> ?? {}),
          handlerError: err.message,
          handlerFailedAt: new Date().toISOString(),
        },
      });
      // Don't rethrow — error is recorded in DB; rethrowing breaks Telegram approval flow
    }
  }

  /**
   * Get a confirmation by ID.
   */
  async findById(id: string): Promise<PendingConfirmation | null> {
    return this.repo.findOne({ where: { id } });
  }

  /**
   * Get pending confirmations, sorted by confidence (lower first) and date.
   */
  async getPending(options?: {
    type?: PendingConfirmationType;
    entityId?: string;
    limit?: number;
  }): Promise<PendingConfirmation[]> {
    const qb = this.repo
      .createQueryBuilder('c')
      .where('c.status = :status', { status: PendingConfirmationStatus.PENDING });

    if (options?.type) {
      qb.andWhere('c.type = :type', { type: options.type });
    }

    if (options?.entityId) {
      qb.andWhere('c.source_entity_id = :entityId', { entityId: options.entityId });
    }

    // Show lower confidence first (needs user attention more)
    // Then older items
    qb.orderBy('c.confidence', 'ASC', 'NULLS FIRST')
      .addOrderBy('c.created_at', 'ASC')
      .take(options?.limit ?? 10);

    return qb.getMany();
  }

  /**
   * Get confirmations by source entity.
   */
  async findBySourceEntity(entityId: string): Promise<PendingConfirmation[]> {
    return this.repo.find({
      where: { sourceEntityId: entityId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Expire old pending confirmations.
   */
  async expireOld(): Promise<number> {
    const result = await this.repo
      .createQueryBuilder()
      .update(PendingConfirmation)
      .set({
        status: PendingConfirmationStatus.EXPIRED,
        resolvedAt: new Date(),
        resolvedBy: PendingConfirmationResolvedBy.EXPIRED,
      })
      .where('status = :status', { status: PendingConfirmationStatus.PENDING })
      .andWhere('expires_at IS NOT NULL')
      .andWhere('expires_at < NOW()')
      .execute();

    if (result.affected && result.affected > 0) {
      this.logger.log(`Expired ${result.affected} confirmations`);
    }

    return result.affected ?? 0;
  }

  /**
   * Count pending confirmations by type.
   */
  async countPending(): Promise<Record<PendingConfirmationType, number>> {
    const results = await this.repo
      .createQueryBuilder('c')
      .select('c.type', 'type')
      .addSelect('COUNT(*)', 'count')
      .where('c.status = :status', { status: PendingConfirmationStatus.PENDING })
      .groupBy('c.type')
      .getRawMany<{ type: PendingConfirmationType; count: string }>();

    const counts: Record<PendingConfirmationType, number> = {
      [PendingConfirmationType.IDENTIFIER_ATTRIBUTION]: 0,
      [PendingConfirmationType.ENTITY_MERGE]: 0,
      [PendingConfirmationType.FACT_SUBJECT]: 0,
      [PendingConfirmationType.FACT_VALUE]: 0,
    };

    for (const r of results) {
      counts[r.type] = parseInt(r.count, 10);
    }

    return counts;
  }

  /**
   * Find similar existing confirmation (for deduplication).
   */
  private async findSimilar(dto: CreateConfirmationDto): Promise<PendingConfirmation | null> {
    const qb = this.repo
      .createQueryBuilder('c')
      .where('c.type = :type', { type: dto.type })
      .andWhere('c.status = :status', { status: PendingConfirmationStatus.PENDING });

    // Type-specific deduplication logic
    switch (dto.type) {
      case PendingConfirmationType.FACT_SUBJECT:
        // For FACT_SUBJECT, dedupe by context.description (contains subject mention)
        // This prevents multiple confirmations for the same subject name
        if (dto.context.description) {
          qb.andWhere("c.context->>'description' = :description", {
            description: dto.context.description,
          });
        } else if (dto.sourcePendingFactId) {
          qb.andWhere('c.source_pending_fact_id = :factId', {
            factId: dto.sourcePendingFactId,
          });
        } else if (dto.sourceExtractedEventId) {
          qb.andWhere('c.source_extracted_event_id = :eventId', {
            eventId: dto.sourceExtractedEventId,
          });
        }
        break;

      default:
        // Generic deduplication by source IDs
        if (dto.sourcePendingFactId) {
          qb.andWhere('c.source_pending_fact_id = :factId', {
            factId: dto.sourcePendingFactId,
          });
        } else if (dto.sourceExtractedEventId) {
          qb.andWhere('c.source_extracted_event_id = :eventId', {
            eventId: dto.sourceExtractedEventId,
          });
        } else if (dto.sourceEntityId && dto.sourceMessageId) {
          qb.andWhere('c.source_entity_id = :entityId', { entityId: dto.sourceEntityId })
            .andWhere('c.source_message_id = :messageId', { messageId: dto.sourceMessageId });
        } else if (dto.sourceEntityId) {
          // For entity merge, check by context title (which contains entity names)
          qb.andWhere('c.source_entity_id = :entityId', { entityId: dto.sourceEntityId })
            .andWhere("c.context->>'title' = :title", { title: dto.context.title });
        }
        break;
    }

    return qb.getOne();
  }

  /**
   * Calculate expiry date for confirmation type.
   */
  private calculateExpiry(type: PendingConfirmationType): Date {
    const expiryMs = DEFAULT_EXPIRY_MS[type];
    return new Date(Date.now() + expiryMs);
  }
}
