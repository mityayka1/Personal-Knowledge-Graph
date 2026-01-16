import { Controller, Get, Param, Logger, NotFoundException } from '@nestjs/common';
import { DigestActionStoreService } from './digest-action-store.service';

/**
 * Controller for retrieving digest action event IDs.
 * Used by telegram-adapter to resolve short IDs to event UUIDs.
 */
@Controller('digest-actions')
export class DigestActionController {
  private readonly logger = new Logger(DigestActionController.name);

  constructor(private readonly digestActionStore: DigestActionStoreService) {}

  /**
   * Get event IDs by digest short ID
   * GET /digest-actions/:shortId
   */
  @Get(':shortId')
  async getEventIds(@Param('shortId') shortId: string): Promise<{ eventIds: string[] | null }> {
    this.logger.log(`Getting event IDs for short ID: ${shortId}`);

    const eventIds = await this.digestActionStore.get(shortId);

    if (eventIds === null) {
      throw new NotFoundException('Short ID not found or expired');
    }

    return { eventIds };
  }
}
