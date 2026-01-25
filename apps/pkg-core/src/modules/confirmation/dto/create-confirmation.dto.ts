import {
  PendingConfirmationType,
  ConfirmationContext,
  ConfirmationOption,
} from '@pkg/entities';

export class CreateConfirmationDto {
  type: PendingConfirmationType;
  context: ConfirmationContext;
  options: ConfirmationOption[];
  confidence?: number;
  sourceMessageId?: string;
  sourceEntityId?: string;
  sourcePendingFactId?: string;
}
