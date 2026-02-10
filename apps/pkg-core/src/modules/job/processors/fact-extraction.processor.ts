import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, forwardRef, Logger } from '@nestjs/common';
import { Job as BullJob } from 'bullmq';
import { Interaction } from '@pkg/entities';
import { UnifiedExtractionService } from '../../extraction/unified-extraction.service';
import { GroupExtractionService } from '../../extraction/group-extraction.service';
import { EntityService } from '../../entity/entity.service';
import { InteractionService } from '../../interaction/interaction.service';
import { ExtractionJobData } from '../job.service';

@Processor('fact-extraction')
export class FactExtractionProcessor extends WorkerHost {
  private readonly logger = new Logger(FactExtractionProcessor.name);

  constructor(
    @Inject(forwardRef(() => UnifiedExtractionService))
    private unifiedExtractionService: UnifiedExtractionService,
    @Inject(forwardRef(() => GroupExtractionService))
    private groupExtractionService: GroupExtractionService,
    @Inject(forwardRef(() => EntityService))
    private entityService: EntityService,
    @Inject(forwardRef(() => InteractionService))
    private interactionService: InteractionService,
  ) {
    super();
  }

  async process(job: BullJob<ExtractionJobData>) {
    const { interactionId, messages } = job.data;

    this.logger.log(
      `Processing extraction job ${job.id} for interaction ${interactionId} with ${messages.length} messages`,
    );

    try {
      // Determine chat type from interaction metadata
      let interaction: Interaction | null = null;
      try {
        interaction = await this.interactionService.findOne(interactionId);
      } catch (e) {
        this.logger.warn(
          `Could not load interaction ${interactionId}, falling back to private chat flow`,
        );
      }

      const chatType = interaction?.sourceMetadata?.chat_type;

      if (chatType === 'group' || chatType === 'supergroup') {
        return this.processGroupChat(job, interaction!);
      }

      return this.processPrivateChat(job);
    } catch (error: any) {
      this.logger.error(`Extraction job ${job.id} failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  private async processPrivateChat(job: BullJob<ExtractionJobData>) {
    const { interactionId, entityId, messages } = job.data;

    // Get entity info
    const entity = await this.entityService.findOne(entityId);

    // Skip extraction for bot entities
    if (entity.isBot) {
      this.logger.debug(
        `Skipping extraction for bot entity ${entityId} (${entity.name})`,
      );
      return { success: true, skipped: 'bot' };
    }

    // Single unified extraction call for facts, events, and relations
    const result = await this.unifiedExtractionService.extract({
      entityId,
      entityName: entity.name,
      messages,
      interactionId,
    });

    this.logger.log(
      `Extraction job ${job.id} completed (private): ${result.factsCreated} facts, ` +
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
  }

  private async processGroupChat(job: BullJob<ExtractionJobData>, interaction: Interaction) {
    const { interactionId, messages } = job.data;

    this.logger.log(`Processing GROUP chat extraction for interaction ${interactionId}`);

    const result = await this.groupExtractionService.extract({
      interactionId,
      messages,
      participants: interaction.participants || [],
      chatName: undefined, // Chat title is stored in ChatCategory, not Interaction
    });

    this.logger.log(
      `Extraction job ${job.id} completed (group): ${result.factsCreated} facts, ` +
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
  }
}
