import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ContextEnrichmentService, EnrichmentResult } from './context-enrichment.service';
import { SecondBrainExtractionService } from './second-brain-extraction.service';

/**
 * Job data for enrichment queue
 */
export interface EnrichmentJobData {
  eventId: string;
}

/**
 * Job result for enrichment queue
 */
export interface EnrichmentJobResult {
  success: boolean;
  eventId: string;
  linkedEventId?: string;
  needsContext: boolean;
  error?: string;
}

/**
 * BullMQ processor for context enrichment jobs.
 * Processes abstract events that need context from message history.
 */
@Processor('enrichment')
export class EnrichmentProcessor extends WorkerHost {
  private readonly logger = new Logger(EnrichmentProcessor.name);

  constructor(
    private readonly enrichmentService: ContextEnrichmentService,
    private readonly extractionService: SecondBrainExtractionService,
  ) {
    super();
  }

  async process(job: Job<EnrichmentJobData>): Promise<EnrichmentJobResult> {
    const { eventId } = job.data;

    this.logger.log(`Processing enrichment job ${job.id} for event ${eventId}`);

    try {
      // 1. Get the event that needs enrichment
      const event = await this.extractionService.getById(eventId);
      if (!event) {
        this.logger.warn(`Event ${eventId} not found, skipping enrichment`);
        return {
          success: false,
          eventId,
          needsContext: false,
          error: 'Event not found',
        };
      }

      // 2. Run enrichment
      const result: EnrichmentResult = await this.enrichmentService.enrichEvent(event);

      // 3. Apply enrichment result to the event
      await this.enrichmentService.applyEnrichmentResult(eventId, result);

      this.logger.log(
        `Enrichment completed for event ${eventId}: ` +
        `success=${result.success}, linkedEventId=${result.linkedEventId || 'none'}, ` +
        `needsContext=${result.needsContext}`,
      );

      return {
        success: result.success,
        eventId,
        linkedEventId: result.linkedEventId,
        needsContext: result.needsContext,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Enrichment job ${job.id} failed: ${message}`);

      // Mark as needing context on failure
      try {
        await this.extractionService.markNeedsContext(eventId);
      } catch (updateError) {
        this.logger.error(`Failed to mark event as needsContext: ${updateError}`);
      }

      throw error;
    }
  }
}
