import { Injectable, Logger } from '@nestjs/common';
import {
  PendingConfirmation,
  PendingConfirmationStatus,
  PendingConfirmationType,
} from '@pkg/entities';
import { PendingFactService } from '../../resolution/pending-fact/pending-fact.service';

/**
 * Confidence threshold for auto-approving pending facts after subject resolution.
 * If the original extraction had confidence >= this value, auto-approve the fact.
 */
const AUTO_APPROVE_CONFIDENCE_THRESHOLD = 0.8;

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

  constructor(private readonly pendingFactService: PendingFactService) {}

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
      this.logger.log(
        `User chose to create new entity for confirmation ${confirmation.id}`,
      );
      // TODO: Create new entity and link to pending fact
      // For now, just log and return
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

    // Update the pending fact with the resolved entity
    if (confirmation.sourcePendingFactId) {
      await this.updatePendingFact(
        confirmation.sourcePendingFactId,
        entityId,
        confirmation.confidence,
      );
    } else {
      this.logger.warn(
        `Confirmation ${confirmation.id} has no sourcePendingFactId to update`,
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
        confidence >= AUTO_APPROVE_CONFIDENCE_THRESHOLD
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
}
