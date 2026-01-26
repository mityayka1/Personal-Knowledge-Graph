import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { MergeSuggestionService } from './merge-suggestion.service';
import { MergeRequestDto } from './dto/merge-request.dto';

@Controller('entities/merge-suggestions')
export class MergeSuggestionController {
  constructor(private readonly mergeSuggestionService: MergeSuggestionService) {}

  /**
   * GET /entities/merge-suggestions
   * Returns groups of merge suggestions for orphaned entities.
   */
  @Get()
  async getSuggestions(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const parsedLimit = limit ? Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100) : 50;
    const parsedOffset = offset ? Math.max(parseInt(offset, 10) || 0, 0) : 0;

    return this.mergeSuggestionService.getSuggestions({
      limit: parsedLimit,
      offset: parsedOffset,
    });
  }

  /**
   * POST /entities/merge-suggestions/:primaryId/dismiss/:candidateId
   * Dismiss a merge suggestion.
   */
  @Post(':primaryId/dismiss/:candidateId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async dismiss(
    @Param('primaryId', ParseUUIDPipe) primaryId: string,
    @Param('candidateId', ParseUUIDPipe) candidateId: string,
  ) {
    await this.mergeSuggestionService.dismiss(primaryId, candidateId);
  }

  /**
   * GET /entities/merge-suggestions/preview/:sourceId/:targetId
   * Get detailed merge preview with conflicts.
   */
  @Get('preview/:sourceId/:targetId')
  async getMergePreview(
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
    @Param('targetId', ParseUUIDPipe) targetId: string,
  ) {
    return this.mergeSuggestionService.getMergePreview(sourceId, targetId);
  }

  /**
   * POST /entities/merge-suggestions/merge
   * Execute merge with selected fields.
   */
  @Post('merge')
  async merge(@Body() dto: MergeRequestDto) {
    return this.mergeSuggestionService.mergeWithOptions(dto);
  }
}
