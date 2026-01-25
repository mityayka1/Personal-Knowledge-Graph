import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  PendingConfirmation,
  PendingConfirmationStatus,
  PendingConfirmationType,
  CONFIDENCE_THRESHOLDS,
  EntityType,
  CreationSource,
  ExtractedEvent,
} from '@pkg/entities';
import { PendingFactService } from '../../resolution/pending-fact/pending-fact.service';
import { EntityService } from '../../entity/entity.service';

/**
 * Handler for FACT_SUBJECT confirmation resolutions.
 *
 * When a user confirms which entity a fact belongs to, this handler:
 * 1. Updates the pending fact with the correct entity ID
 * 2. Optionally auto-approves the fact if confidence was high
 */
@Injectable()
export class FactSubjectHandler {
  private readonly logger = new Logger(FactSubjectHandler.name);

  constructor(
    private readonly pendingFactService: PendingFactService,
    @Optional()
    @Inject(forwardRef(() => EntityService))
    private readonly entityService: EntityService | null,
    @Optional()
    @InjectRepository(ExtractedEvent)
    private readonly extractedEventRepo: Repository<ExtractedEvent> | null,
  ) {}

  /**
   * Handle a resolved FACT_SUBJECT confirmation.
   *
   * @param confirmation - The resolved confirmation
   */
  async handle(confirmation: PendingConfirmation): Promise<void> {
    // Only process confirmed fact_subject confirmations
    if (confirmation.type !== PendingConfirmationType.FACT_SUBJECT) {
      this.logger.warn(
        `FactSubjectHandler called with wrong type: ${confirmation.type}`,
      );
      return;
    }

    if (confirmation.status !== PendingConfirmationStatus.CONFIRMED) {
      this.logger.debug(
        `Confirmation ${confirmation.id} is ${confirmation.status}, skipping`,
      );
      return;
    }

    // Find the selected option
    const selectedOption = confirmation.options.find(
      (o) => o.id === confirmation.selectedOptionId,
    );

    if (!selectedOption) {
      this.logger.error(
        `Selected option ${confirmation.selectedOptionId} not found in confirmation ${confirmation.id}`,
      );
      return;
    }

    // Handle "Create new" option
    if (selectedOption.isCreateNew) {
      await this.handleCreateNewEntity(confirmation);
      return;
    }

    // Handle "Skip" option (should be marked as declined, not confirmed)
    if (selectedOption.isDecline) {
      this.logger.debug(
        `Confirmation ${confirmation.id} was declined via skip option`,
      );
      return;
    }

    // Handle entity selection
    const entityId = selectedOption.entityId;
    if (!entityId) {
      this.logger.error(
        `Selected option ${selectedOption.id} has no entityId`,
      );
      return;
    }

    // Update the source data with the resolved entity
    if (confirmation.sourcePendingFactId) {
      await this.updatePendingFact(
        confirmation.sourcePendingFactId,
        entityId,
        confirmation.confidence,
      );
    } else if (confirmation.sourceExtractedEventId) {
      await this.updateExtractedEvent(
        confirmation.sourceExtractedEventId,
        entityId,
      );
    } else {
      this.logger.warn(
        `Confirmation ${confirmation.id} has no source to update (no pendingFact or extractedEvent)`,
      );
    }
  }

  /**
   * Update the pending fact with resolved subject and optionally approve.
   */
  private async updatePendingFact(
    pendingFactId: string,
    entityId: string,
    confidence: number | null,
  ): Promise<void> {
    try {
      // Update subject
      await this.pendingFactService.updateSubject(pendingFactId, entityId);
      this.logger.log(
        `Updated pending fact ${pendingFactId} with entity ${entityId}`,
      );

      // Auto-approve if confidence was high
      if (
        confidence !== null &&
        confidence >= CONFIDENCE_THRESHOLDS.AUTO_RESOLVE
      ) {
        await this.pendingFactService.approve(pendingFactId);
        this.logger.log(
          `Auto-approved pending fact ${pendingFactId} (confidence: ${confidence})`,
        );
      }
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Failed to update pending fact ${pendingFactId}: ${err.message}`,
        err.stack,
      );
    }
  }

  /**
   * Update the extracted event with resolved entity ID.
   * This clears the needsSubjectResolution flag.
   */
  private async updateExtractedEvent(
    extractedEventId: string,
    entityId: string,
  ): Promise<void> {
    if (!this.extractedEventRepo) {
      this.logger.error(
        `Cannot update extracted event: ExtractedEvent repository not available`,
      );
      return;
    }

    try {
      const event = await this.extractedEventRepo.findOne({
        where: { id: extractedEventId },
      });

      if (!event) {
        this.logger.error(`ExtractedEvent ${extractedEventId} not found`);
        return;
      }

      // Update entityId and clear the resolution flag
      event.entityId = entityId;
      if (event.enrichmentData) {
        event.enrichmentData = {
          ...event.enrichmentData,
          needsSubjectResolution: false,
          resolvedEntityId: entityId,
        };
      }

      await this.extractedEventRepo.save(event);
      this.logger.log(
        `Updated extracted event ${extractedEventId} with entity ${entityId}`,
      );
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Failed to update extracted event ${extractedEventId}: ${err.message}`,
        err.stack,
      );
    }
  }

  /**
   * Handle "Create new entity" option selection.
   * Creates a new entity from the subject mention and links it to the pending fact.
   */
  private async handleCreateNewEntity(
    confirmation: PendingConfirmation,
  ): Promise<void> {
    if (!this.entityService) {
      this.logger.error(
        `Cannot create new entity: EntityService not available`,
      );
      return;
    }

    // Extract suggested name from context
    // Context format: { title: "О ком этот факт?", description: 'Упоминание: "Игорь"' }
    const context = confirmation.context as unknown as Record<string, unknown> | null;
    let suggestedName: string | null = null;

    if (context?.description && typeof context.description === 'string') {
      // Try to extract name from description like 'Упоминание: "Игорь"'
      const match = context.description.match(/"([^"]+)"/);
      if (match?.[1]) {
        suggestedName = match[1];
      }
    }

    if (!suggestedName) {
      this.logger.error(
        `Cannot create entity: no suggested name found in confirmation ${confirmation.id}`,
      );
      return;
    }

    try {
      // Create new entity
      const newEntity = await this.entityService.create({
        name: suggestedName,
        type: EntityType.PERSON,
        creationSource: CreationSource.EXTRACTED,
      });

      this.logger.log(
        `Created new entity ${newEntity.id} (${suggestedName}) for confirmation ${confirmation.id}`,
      );

      // Link to source data (pending fact or extracted event)
      if (confirmation.sourcePendingFactId) {
        await this.updatePendingFact(
          confirmation.sourcePendingFactId,
          newEntity.id,
          confirmation.confidence,
        );
      } else if (confirmation.sourceExtractedEventId) {
        await this.updateExtractedEvent(
          confirmation.sourceExtractedEventId,
          newEntity.id,
        );
      } else {
        this.logger.warn(
          `New entity ${newEntity.id} created but no source to link`,
        );
      }
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Failed to create new entity for confirmation ${confirmation.id}: ${err.message}`,
        err.stack,
      );
    }
  }
}
