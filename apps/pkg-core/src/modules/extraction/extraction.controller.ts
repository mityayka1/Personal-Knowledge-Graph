import { Controller, Post, Body, Param, Get, Query, NotFoundException, BadRequestException, Inject, forwardRef, Logger, Optional } from '@nestjs/common';
import { PendingApprovalStatus } from '@pkg/entities';
import { FactExtractionService } from './fact-extraction.service';
import { RelationInferenceService, InferenceResult } from './relation-inference.service';
import { DailySynthesisExtractionService } from './daily-synthesis-extraction.service';
import { MessageData } from './extraction.types';
import { MessageService } from '../interaction/message/message.service';
import { EntityService } from '../entity/entity.service';
import { PendingApprovalService } from '../pending-approval/pending-approval.service';
import { JobService } from '../job/job.service';

interface ExtractFactsDto {
  entityId: string;
  entityName: string;
  messageContent: string;
  messageId?: string;
  interactionId?: string;
}

interface ExtractFactsAgentDto {
  entityId: string;
  entityName: string;
  messageContent: string;
  messageId?: string;
  interactionId?: string;
  context?: {
    isOutgoing?: boolean;
    chatType?: string;
    senderName?: string;
  };
}

/**
 * DTO for daily synthesis extract-and-save endpoint.
 * Creates draft entities + pending approvals from synthesis text.
 */
interface ExtractAndSaveDto {
  /** Synthesis text to analyze */
  synthesisText: string;
  /** Owner entity ID (usually user's own entity) */
  ownerEntityId: string;
  /** Date of synthesis (ISO 8601, e.g., "2026-01-31") */
  date?: string;
  /** Focus topic for extraction */
  focusTopic?: string;
  /** Message reference for Telegram UI updates (e.g., "telegram:chat:123:msg:456") */
  messageRef?: string;
  /** Source interaction ID for tracking */
  sourceInteractionId?: string;
}

@Controller('extraction')
export class ExtractionController {
  private readonly logger = new Logger(ExtractionController.name);

  constructor(
    private extractionService: FactExtractionService,
    private relationInferenceService: RelationInferenceService,
    @Inject(forwardRef(() => MessageService))
    private messageService: MessageService,
    @Inject(forwardRef(() => EntityService))
    private entityService: EntityService,
    @Optional()
    @Inject(forwardRef(() => DailySynthesisExtractionService))
    private dailySynthesisService: DailySynthesisExtractionService | null,
    @Inject(forwardRef(() => PendingApprovalService))
    private pendingApprovalService: PendingApprovalService,
    @Inject(forwardRef(() => JobService))
    private jobService: JobService,
  ) {}

  @Post('facts')
  async extractFacts(@Body() dto: ExtractFactsDto) {
    return this.extractionService.extractFacts(dto);
  }

  /**
   * Agent mode extraction with tools for cross-entity routing.
   * POST /extraction/facts/agent
   *
   * Features:
   * - Uses MCP tools for lazy context loading
   * - Creates facts for mentioned entities (not just primary)
   * - Creates relations between entities
   * - Creates pending entities for unknown people
   */
  @Post('facts/agent')
  async extractFactsAgent(@Body() dto: ExtractFactsAgentDto) {
    return this.extractionService.extractFactsAgent(dto);
  }

  /**
   * Extract facts from entity's message history and notes
   * GET /extraction/entity/:entityId/facts
   */
  @Get('entity/:entityId/facts')
  async extractFactsFromHistory(@Param('entityId') entityId: string) {
    this.logger.log(`[extractFactsFromHistory] Starting extraction for entity ${entityId}`);

    // 1. Get entity
    const entity = await this.entityService.findOne(entityId);
    if (!entity) {
      this.logger.warn(`[extractFactsFromHistory] Entity ${entityId} not found`);
      throw new NotFoundException(`Entity ${entityId} not found`);
    }
    this.logger.log(`[extractFactsFromHistory] Found entity: ${entity.name}`);

    // 2. Get messages from this entity
    const messages = await this.messageService.findByEntity(entityId, 50);
    this.logger.log(`[extractFactsFromHistory] Found ${messages.length} messages`);

    // 3. Build content array: notes (if any) + messages
    const contentItems: Array<{ id: string; content: string; interactionId?: string }> = [];

    // Always include notes if present (as first item for priority)
    if (entity.notes && entity.notes.trim().length > 10) {
      contentItems.push({
        id: 'notes',
        content: `[ЗАМЕТКИ О КОНТАКТЕ]: ${entity.notes}`,
      });
      this.logger.log(`[extractFactsFromHistory] Added notes to content`);
    }

    // Add messages with content
    const messagesWithContent = messages
      .filter(m => m.content && m.content.trim().length > 10)
      .map(m => ({
        id: m.id,
        content: m.content!,
        interactionId: m.interactionId,
      }));

    contentItems.push(...messagesWithContent);
    this.logger.log(`[extractFactsFromHistory] Total content items: ${contentItems.length} (${messagesWithContent.length} messages with content > 10 chars)`);

    // No extractable content at all
    if (contentItems.length === 0) {
      this.logger.log(`[extractFactsFromHistory] No extractable content, returning empty`);
      return {
        entityId,
        entityName: entity.name,
        facts: [],
        messageCount: 0,
        tokensUsed: 0,
        message: 'No messages or notes found for this entity',
      };
    }

    // 4. Extract facts using batch method
    this.logger.log(`[extractFactsFromHistory] Calling extractFactsBatch with ${contentItems.length} items`);
    const result = await this.extractionService.extractFactsBatch({
      entityId,
      entityName: entity.name,
      messages: contentItems,
    });
    this.logger.log(`[extractFactsFromHistory] extractFactsBatch result: facts=${result.facts?.length || 0}, tokensUsed=${result.tokensUsed}`);

    const response = {
      ...result,
      entityName: entity.name,
      messageCount: messagesWithContent.length,
      hasNotes: !!(entity.notes && entity.notes.trim().length > 10),
    };
    this.logger.log(`[extractFactsFromHistory] Final response: ${JSON.stringify({ ...response, facts: response.facts?.length || 0 })}`);

    return response;
  }

