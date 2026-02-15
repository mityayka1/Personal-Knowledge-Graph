import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  ParseUUIDPipe,
  Logger,
} from '@nestjs/common';
import { SegmentationService } from './segmentation.service';
import { CreateSegmentDto } from './dto/create-segment.dto';
import { UpdateSegmentDto } from './dto/update-segment.dto';
import { SegmentQueryDto } from './dto/segment-query.dto';

@Controller('segments')
export class SegmentationController {
  private readonly logger = new Logger(SegmentationController.name);

  constructor(private readonly segmentationService: SegmentationService) {}

  @Post()
  async createSegment(@Body() dto: CreateSegmentDto) {
    this.logger.log(`Creating segment: "${dto.topic}" (chat: ${dto.chatId})`);
    return this.segmentationService.createSegment(dto);
  }

  @Get()
  async findSegments(@Query() query: SegmentQueryDto) {
    return this.segmentationService.findSegments({
      chatId: query.chatId,
      activityId: query.activityId,
      interactionId: query.interactionId,
      status: query.status,
      search: query.search,
      limit: query.limit,
      offset: query.offset,
    });
  }

  @Get(':id')
  async findOneSegment(@Param('id', ParseUUIDPipe) id: string) {
    return this.segmentationService.findOneSegment(id);
  }

  @Patch(':id')
  async updateSegment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSegmentDto,
  ) {
    this.logger.log(`Updating segment: ${id}`);
    return this.segmentationService.updateSegment(id, dto);
  }

  @Get(':id/messages')
  async getSegmentMessages(@Param('id', ParseUUIDPipe) id: string) {
    return this.segmentationService.getSegmentMessages(id);
  }

  @Post(':id/messages')
  async linkMessages(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { messageIds: string[] },
  ) {
    await this.segmentationService.linkMessages(id, body.messageIds);
    return { linked: body.messageIds.length };
  }

  @Post(':id/merge')
  async mergeSegments(
    @Param('id', ParseUUIDPipe) targetId: string,
    @Body() body: { sourceSegmentId: string },
  ) {
    return this.segmentationService.mergeSegments(targetId, body.sourceSegmentId);
  }

  // ─────────────────────────────────────────────────────────────
  // KnowledgePack endpoints
  // ─────────────────────────────────────────────────────────────

  @Get('packs/list')
  async findPacks(
    @Query('activityId') activityId?: string,
    @Query('entityId') entityId?: string,
    @Query('packType') packType?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.segmentationService.findPacks({
      activityId,
      entityId,
      packType,
      limit: limit ? parseInt(limit, 10) : 20,
      offset: offset ? parseInt(offset, 10) : 0,
    });
  }

  @Get('packs/:id')
  async findOnePack(@Param('id', ParseUUIDPipe) id: string) {
    return this.segmentationService.findOnePack(id);
  }
}
