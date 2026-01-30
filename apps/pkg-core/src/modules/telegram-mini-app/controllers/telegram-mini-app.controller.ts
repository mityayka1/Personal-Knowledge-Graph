import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { TelegramAuthGuard, TelegramUser } from '../guards/telegram-auth.guard';
import { TgUser } from '../decorators/telegram-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { EntityService } from '../../entity/entity.service';
import {
  ExtractionCarouselStateService,
  ExtractionCarouselState,
  ExtractionCarouselItem,
} from '../../extraction/extraction-carousel-state.service';
import { RecallSessionService } from '../../claude-agent/recall-session.service';
import {
  BriefItemActionDto,
  ConfirmExtractionDto,
  SkipExtractionDto,
} from '../dto/mini-app.dto';
import { ConfigService } from '@nestjs/config';

/**
 * Controller for Telegram Mini App API endpoints.
 *
 * All endpoints are protected by TelegramAuthGuard which validates
 * the initData signature from Telegram.
 *
 * Base path: /api/mini-app
 */
@Controller('api/mini-app')
@Public() // Bypass CombinedAuthGuard - TelegramAuthGuard handles Mini App auth
@UseGuards(TelegramAuthGuard)
export class TelegramMiniAppController {
  private readonly logger = new Logger(TelegramMiniAppController.name);
  private readonly ownerTelegramId: number;

  constructor(
    private readonly entityService: EntityService,
    private readonly extractionCarouselService: ExtractionCarouselStateService,
    private readonly recallSessionService: RecallSessionService,
    private readonly configService: ConfigService,
  ) {
    this.ownerTelegramId = this.configService.get<number>('OWNER_TELEGRAM_ID', 0);
  }

  /**
   * GET /api/mini-app/me
   *
   * Returns current user info and owner status.
   */
  @Get('me')
  async getMe(@TgUser() user: TelegramUser) {
    this.logger.debug(`getMe for user ${user?.id}`);

    return {
      user: user
        ? {
            id: user.id,
            firstName: user.first_name,
            lastName: user.last_name,
            username: user.username,
          }
        : null,
      isOwner: user?.id === this.ownerTelegramId,
    };
  }

  /**
   * GET /api/mini-app/dashboard
   *
   * Returns dashboard data: pending actions, today's brief, recent activity.
   */
  @Get('dashboard')
  async getDashboard(@TgUser() user: TelegramUser) {
    this.logger.debug(`getDashboard for user ${user?.id}`);

    // TODO: Implement actual data fetching
    // For now, return stub data for UI development
    return {
      pendingActions: [],
      todayBrief: null,
      recentActivity: [],
    };
  }

  /**
   * GET /api/mini-app/brief/:id
   *
   * Returns brief details with items.
   */
  @Get('brief/:id')
  async getBrief(@Param('id') briefId: string, @TgUser() user: TelegramUser) {
    this.logger.debug(`getBrief ${briefId} for user ${user?.id}`);

    // TODO: Implement actual brief fetching
    throw new NotFoundException('Brief not found');
  }

  /**
   * POST /api/mini-app/brief/:id/item/:idx/action
   *
   * Perform action on a brief item (done, remind, write, prepare).
   */
  @Post('brief/:id/item/:idx/action')
  async briefItemAction(
    @Param('id') briefId: string,
    @Param('idx') itemIdx: string,
    @Body() dto: BriefItemActionDto,
    @TgUser() user: TelegramUser,
  ) {
    this.logger.debug(
      `briefItemAction ${briefId}/${itemIdx} action=${dto.action} for user ${user?.id}`,
    );

    // TODO: Implement actual action handling
    return { success: true };
  }

  /**
   * GET /api/mini-app/extraction/:carouselId
   *
   * Returns carousel state with all items.
   */
  @Get('extraction/:carouselId')
  async getExtraction(
    @Param('carouselId') carouselId: string,
    @TgUser() user: TelegramUser,
  ) {
    this.logger.debug(`getExtraction ${carouselId} for user ${user?.id}`);

    const state = await this.extractionCarouselService.get(carouselId);
    if (!state) {
      throw new NotFoundException('Extraction carousel not found or expired');
    }

    return this.mapCarouselStateToResponse(state, carouselId);
  }

  /**
   * POST /api/mini-app/extraction/:carouselId/confirm/:itemId
   *
   * Confirm an extracted item, optionally with edits.
   */
  @Post('extraction/:carouselId/confirm/:itemId')
  async confirmExtraction(
    @Param('carouselId') carouselId: string,
    @Param('itemId') itemId: string,
    @Body() dto: ConfirmExtractionDto,
    @TgUser() user: TelegramUser,
  ) {
    this.logger.debug(
      `confirmExtraction ${carouselId}/${itemId} for user ${user?.id}`,
    );

    // Check if carousel exists first
    const state = await this.extractionCarouselService.get(carouselId);
    if (!state) {
      throw new NotFoundException('Carousel not found or expired');
    }

    // Confirm the item
    await this.extractionCarouselService.confirm(carouselId, itemId);

    // Get next item info
    const nextItem = await this.extractionCarouselService.getCurrentItem(carouselId);

    return {
      success: true,
      nextIndex: nextItem?.index,
      remaining: nextItem?.remaining ?? 0,
    };
  }

