import {
  Controller,
  Post,
  Body,
  Param,
  ParseUUIDPipe,
  Logger,
} from '@nestjs/common';
import { IsUUID, IsString, IsOptional, IsDateString } from 'class-validator';
import { PackingService } from './packing.service';

// ─────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────

class PackByActivityDto {
  @IsUUID()
  activityId: string;

  @IsOptional()
  @IsString()
  title?: string;
}

class PackByEntityDto {
  @IsUUID()
  entityId: string;

  @IsOptional()
  @IsString()
  title?: string;
}

class PackByPeriodDto {
  @IsString()
  chatId: string;

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsOptional()
  @IsString()
  title?: string;
}

// ─────────────────────────────────────────────────────────────
// Controller
// ─────────────────────────────────────────────────────────────

@Controller('segments/packs')
export class PackingController {
  private readonly logger = new Logger(PackingController.name);

  constructor(private readonly packingService: PackingService) {}

  /**
   * POST /segments/packs/create-for-activity
   *
   * Consolidate all ACTIVE/CLOSED segments for a given activity
   * into a single KnowledgePack.
   */
  @Post('create-for-activity')
  async createForActivity(@Body() dto: PackByActivityDto) {
    this.logger.log(`Creating pack for activity: ${dto.activityId}`);
    const result = await this.packingService.packByActivity({
      activityId: dto.activityId,
      title: dto.title,
    });
    return {
      success: true,
      data: {
        packId: result.pack.id,
        title: result.pack.title,
        segmentCount: result.segmentCount,
        totalMessageCount: result.totalMessageCount,
        tokensUsed: result.tokensUsed,
        durationMs: result.durationMs,
      },
    };
  }

  /**
   * POST /segments/packs/create-for-entity
   *
   * Consolidate all ACTIVE/CLOSED segments where a given entity
   * is the primary participant into a KnowledgePack.
   */
  @Post('create-for-entity')
  async createForEntity(@Body() dto: PackByEntityDto) {
    this.logger.log(`Creating pack for entity: ${dto.entityId}`);
    const result = await this.packingService.packByEntity({
      entityId: dto.entityId,
      title: dto.title,
    });
    return {
      success: true,
      data: {
        packId: result.pack.id,
        title: result.pack.title,
        segmentCount: result.segmentCount,
        totalMessageCount: result.totalMessageCount,
        tokensUsed: result.tokensUsed,
        durationMs: result.durationMs,
      },
    };
  }

  /**
   * POST /segments/packs/create-for-period
   *
   * Consolidate all ACTIVE/CLOSED segments in a chat
   * for a given time period into a KnowledgePack.
   */
  @Post('create-for-period')
  async createForPeriod(@Body() dto: PackByPeriodDto) {
    this.logger.log(
      `Creating pack for period: chat=${dto.chatId}, ${dto.startDate} - ${dto.endDate}`,
    );
    const result = await this.packingService.packByPeriod({
      chatId: dto.chatId,
      startDate: new Date(dto.startDate),
      endDate: new Date(dto.endDate),
      title: dto.title,
    });
    return {
      success: true,
      data: {
        packId: result.pack.id,
        title: result.pack.title,
        segmentCount: result.segmentCount,
        totalMessageCount: result.totalMessageCount,
        tokensUsed: result.tokensUsed,
        durationMs: result.durationMs,
      },
    };
  }

  /**
   * POST /segments/packs/:id/supersede
   *
   * Mark an existing pack as SUPERSEDED.
   * Used when re-packing after new segments are added.
   */
  @Post(':id/supersede')
  async supersedePack(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { supersededById?: string },
  ) {
    this.logger.log(`Superseding pack: ${id}`);
    const pack = await this.packingService.supersedePack(id, body.supersededById);
    return {
      success: true,
      data: {
        packId: pack.id,
        status: pack.status,
        supersededById: pack.supersededById,
      },
    };
  }
}
