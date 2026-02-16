import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  PendingConfirmation,
  PendingConfirmationStatus,
  PendingConfirmationType,
  EntityFact,
} from '@pkg/entities';

/**
 * Handler for FACT_VALUE confirmation resolutions.
 *
 * When a user confirms the value of a fact, this handler:
 * 1. Finds the EntityFact by ID from the selected option
 * 2. Updates the fact's value with the confirmed value
 */
@Injectable()
export class FactValueHandler {
  private readonly logger = new Logger(FactValueHandler.name);

  constructor(
    @InjectRepository(EntityFact)
    private readonly factRepo: Repository<EntityFact>,
  ) {}

  /**
   * Handle a resolved FACT_VALUE confirmation.
   *
   * Expected option structure:
   * - option.id — unique option ID
   * - option.entityId — not used directly; fact is identified via context
   * - context.factId — the EntityFact ID to update
   * - resolution.newValue — the new value to set (from selected option label or resolution data)
   *
   * @param confirmation - The resolved confirmation
   */
  async handle(confirmation: PendingConfirmation): Promise<void> {
    if (confirmation.type !== PendingConfirmationType.FACT_VALUE) {
      this.logger.warn(
        `FactValueHandler called with wrong type: ${confirmation.type}`,
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

    // Extract fact ID from context
    const context = confirmation.context as unknown as Record<string, unknown> | null;
    const factId = context?.factId as string | undefined;

    if (!factId) {
      throw new Error(
        `No factId found in context for confirmation ${confirmation.id}`,
      );
    }

    // Determine new value: from resolution data or selected option label
    const newValue =
      (confirmation.resolution?.newValue as string) ??
      selectedOption.label;

    if (!newValue) {
      throw new Error(
        `No new value found for confirmation ${confirmation.id}`,
      );
    }

    await this.updateFactValue(factId, newValue, confirmation.id);
  }

  /**
   * Update the EntityFact value.
   */
  private async updateFactValue(
    factId: string,
    newValue: string,
    confirmationId: string,
  ): Promise<void> {
    const fact = await this.factRepo.findOne({ where: { id: factId } });

    if (!fact) {
      throw new Error(`EntityFact ${factId} not found for confirmation ${confirmationId}`);
    }

    const oldValue = fact.value;
    fact.value = newValue;

    await this.factRepo.save(fact);
    this.logger.log(
      `Updated fact ${factId} value from "${oldValue}" to "${newValue}" (confirmation ${confirmationId})`,
    );
  }
}