  /**
   * Infer relations from existing facts.
   * POST /extraction/relations/infer
   *
   * Creates employment relations from company facts by matching
   * organization names in the database.
   *
   * @param dryRun - If 'true', only report what would be created
   * @param sinceDate - Only process facts created after this date (ISO 8601)
   * @param limit - Maximum number of facts to process
   */
  @Post('relations/infer')
  async inferRelations(
    @Query('dryRun') dryRun?: string,
    @Query('sinceDate') sinceDate?: string,
    @Query('limit') limit?: string,
  ): Promise<InferenceResult> {
    // Validate query parameters
    let parsedLimit: number | undefined;
    if (limit) {
      parsedLimit = parseInt(limit, 10);
      if (isNaN(parsedLimit) || parsedLimit < 1) {
        throw new BadRequestException('limit must be a positive integer');
      }
    }

    let parsedSinceDate: Date | undefined;
    if (sinceDate) {
      parsedSinceDate = new Date(sinceDate);
      if (isNaN(parsedSinceDate.getTime())) {
        throw new BadRequestException('sinceDate must be a valid ISO 8601 date');
      }
    }

    const options = {
      dryRun: dryRun === 'true',
      sinceDate: parsedSinceDate,
      limit: parsedLimit,
    };

    this.logger.log(
      `[inferRelations] Starting inference with options: ${JSON.stringify(options)}`,
    );

    return this.relationInferenceService.inferRelations(options);
  }

  /**
   * Get statistics about potential inference candidates.
   * GET /extraction/relations/infer/stats
   */
  @Get('relations/infer/stats')
  async getInferenceStats() {
    return this.relationInferenceService.getInferenceStats();
  }

  // ─────────────────────────────────────────────────────────────
  // Daily Synthesis Extraction (Draft Entities + PendingApproval)
  // ─────────────────────────────────────────────────────────────

