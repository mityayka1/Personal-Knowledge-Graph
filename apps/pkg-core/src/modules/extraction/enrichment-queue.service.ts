import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EnrichmentJobData } from './enrichment.processor';

/**
 * Service for managing the enrichment queue.
 * Adds events that need context enrichment to the processing queue.
 */
@Injectable()
export class EnrichmentQueueService {
  private readonly logger = new Logger(EnrichmentQueueService.name);

  constructor(
    @InjectQueue('enrichment')
    private readonly enrichmentQueue: Queue<EnrichmentJobData>,
  ) {}

  /**
   * Add an event to the enrichment queue
   * @param eventId - UUID of the event that needs enrichment
   * @param delay - Optional delay in milliseconds before processing
   */
  async queueForEnrichment(eventId: string, delay?: number): Promise<void> {
    const jobOptions: { delay?: number; jobId: string } = {
      jobId: `enrich-${eventId}`, // Prevent duplicate jobs for same event
    };

    if (delay) {
      jobOptions.delay = delay;
    }

    await this.enrichmentQueue.add(
      'enrich-event',
      { eventId },
      jobOptions,
    );

    this.logger.debug(`Queued event ${eventId} for enrichment`);
  }

  /**
   * Add multiple events to the enrichment queue
   * @param eventIds - UUIDs of events that need enrichment
   * @param delay - Optional delay in milliseconds between jobs
   */
  async queueBatchForEnrichment(
    eventIds: string[],
    delay?: number,
  ): Promise<void> {
    for (let i = 0; i < eventIds.length; i++) {
      const eventId = eventIds[i];
      // Stagger jobs slightly to avoid overwhelming the LLM
      const staggerDelay = delay ? delay + i * 1000 : i * 1000;
      await this.queueForEnrichment(eventId, staggerDelay);
    }

    this.logger.log(
      `Queued ${eventIds.length} events for enrichment${delay ? ` with ${delay}ms initial delay` : ''}`,
    );
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
  }> {
    const [waiting, active, completed, failed] = await Promise.all([
      this.enrichmentQueue.getWaitingCount(),
      this.enrichmentQueue.getActiveCount(),
      this.enrichmentQueue.getCompletedCount(),
      this.enrichmentQueue.getFailedCount(),
    ]);

    return { waiting, active, completed, failed };
  }
}
