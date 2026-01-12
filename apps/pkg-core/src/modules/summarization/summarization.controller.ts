import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { InteractionSummary, Interaction, EntityRelationshipProfile, EntityRecord } from '@pkg/entities';
import { SummarizationService } from './summarization.service';
import { EntityProfileService } from './entity-profile.service';

/**
 * Aggregated summarization metrics
 */
export interface SummarizationMetrics {
  // Coverage
  totalInteractions: number;
  summarizedInteractions: number;
  summarizationCoverage: number; // percentage

  // Backlog
  pendingInQueue: number;
  oldestUnsummarized: string | null; // ISO date

  // Performance
  avgCompressionRatio: number | null;

  // Quality indicators
  avgKeyPointsPerSummary: number | null;
  avgDecisionsPerSummary: number | null;
  totalOpenActionItems: number;
}

/**
 * Queue status
 */
export interface QueueStatus {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

/**
 * Helper function to safely parse numeric metrics from database results
 */
function parseNumericMetric(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const num = Number(value);
  return Number.isNaN(num) ? null : Math.round(num * 100) / 100;
}

interface SummarizationStatusResponse {
  interactionId: string;
  hasSummary: boolean;
  summary?: {
    id: string;
    summaryText: string;
    keyPoints: string[];
    tone: string | null;
    messageCount: number | null;
    compressionRatio: number | null;
    createdAt: Date;
  };
}

@Controller('summarization')
export class SummarizationController {
  constructor(
    private readonly summarizationService: SummarizationService,
    private readonly entityProfileService: EntityProfileService,
    @InjectRepository(InteractionSummary)
    private readonly summaryRepo: Repository<InteractionSummary>,
    @InjectRepository(Interaction)
    private readonly interactionRepo: Repository<Interaction>,
    @InjectRepository(EntityRelationshipProfile)
    private readonly profileRepo: Repository<EntityRelationshipProfile>,
    @InjectRepository(EntityRecord)
    private readonly entityRepo: Repository<EntityRecord>,
    @InjectQueue('summarization')
    private readonly summarizationQueue: Queue,
    @InjectQueue('entity-profile')
    private readonly entityProfileQueue: Queue,
  ) {}

  // ==================== Monitoring Endpoints ====================

  /**
   * Get aggregated summarization metrics
   */
  @Get('stats')
  async getStats(): Promise<SummarizationMetrics> {
    // Bot exclusion subquery (reusable)
    const botExclusionSubquery = `NOT EXISTS (
      SELECT 1 FROM interaction_participants ip
      INNER JOIN entities e ON e.id = ip.entity_id
      WHERE ip.interaction_id = i.id AND e.is_bot = true
    )`;

    // Execute all independent queries in parallel for better performance
    const [
      totalInteractions,
      summarizedInteractions,
      pendingInQueue,
      oldestUnsummarized,
      compressionResult,
      keyPointsResult,
      decisionsResult,
      openActionItemsResult,
    ] = await Promise.all([
      // Total completed interactions (excluding bot interactions)
      this.interactionRepo
        .createQueryBuilder('i')
        .where('i.status = :status', { status: 'completed' })
        .andWhere(botExclusionSubquery)
        .getCount(),

      // Summarized interactions (excluding those for interactions with bot participants)
      this.summaryRepo
        .createQueryBuilder('s')
        .innerJoin('interactions', 'i', 'i.id = s.interaction_id')
        .andWhere(botExclusionSubquery)
        .getCount(),

      // Pending in queue
      this.summarizationQueue.getWaitingCount(),

      // Oldest unsummarized interaction
      this.interactionRepo
        .createQueryBuilder('i')
        .where('i.status = :status', { status: 'completed' })
        .andWhere(`NOT EXISTS (
          SELECT 1 FROM interaction_summaries s WHERE s.interaction_id = i.id
        )`)
        .andWhere(botExclusionSubquery)
        .orderBy('i.ended_at', 'ASC')
        .getOne(),

      // Average compression ratio
      this.summaryRepo
        .createQueryBuilder('s')
        .select('AVG(s.compression_ratio)', 'avg')
        .where('s.compression_ratio IS NOT NULL')
        .getRawOne(),

      // Average key points per summary
      this.summaryRepo
        .createQueryBuilder('s')
        .select('AVG(jsonb_array_length(s.key_points))', 'avg')
        .getRawOne(),

      // Average decisions per summary
      this.summaryRepo
        .createQueryBuilder('s')
        .select('AVG(jsonb_array_length(s.decisions))', 'avg')
        .getRawOne(),

      // Total open action items across all summaries (using CROSS JOIN LATERAL for clarity)
      this.summaryRepo.query(`
        SELECT COUNT(*) AS count
        FROM interaction_summaries s
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.action_items, '[]'::jsonb)) AS item
        WHERE item->>'status' = 'open'
      `),
    ]);

    // Coverage percentage
    const summarizationCoverage = totalInteractions > 0
      ? Math.round((summarizedInteractions / totalInteractions) * 100 * 10) / 10
      : 0;

    return {
      totalInteractions,
      summarizedInteractions,
      summarizationCoverage,
      pendingInQueue,
      oldestUnsummarized: oldestUnsummarized?.endedAt?.toISOString() || null,
      avgCompressionRatio: parseNumericMetric(compressionResult?.avg),
      avgKeyPointsPerSummary: parseNumericMetric(keyPointsResult?.avg),
      avgDecisionsPerSummary: parseNumericMetric(decisionsResult?.avg),
      totalOpenActionItems: Number(openActionItemsResult?.[0]?.count || 0),
    };
  }