  /**
   * Extract structured data from daily synthesis and create draft entities.
   * POST /extraction/daily/extract-and-save
   *
   * This endpoint replaces the old Redis carousel flow:
   * - Old: extract() → Redis carousel → persist()
   * - New: extractAndSave() → DRAFT entities + PendingApproval in DB
   *
   * Use /pending-approval/batch/:batchId/* endpoints for approve/reject.
   *
   * @see docs/plans/2026-01-31-refactor-extraction-carousel-to-pending-facts-plan.md
   */
  @Post('daily/extract-and-save')
  async extractAndSave(@Body() dto: ExtractAndSaveDto) {
    if (!this.dailySynthesisService) {
      throw new BadRequestException('DailySynthesisExtractionService is not available');
    }

    if (!dto.synthesisText || dto.synthesisText.trim().length < 10) {
      throw new BadRequestException('synthesisText must be at least 10 characters');
    }

    if (!dto.ownerEntityId) {
      throw new BadRequestException('ownerEntityId is required');
    }

    this.logger.log(
      `[extractAndSave] Starting extraction for owner=${dto.ownerEntityId}, ` +
        `date=${dto.date || 'today'}, focus=${dto.focusTopic || 'none'}, ` +
        `textLength=${dto.synthesisText.length}`,
    );

    const result = await this.dailySynthesisService.extractAndSave(
      {
        synthesisText: dto.synthesisText,
        ownerEntityId: dto.ownerEntityId,
        date: dto.date,
        focusTopic: dto.focusTopic,
      },
      dto.messageRef,
      dto.sourceInteractionId,
    );

    this.logger.log(
      `[extractAndSave] Complete: batch=${result.drafts.batchId}, ` +
        `projects=${result.drafts.counts.projects}, ` +
        `tasks=${result.drafts.counts.tasks}, ` +
        `commitments=${result.drafts.counts.commitments}`,
    );

    return {
      batchId: result.drafts.batchId,
      counts: result.drafts.counts,
      approvals: result.drafts.approvals.map((a) => ({
        id: a.id,
        itemType: a.itemType,
        targetId: a.targetId,
        confidence: a.confidence,
        sourceQuote: a.sourceQuote,
      })),
      extraction: {
        projectsExtracted: result.extraction.projects.length,
        tasksExtracted: result.extraction.tasks.length,
        commitmentsExtracted: result.extraction.commitments.length,
        relationsInferred: result.extraction.inferredRelations.length,
        summary: result.extraction.extractionSummary,
        tokensUsed: result.extraction.tokensUsed,
        durationMs: result.extraction.durationMs,
      },
      errors: result.drafts.errors.length > 0 ? result.drafts.errors : undefined,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Reprocess Pending (reject + re-extract)
  // ─────────────────────────────────────────────────────────────

  /**
   * Reject all PENDING approvals and re-queue extraction for their source interactions.
   * POST /extraction/reprocess-pending
   *
   * Use case: extraction logic was updated (e.g., new group chat routing),
   * and previously extracted pending items need to be re-extracted.
   */
  @Post('reprocess-pending')
  async reprocessPending() {
    this.logger.log('[reprocessPending] Starting reprocess of all pending approvals');

    // 1. Get all PENDING approvals
    const { items: pendingApprovals } = await this.pendingApprovalService.list({
      status: PendingApprovalStatus.PENDING,
      limit: 10000,
    });

    if (pendingApprovals.length === 0) {
      this.logger.log('[reprocessPending] No pending approvals found');
      return { pendingRejected: 0, batchesRejected: 0, interactionsQueued: 0 };
    }

    this.logger.log(`[reprocessPending] Found ${pendingApprovals.length} pending approvals`);

    // 2. Group by batchId for rejection
    const batchIds = [...new Set(pendingApprovals.map(a => a.batchId))];

    let totalRejected = 0;
    const rejectErrors: string[] = [];
    for (const batchId of batchIds) {
      try {
        const result = await this.pendingApprovalService.rejectBatch(batchId);
        totalRejected += result.processed;
        if (result.errors) rejectErrors.push(...result.errors);
      } catch (error) {
        rejectErrors.push(`Batch ${batchId}: ${(error as Error).message}`);
      }
    }

    this.logger.log(`[reprocessPending] Rejected ${totalRejected} items in ${batchIds.length} batches`);

    // 3. Group by sourceInteractionId for re-extraction
    const interactionIds = [...new Set(
      pendingApprovals
        .map(a => a.sourceInteractionId)
        .filter((id): id is string => id != null),
    )];

    const skippedNoInteraction = pendingApprovals.filter(a => !a.sourceInteractionId).length;

    // 4. For each interaction: load messages, convert, queue
    let interactionsQueued = 0;
    const queueErrors: string[] = [];

    for (const interactionId of interactionIds) {
      try {
        const messages = await this.messageService.findByInteraction(interactionId, 1000);

        if (messages.length === 0) {
          queueErrors.push(`Interaction ${interactionId}: no messages found`);
          continue;
        }

        // Convert Message[] → MessageData[]
        const messageData: MessageData[] = messages
          .filter(m => m.content && m.content.trim().length > 0)
          .map(m => ({
            id: m.id,
            content: m.content!,
            timestamp: m.timestamp.toISOString(),
            isOutgoing: m.isOutgoing,
            replyToSourceMessageId: m.replyToSourceMessageId ?? undefined,
            topicName: m.topicName ?? undefined,
            senderEntityId: m.senderEntityId ?? undefined,
          }));

        if (messageData.length === 0) {
          queueErrors.push(`Interaction ${interactionId}: no messages with content`);
          continue;
        }

        // entityId: use first sender entity (deprecated field, kept for compatibility)
        const entityId = messageData.find(m => m.senderEntityId)?.senderEntityId || '';

        await this.jobService.queueExtractionDirect({
          interactionId,
          entityId,
          messages: messageData,
        });

        interactionsQueued++;
      } catch (error) {
        queueErrors.push(`Interaction ${interactionId}: ${(error as Error).message}`);
      }
    }

    const allErrors = [...rejectErrors, ...queueErrors];

    this.logger.log(
      `[reprocessPending] Complete: rejected=${totalRejected}, queued=${interactionsQueued}, ` +
        `skipped=${skippedNoInteraction}, errors=${allErrors.length}`,
    );

    return {
      pendingRejected: totalRejected,
      batchesRejected: batchIds.length,
      interactionsQueued,
      skippedNoInteraction,
      errors: allErrors.length > 0 ? allErrors : undefined,
    };
  }
}
