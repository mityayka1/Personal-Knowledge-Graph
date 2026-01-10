import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, forwardRef, Logger } from '@nestjs/common';
import { Job as BullJob } from 'bullmq';
import { FactExtractionService } from '../../extraction/fact-extraction.service';
import { EventExtractionService } from '../../extraction/event-extraction.service';
import { EntityService } from '../../entity/entity.service';
import { ExtractionJobData } from '../job.service';

@Processor('fact-extraction')
export class FactExtractionProcessor extends WorkerHost {
  private readonly logger = new Logger(FactExtractionProcessor.name);

  constructor(
    @Inject(forwardRef(() => FactExtractionService))
    private factExtractionService: FactExtractionService,
    @Inject(forwardRef(() => EventExtractionService))
    private eventExtractionService: EventExtractionService,
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
      // Get entity name
      const entity = await this.entityService.findOne(entityId);

      // Map messages to the format expected by extractFactsBatch
      const formattedMessages = messages.map(m => ({
        id: m.id,
        content: m.content,
        interactionId,
      }));

      // Extract facts using Claude CLI
      const factResult = await this.factExtractionService.extractFactsBatch({
        entityId,
        entityName: entity.name,
        messages: formattedMessages,
      });

      // Extract events (meetings, deadlines, commitments)
      const eventResult = await this.eventExtractionService.extractEventsBatch({
        entityId,
        entityName: entity.name,
        messages: formattedMessages,
      });

      this.logger.log(
        `Extraction job ${job.id} completed: ${factResult.facts.length} facts, ${eventResult.events.length} events extracted`,
      );

      return {
        success: true,
        factsExtracted: factResult.facts.length,
        eventsExtracted: eventResult.events.length,
      };
    } catch (error: any) {
      this.logger.error(`Extraction job ${job.id} failed: ${error.message}`, error.stack);
      throw error;
    }
  }
}
