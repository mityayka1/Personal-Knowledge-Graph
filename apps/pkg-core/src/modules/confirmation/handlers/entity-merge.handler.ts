import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import {
  PendingConfirmation,
  PendingConfirmationStatus,
  PendingConfirmationType,
} from '@pkg/entities';
import { EntityService } from '../../entity/entity.service';

/**
 * Handler for ENTITY_MERGE confirmation resolutions.
 *
 * When a user confirms entity merge, this handler:
 * 1. Calls EntityService.merge(sourceId, targetId)
 * 2. The merge moves identifiers, facts, and soft-deletes the source entity
 */
@Injectable()
export class EntityMergeHandler {
  private readonly logger = new Logger(EntityMergeHandler.name);

  constructor(
    @Optional()
    @Inject(forwardRef(() => EntityService))
    private readonly entityService: EntityService | null,
  ) {}

  /**
   * Handle a resolved ENTITY_MERGE confirmation.
   *
   * Expected context structure:
   * - context.sourceEntityId — the entity to merge FROM (will be soft-deleted)
   * - context.targetEntityId — the entity to merge INTO (will receive data)
   *
   * Expected option structure:
   * - option.entityId — the target entity ID (redundant with context, used for UI)
   *
   * @param confirmation - The resolved confirmation
   */
  async handle(confirmation: PendingConfirmation): Promise<void> {
    if (confirmation.type !== PendingConfirmationType.ENTITY_MERGE) {
      this.logger.warn(
        `EntityMergeHandler called with wrong type: ${confirmation.type}`,
      );
      return;
    }

    if (confirmation.status !== PendingConfirmationStatus.CONFIRMED) {
      this.logger.debug(
        `Confirmation ${confirmation.id} is ${confirmation.status}, skipping`,
      );
      return;
    }

    if (!this.entityService) {
      throw new Error(
        `EntityService not available for confirmation ${confirmation.id}`,
      );
    }

    // Find the selected option
    const selectedOption = confirmation.options.find(
      (o) => o.id === confirmation.selectedOptionId,
    );

    if (!selectedOption) {
      throw new Error(
        `Selected option ${confirmation.selectedOptionId} not found in confirmation ${confirmation.id}`,
      );
    }

    // Handle "Skip/Decline" option
    if (selectedOption.isDecline) {
      this.logger.debug(
        `Confirmation ${confirmation.id} was declined via skip option`,
      );
      return;
    }

    // Extract entity IDs from context
    const context = confirmation.context as unknown as Record<string, unknown> | null;
    const sourceEntityId = context?.sourceEntityId as string | undefined;
    const targetEntityId = context?.targetEntityId as string | undefined;

    if (!sourceEntityId || !targetEntityId) {
      throw new Error(
        `Missing sourceEntityId or targetEntityId in context for confirmation ${confirmation.id}`,
      );
    }

    await this.mergeEntities(sourceEntityId, targetEntityId, confirmation.id);
  }

  /**
   * Execute the entity merge via EntityService.
   */
  private async mergeEntities(
    sourceId: string,
    targetId: string,
    confirmationId: string,
  ): Promise<void> {
    const result = await this.entityService!.merge(sourceId, targetId);

    this.logger.log(
      `Merged entity ${sourceId} into ${targetId}: ` +
      `${result.identifiersMoved} identifiers, ${result.factsMoved} facts moved ` +
      `(confirmation ${confirmationId})`,
    );
  }
}
