import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import {
  PendingConfirmation,
  PendingConfirmationStatus,
  PendingConfirmationType,
  IdentifierType,
} from '@pkg/entities';
import { EntityIdentifierService } from '../../entity/entity-identifier/entity-identifier.service';

/**
 * Handler for IDENTIFIER_ATTRIBUTION confirmation resolutions.
 *
 * When a user confirms which entity an identifier belongs to, this handler:
 * 1. Creates or links the EntityIdentifier to the selected Entity
 */
@Injectable()
export class IdentifierAttributionHandler {
  private readonly logger = new Logger(IdentifierAttributionHandler.name);

  constructor(
    @Optional()
    @Inject(forwardRef(() => EntityIdentifierService))
    private readonly identifierService: EntityIdentifierService | null,
  ) {}

  /**
   * Handle a resolved IDENTIFIER_ATTRIBUTION confirmation.
   *
   * Expected context structure:
   * - context.identifierType — the type of identifier (e.g., 'phone', 'telegram_user_id')
   * - context.identifierValue — the identifier value
   *
   * Expected option structure:
   * - option.entityId — the Entity ID to link the identifier to
   *
   * @param confirmation - The resolved confirmation
   */
  async handle(confirmation: PendingConfirmation): Promise<void> {
    if (confirmation.type !== PendingConfirmationType.IDENTIFIER_ATTRIBUTION) {
      this.logger.warn(
        `IdentifierAttributionHandler called with wrong type: ${confirmation.type}`,
      );
      return;
    }

    if (confirmation.status !== PendingConfirmationStatus.CONFIRMED) {
      this.logger.debug(
        `Confirmation ${confirmation.id} is ${confirmation.status}, skipping`,
      );
      return;
    }

    if (!this.identifierService) {
      throw new Error(
        `EntityIdentifierService not available for confirmation ${confirmation.id}`,
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

    // Get entity ID from selected option
    const entityId = selectedOption.entityId;
    if (!entityId) {
      throw new Error(
        `Selected option ${selectedOption.id} has no entityId for confirmation ${confirmation.id}`,
      );
    }

    // Extract identifier details from context
    const context = confirmation.context as unknown as Record<string, unknown> | null;
    const identifierType = context?.identifierType as string | undefined;
    const identifierValue = context?.identifierValue as string | undefined;

    if (!identifierType || !identifierValue) {
      throw new Error(
        `Missing identifierType or identifierValue in context for confirmation ${confirmation.id}`,
      );
    }

    await this.createIdentifier(
      entityId,
      identifierType as IdentifierType,
      identifierValue,
      confirmation.id,
    );
  }

  /**
   * Create the EntityIdentifier linking identifier to entity.
   */
  private async createIdentifier(
    entityId: string,
    identifierType: IdentifierType,
    identifierValue: string,
    confirmationId: string,
  ): Promise<void> {
    try {
      await this.identifierService!.create(entityId, {
        type: identifierType,
        value: identifierValue,
      });

      this.logger.log(
        `Created identifier ${identifierType}:${identifierValue} for entity ${entityId} (confirmation ${confirmationId})`,
      );
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));

      // ConflictException means identifier already exists — not a critical error
      if (err.message?.includes('already exists')) {
        this.logger.warn(
          `Identifier ${identifierType}:${identifierValue} already exists (confirmation ${confirmationId})`,
        );
        return;
      }

      throw error;
    }
  }
}
