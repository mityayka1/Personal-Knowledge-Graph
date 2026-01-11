import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EntityProfileService } from './entity-profile.service';

interface EntityProfileJobData {
  entityId: string;
}

@Processor('entity-profile')
export class EntityProfileProcessor extends WorkerHost {
  private readonly logger = new Logger(EntityProfileProcessor.name);

  constructor(private readonly entityProfileService: EntityProfileService) {
    super();
  }

  async process(job: Job<EntityProfileJobData>): Promise<{ success: boolean; profileId?: string }> {
    const { entityId } = job.data;
    this.logger.debug(`Processing profile aggregation job for entity ${entityId}`);

    try {
      const profile = await this.entityProfileService.processProfileAggregation(entityId);

      if (profile) {
        this.logger.log(`Successfully aggregated profile for entity ${entityId} → profile ${profile.id}`);
        return { success: true, profileId: profile.id };
      } else {
        this.logger.debug(`Entity ${entityId} skipped (not enough summaries)`);
        return { success: true, profileId: undefined };
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Profile aggregation failed for entity ${entityId}: ${err.message}`,
        err.stack,
      );
      throw error; // Re-throw to trigger BullMQ retry
    }
  }
}
