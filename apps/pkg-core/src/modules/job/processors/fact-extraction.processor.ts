import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, forwardRef, Logger } from '@nestjs/common';
import { Job as BullJob } from 'bullmq';
import { UnifiedExtractionService } from '../../extraction/unified-extraction.service';
import { EntityService } from '../../entity/entity.service';
import { ExtractionJobData } from '../job.service';

@Processor('fact-extraction')
export class FactExtractionProcessor extends WorkerHost {
  private readonly logger = new Logger(FactExtractionProcessor.name);

  constructor(
    @Inject(forwardRef(() => UnifiedExtractionService))
    private unifiedExtractionService: UnifiedExtractionService,
    @Inject(forwardRef(() => EntityService))
    private entityService: EntityService,
  ) {
    super();
  }

  async process(job: BullJob<ExtractionJobData>) {
    const { interactionId, entityId, messages } = job.data;

    this.logger.log(
      `Processing extraction job ${job.id} for entity ${entityId} with ${messages.length} messages`,
    );

    try {
      // Get entity info
      const entity = await this.entityService.findOne(entityId);

      // Skip extraction for bot entities
      if (entity.isBot) {
        this.logger.debug(
          `Skipping extraction for bot entity ${entityId} (${entity.name})`,
        );
        return { success: true, skipped: 'bot' };
      }

      // Single unified extraction call replaces 3 separate flows:
      // 1. FactExtractionService.extractFactsAgentBatch()
      // 2. EventExtractionService.extractEventsBatch()
      // 3. SecondBrainExtractionService.extractFromMessages()
      const result = await this.unifiedExtractionService.extract({
        entityId,
        entityName: entity.name,
        messages,
        interactionId,
      });

      this.logger.log(
        `Extraction job ${job.id} completed: ${result.factsCreated} facts, ` +
          `${result.eventsCreated} events, ${result.relationsCreated} relations, ` +
          `${result.pendingEntities} pending entities`,
      );

      return {
        success: true,
        factsCreated: result.factsCreated,
        eventsCreated: result.eventsCreated,
        relationsCreated: result.relationsCreated,
        pendingEntities: result.pendingEntities,
      };
    } catch (error: any) {
      this.logger.error(`Extraction job ${job.id} failed: ${error.message}`, error.stack);
      throw error;
    }
  }
}
