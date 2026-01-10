import { Controller, Post, Param, Body, ParseUUIDPipe } from '@nestjs/common';
import { InteractionSummaryService } from '../interaction/interaction-summary/interaction-summary.service';

@Controller('internal')
export class WebhookController {
  constructor(private summaryService: InteractionSummaryService) {}

  /**
   * Save summary from n8n Worker
   * Uses legacy format for backwards compatibility with existing workflows
   */
  @Post('interactions/:id/summary')
  async saveSummary(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: {
      summary_text: string;
      key_points?: string[];
      decisions?: string[];
      action_items?: string[];
      facts_extracted?: Array<{ type: string; value: string; confidence: number }>;
    },
  ) {
    const summary = await this.summaryService.createLegacy(id, {
      summaryText: body.summary_text,
      keyPoints: body.key_points,
      decisions: body.decisions,
      actionItems: body.action_items,
      factsExtracted: body.facts_extracted,
    });

    return {
      id: summary.id,
      interaction_id: id,
      created_at: summary.createdAt,
    };
  }
}
