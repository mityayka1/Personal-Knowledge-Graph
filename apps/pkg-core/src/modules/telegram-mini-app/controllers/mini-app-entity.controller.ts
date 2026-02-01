import {
  Controller,
  Get,
  Param,
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
 * Handles: /entity/:id
 */
@Controller('mini-app')
@Public()
@UseGuards(TelegramAuthGuard)
export class MiniAppEntityController {
  private readonly logger = new Logger(MiniAppEntityController.name);

  constructor(private readonly entityService: EntityService) {}

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