  /**
   * Get summarization queue status
   */
  @Get('queue')
  async getQueueStatus(): Promise<{ summarization: QueueStatus; entityProfile: QueueStatus }> {
    const [
      summWaiting,
      summActive,
      summCompleted,
      summFailed,
      summDelayed,
      profWaiting,
      profActive,
      profCompleted,
      profFailed,
      profDelayed,
    ] = await Promise.all([
      this.summarizationQueue.getWaitingCount(),
      this.summarizationQueue.getActiveCount(),
      this.summarizationQueue.getCompletedCount(),
      this.summarizationQueue.getFailedCount(),
      this.summarizationQueue.getDelayedCount(),
      this.entityProfileQueue.getWaitingCount(),
      this.entityProfileQueue.getActiveCount(),
      this.entityProfileQueue.getCompletedCount(),
      this.entityProfileQueue.getFailedCount(),
      this.entityProfileQueue.getDelayedCount(),
    ]);

    return {
      summarization: {
        waiting: summWaiting,
        active: summActive,
        completed: summCompleted,
        failed: summFailed,
        delayed: summDelayed,
      },
      entityProfile: {
        waiting: profWaiting,
        active: profActive,
        completed: profCompleted,
        failed: profFailed,
        delayed: profDelayed,
      },
    };
  }

  /**
   * Trigger summarization for a specific interaction
   */
  @Post('trigger/:interactionId')
  @HttpCode(HttpStatus.OK)
  async triggerSummarization(
    @Param('interactionId') interactionId: string,
  ): Promise<{ success: boolean; summaryId?: string; message: string }> {
    // Check if interaction exists
    const interaction = await this.interactionRepo.findOne({
      where: { id: interactionId },
    });

    if (!interaction) {
      throw new NotFoundException(`Interaction ${interactionId} not found`);
    }

    // Check if already summarized
    const existing = await this.summaryRepo.findOne({
      where: { interactionId },
    });

    if (existing) {
      return {
        success: true,
        summaryId: existing.id,
        message: 'Summary already exists',
      };
    }

    // Process summarization
    const summary = await this.summarizationService.processSummarization(interactionId);

    if (!summary) {
      return {
        success: false,
        message: 'Summarization skipped (not enough messages or other condition)',
      };
    }

    return {
      success: true,
      summaryId: summary.id,
      message: 'Summary created successfully',
    };
  }

