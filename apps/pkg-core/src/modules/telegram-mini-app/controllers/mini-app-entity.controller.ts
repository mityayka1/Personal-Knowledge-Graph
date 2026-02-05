import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  NotFoundException,
  Logger,
  ParseUUIDPipe,
} from '@nestjs/common';
import { TelegramAuthGuard, TelegramUser } from '../guards/telegram-auth.guard';
import { TgUser } from '../decorators/telegram-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { EntityService } from '../../entity/entity.service';

/**
 * Mini App Entity Controller.
 * Handles: /entity/:id, /entities
 */
@Controller('mini-app')
@Public()
@UseGuards(TelegramAuthGuard)
export class MiniAppEntityController {
  private readonly logger = new Logger(MiniAppEntityController.name);

  constructor(private readonly entityService: EntityService) {}

  /**
   * GET /api/mini-app/entities
   * Returns list of entities for selection (contacts).
   */
  @Get('entities')
  async listEntities(
    @Query('search') search?: string,
    @Query('limit') limitStr?: string,
    @TgUser() user?: TelegramUser,
  ) {
    this.logger.debug(`listEntities for user ${user?.id}, search=${search}`);

    const limit = Math.min(Math.max(1, parseInt(limitStr || '50', 10) || 50), 100);

    const { items: entities } = await this.entityService.findAll({
      search,
      limit,
    });

    return {
      items: entities.map((e) => ({
        id: e.id,
        name: e.name,
        type: e.type,
      })),
    };
  }

  /**
   * GET /api/mini-app/entity/:id
   * Returns entity profile with facts and interactions.
   */
  @Get('entity/:id')
  async getEntity(
    @Param('id', ParseUUIDPipe) entityId: string,
    @TgUser() user: TelegramUser,
  ) {
    this.logger.debug(`getEntity ${entityId} for user ${user?.id}`);

    const entity = await this.entityService.findOne(entityId);
    if (!entity) {
      throw new NotFoundException('Entity not found');
    }

    return {
      id: entity.id,
      type: entity.type,
      name: entity.name,
      avatarUrl: entity.profilePhoto ?? undefined,
      facts:
        entity.facts?.map((f) => ({
          type: f.factType,
          value: f.value,
          updatedAt: f.updatedAt?.toISOString(),
        })) ?? [],
      recentInteractions: [],
      identifiers:
        entity.identifiers?.map((id) => ({
          type: id.identifierType,
          value: id.identifierValue,
        })) ?? [],
    };
  }
}
