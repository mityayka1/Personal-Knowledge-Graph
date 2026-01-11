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
import { Repository } from 'typeorm';
import { InteractionSummary, Interaction } from '@pkg/entities';
import { SummarizationService } from './summarization.service';

interface TriggerSummarizationDto {
  interactionId: string;
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
    @InjectRepository(InteractionSummary)
    private readonly summaryRepo: Repository<InteractionSummary>,
    @InjectRepository(Interaction)
    private readonly interactionRepo: Repository<Interaction>,
  ) {}

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
}