  /**
   * POST /api/mini-app/extraction/:carouselId/skip/:itemId
   *
   * Skip an extracted item.
   */
  @Post('extraction/:carouselId/skip/:itemId')
  async skipExtraction(
    @Param('carouselId') carouselId: string,
    @Param('itemId') itemId: string,
    @Body() dto: SkipExtractionDto,
    @TgUser() user: TelegramUser,
  ) {
    this.logger.debug(
      `skipExtraction ${carouselId}/${itemId} for user ${user?.id}`,
    );

    // Check if carousel exists first
    const state = await this.extractionCarouselService.get(carouselId);
    if (!state) {
      throw new NotFoundException('Carousel not found or expired');
    }

    // Skip the item
    await this.extractionCarouselService.skip(carouselId, itemId);

    // Get next item info
    const nextItem = await this.extractionCarouselService.getCurrentItem(carouselId);

    return {
      success: true,
      nextIndex: nextItem?.index,
      remaining: nextItem?.remaining ?? 0,
    };
  }

  /**
   * GET /api/mini-app/recall/:sessionId
   *
   * Returns recall session results.
   */
  @Get('recall/:sessionId')
  async getRecall(
    @Param('sessionId') sessionId: string,
    @TgUser() user: TelegramUser,
  ) {
    this.logger.debug(`getRecall ${sessionId} for user ${user?.id}`);

    const session = await this.recallSessionService.get(sessionId);
    if (!session) {
      throw new NotFoundException('Recall session not found or expired');
    }

    return {
      id: session.id,
      query: session.query,
      answer: session.answer,
      sources: session.sources.map((s) => ({
        id: s.id,
        type: s.type,
        preview: s.preview,
        // TODO: Add entityName and timestamp from actual source lookup
      })),
      createdAt: new Date(session.createdAt).toISOString(),
    };
  }

  /**
   * GET /api/mini-app/entity/:id
   *
   * Returns entity profile with facts and interactions.
   */
  @Get('entity/:id')
  async getEntity(
    @Param('id') entityId: string,
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
      // TODO: Load recent interactions via participations relation
      recentInteractions: [],
      identifiers:
        entity.identifiers?.map((id) => ({
          type: id.identifierType,
          value: id.identifierValue,
        })) ?? [],
    };
  }

  /**
   * Map internal carousel state to API response format.
   */
  private mapCarouselStateToResponse(
    state: ExtractionCarouselState,
    carouselId: string,
  ) {
    return {
      id: carouselId,
      items: state.items.map((item) => ({
        id: item.id,
        type: item.type,
        title: this.getItemTitle(item),
        description: this.getItemDescription(item),
        confidence: this.getItemConfidence(item),
        fields: this.getItemFields(item),
        status: state.confirmedIds.includes(item.id)
          ? 'confirmed'
          : state.processedIds.includes(item.id)
            ? 'skipped'
            : 'pending',
      })),
      currentIndex: state.currentIndex,
      totalCount: state.items.length,
      confirmedCount: state.confirmedIds.length,
      skippedCount: state.processedIds.length - state.confirmedIds.length,
    };
  }

  private getItemTitle(item: ExtractionCarouselItem): string {
    const data = item.data;
    return ('name' in data && data.name) || ('title' in data && data.title) || 'Без названия';
  }

  private getItemDescription(item: ExtractionCarouselItem): string | undefined {
    const data = item.data;
    if ('description' in data && typeof data.description === 'string') {
      return data.description;
    }
    if ('context' in data && typeof data.context === 'string') {
      return data.context;
    }
    return undefined;
  }

  private getItemConfidence(item: ExtractionCarouselItem): number {
    const data = item.data;
    return 'confidence' in data && typeof data.confidence === 'number' ? data.confidence : 0.5;
  }

  private getItemFields(item: ExtractionCarouselItem): Record<string, unknown> {
    const data = item.data;
    const fields: Record<string, unknown> = {};

    // Extract relevant fields based on item type
    if (item.type === 'project') {
      if ('status' in data && data.status) fields.status = data.status;
      if ('deadline' in data && data.deadline) fields.deadline = data.deadline;
    } else if (item.type === 'task') {
      if ('priority' in data && data.priority) fields.priority = data.priority;
      if ('dueDate' in data && data.dueDate) fields.dueDate = data.dueDate;
      if ('assignee' in data && data.assignee) fields.assignee = data.assignee;
    } else if (item.type === 'commitment') {
      if ('type' in data && data.type) fields.type = data.type;
      if ('direction' in data && data.direction) fields.direction = data.direction;
      if ('deadline' in data && data.deadline) fields.deadline = data.deadline;
    }

    return fields;
  }
}