  /**
   * Trigger summarization for multiple interactions (batch)
   */
  @Post('trigger-batch')
  @HttpCode(HttpStatus.OK)
  async triggerBatchSummarization(
    @Body() body: { interactionIds: string[] },
  ): Promise<{ triggered: number; skipped: number; results: Array<{ id: string; status: string }> }> {
    if (!body.interactionIds?.length) {
      throw new BadRequestException('interactionIds array is required');
    }

    const results: Array<{ id: string; status: string }> = [];
    let triggered = 0;
    let skipped = 0;

    for (const interactionId of body.interactionIds) {
      try {
        const existing = await this.summaryRepo.findOne({
          where: { interactionId },
        });

        if (existing) {
          results.push({ id: interactionId, status: 'already_exists' });
          skipped++;
          continue;
        }

        const summary = await this.summarizationService.processSummarization(interactionId);

        if (summary) {
          results.push({ id: interactionId, status: 'created' });
          triggered++;
        } else {
          results.push({ id: interactionId, status: 'skipped' });
          skipped++;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        results.push({ id: interactionId, status: `error: ${message}` });
        skipped++;
      }
    }

    return { triggered, skipped, results };
  }

  /**
   * Get summarization status for an interaction
   */
  @Get('status/:interactionId')
  async getSummarizationStatus(
    @Param('interactionId') interactionId: string,
  ): Promise<SummarizationStatusResponse> {
    const summary = await this.summaryRepo.findOne({
      where: { interactionId },
    });

    return {
      interactionId,
      hasSummary: !!summary,
      summary: summary
        ? {
            id: summary.id,
            summaryText: summary.summaryText,
            keyPoints: summary.keyPoints,
            tone: summary.tone,
            messageCount: summary.messageCount,
            compressionRatio: summary.compressionRatio ? Number(summary.compressionRatio) : null,
            createdAt: summary.createdAt,
          }
        : undefined,
    };
  }

  /**
   * Get summary by interaction ID
   */
  @Get('interaction/:interactionId')
  async getSummaryByInteraction(
    @Param('interactionId') interactionId: string,
  ): Promise<InteractionSummary> {
    const summary = await this.summaryRepo.findOne({
      where: { interactionId },
    });

    if (!summary) {
      throw new NotFoundException(`Summary for interaction ${interactionId} not found`);
    }

    return summary;
  }

  /**
   * Manually trigger the daily summarization job
   */
  @Post('trigger-daily')
  @HttpCode(HttpStatus.OK)
  async triggerDailySummarization(): Promise<{ message: string }> {
    await this.summarizationService.scheduleDailySummarization();
    return { message: 'Daily summarization job triggered' };
  }

  // ==================== Entity Profile Endpoints ====================

  /**
   * Trigger profile aggregation for a specific entity
   */
  @Post('profile/trigger/:entityId')
  @HttpCode(HttpStatus.OK)
  async triggerProfileAggregation(
    @Param('entityId') entityId: string,
  ): Promise<{ success: boolean; profileId?: string; message: string }> {
    // Check if entity exists
    const entity = await this.entityRepo.findOne({
      where: { id: entityId },
    });

    if (!entity) {
      throw new NotFoundException(`Entity ${entityId} not found`);
    }

    try {
      const profile = await this.entityProfileService.processProfileAggregation(entityId);

      if (!profile) {
        return {
          success: false,
          message: 'Profile aggregation skipped (need at least 3 summaries)',
        };
      }

      return {
        success: true,
        profileId: profile.id,
        message: 'Profile created/updated successfully',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new BadRequestException(`Profile aggregation failed: ${message}`);
    }
  }

  /**
   * Get profile by entity ID
   */
  @Get('profile/entity/:entityId')
  async getProfileByEntity(
    @Param('entityId') entityId: string,
  ): Promise<EntityRelationshipProfile> {
    const profile = await this.profileRepo.findOne({
      where: { entityId },
    });

    if (!profile) {
      throw new NotFoundException(`Profile for entity ${entityId} not found`);
    }

    return profile;
  }

  /**
   * Get profile status for an entity
   */
  @Get('profile/status/:entityId')
  async getProfileStatus(
    @Param('entityId') entityId: string,
  ): Promise<{
    entityId: string;
    hasProfile: boolean;
    summariesCount: number;
    profile?: {
      id: string;
      relationshipType: string;
      relationshipSummary: string;
      totalInteractions: number;
      updatedAt: Date;
    };
  }> {
    // Count summaries for this entity
    const summariesCount = await this.summaryRepo
      .createQueryBuilder('s')
      .innerJoin('interactions', 'i', 'i.id = s.interaction_id')
      .innerJoin('interaction_participants', 'ip', 'ip.interaction_id = i.id')
      .where('ip.entity_id = :entityId', { entityId })
      .getCount();

    const profile = await this.profileRepo.findOne({
      where: { entityId },
    });

    return {
      entityId,
      hasProfile: !!profile,
      summariesCount,
      profile: profile
        ? {
            id: profile.id,
            relationshipType: profile.relationshipType,
            relationshipSummary: profile.relationshipSummary,
            totalInteractions: profile.totalInteractions,
            updatedAt: profile.updatedAt,
          }
        : undefined,
    };
  }

  /**
   * Manually trigger the weekly profile aggregation job
   */
  @Post('profile/trigger-weekly')
  @HttpCode(HttpStatus.OK)
  async triggerWeeklyProfileUpdate(): Promise<{ message: string }> {
    await this.entityProfileService.scheduleWeeklyProfileUpdate();
    return { message: 'Weekly profile aggregation job triggered' };
  }
}
