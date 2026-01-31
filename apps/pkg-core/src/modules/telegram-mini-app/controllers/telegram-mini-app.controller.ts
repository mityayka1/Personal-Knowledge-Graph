import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  NotFoundException,
  Logger,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
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
import { PendingApprovalService } from '../../pending-approval/pending-approval.service';
import { CommitmentService } from '../../activity/commitment.service';
import {
  PendingApproval,
  PendingApprovalStatus,
  PendingApprovalItemType,
  CommitmentType,
} from '@pkg/entities';
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
 * Base path: /api/v1/mini-app (global prefix + controller path)
 */
@Controller('mini-app')
@Public() // Bypass CombinedAuthGuard - TelegramAuthGuard handles Mini App auth
@UseGuards(TelegramAuthGuard)
export class TelegramMiniAppController {
  private readonly logger = new Logger(TelegramMiniAppController.name);
  private readonly ownerTelegramId: number;

  constructor(
    private readonly entityService: EntityService,
    private readonly extractionCarouselService: ExtractionCarouselStateService,
    private readonly recallSessionService: RecallSessionService,
    private readonly pendingApprovalService: PendingApprovalService,
    private readonly commitmentService: CommitmentService,
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

    // Fetch pending approvals grouped by batch
    const { items: pendingApprovals } = await this.pendingApprovalService.list({
      status: PendingApprovalStatus.PENDING,
      limit: 100, // Reasonable limit for dashboard
    });

    // Group by batchId and create pending actions
    const batchMap = new Map<
      string,
      { items: PendingApproval[]; types: Set<string> }
    >();

    for (const approval of pendingApprovals) {
      if (!batchMap.has(approval.batchId)) {
        batchMap.set(approval.batchId, { items: [], types: new Set() });
      }
      const batch = batchMap.get(approval.batchId)!;
      batch.items.push(approval);
      batch.types.add(approval.itemType);
    }

    const pendingActions = Array.from(batchMap.entries()).map(
      ([batchId, { items, types }]) => {
        // Determine primary type for display
        const typeArray = Array.from(types);
        const primaryType =
          typeArray.length === 1 ? typeArray[0] : 'extraction';

        // Generate title based on content
        const title = this.generateBatchTitle(items, typeArray);

        return {
          type: 'approval' as const,
          id: batchId,
          title,
          count: items.length,
        };
      },
    );

    return {
      pendingActions,
      todayBrief: null, // TODO: Implement brief fetching
      recentActivity: [], // TODO: Implement recent activity
    };
  }

  /**
   * Generate a human-readable title for a batch of pending approvals.
   */
  private generateBatchTitle(
    items: PendingApproval[],
    types: string[],
  ): string {
    if (types.length === 1) {
      const type = types[0];
      const count = items.length;
      switch (type) {
        case PendingApprovalItemType.FACT:
          return `${count} ${this.pluralize(count, 'факт', 'факта', 'фактов')}`;
        case PendingApprovalItemType.PROJECT:
          return `${count} ${this.pluralize(count, 'проект', 'проекта', 'проектов')}`;
        case PendingApprovalItemType.TASK:
          return `${count} ${this.pluralize(count, 'задача', 'задачи', 'задач')}`;
        case PendingApprovalItemType.COMMITMENT:
          return `${count} ${this.pluralize(count, 'обязательство', 'обязательства', 'обязательств')}`;
        default:
          return `${count} элементов`;
      }
    }

    // Mixed types
    return `${items.length} извлечённых элементов`;
  }

  /**
   * Russian pluralization helper.
   */
  private pluralize(n: number, one: string, few: string, many: string): string {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
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

  // ─────────────────────────────────────────────────────────────
  // Pending Approval Endpoints
  // ─────────────────────────────────────────────────────────────

  /**
   * GET /api/mini-app/pending-approval
   *
   * List pending approvals with optional filters.
   */
  @Get('pending-approval')
  async listPendingApprovals(
    @Query('batchId') batchId?: string,
    @Query('status') status?: string,
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string,
    @TgUser() user?: TelegramUser,
  ) {
    this.logger.debug(`listPendingApprovals for user ${user?.id}`);

    const limit = Math.min(Math.max(1, parseInt(limitStr || '50', 10) || 50), 100);
    const offset = Math.max(0, parseInt(offsetStr || '0', 10) || 0);

    const { items, total } = await this.pendingApprovalService.list({
      batchId,
      status: status as PendingApprovalStatus,
      limit,
      offset,
    });

    return {
      items: await Promise.all(
        items.map((item) => this.mapPendingApprovalToResponse(item)),
      ),
      total,
      limit,
      offset,
    };
  }

  /**
   * GET /api/mini-app/pending-approval/batch/:batchId/stats
   *
   * Get batch statistics.
   * Note: This route must come before :id route to avoid conflict.
   */
  @Get('pending-approval/batch/:batchId/stats')
  async getPendingApprovalBatchStats(
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @TgUser() user?: TelegramUser,
  ) {
    this.logger.debug(`getPendingApprovalBatchStats ${batchId} for user ${user?.id}`);

    const stats = await this.pendingApprovalService.getBatchStats(batchId);

    return {
      batchId,
      ...stats,
    };
  }

  /**
   * POST /api/mini-app/pending-approval/batch/:batchId/approve
   *
   * Approve all pending items in a batch.
   */
  @Post('pending-approval/batch/:batchId/approve')
  @HttpCode(HttpStatus.OK)
  async approvePendingBatch(
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @TgUser() user?: TelegramUser,
  ) {
    this.logger.debug(`approvePendingBatch ${batchId} for user ${user?.id}`);

    const result = await this.pendingApprovalService.approveBatch(batchId);

    return {
      approved: result.processed,
      errors: result.errors,
    };
  }

  /**
   * POST /api/mini-app/pending-approval/batch/:batchId/reject
   *
   * Reject all pending items in a batch.
   */
  @Post('pending-approval/batch/:batchId/reject')
  @HttpCode(HttpStatus.OK)
  async rejectPendingBatch(
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @TgUser() user?: TelegramUser,
  ) {
    this.logger.debug(`rejectPendingBatch ${batchId} for user ${user?.id}`);

    const result = await this.pendingApprovalService.rejectBatch(batchId);

    return {
      rejected: result.processed,
      errors: result.errors,
    };
  }

  /**
   * GET /api/mini-app/pending-approval/:id
   *
   * Get a single pending approval by ID.
   */
  @Get('pending-approval/:id')
  async getPendingApproval(
    @Param('id', ParseUUIDPipe) id: string,
    @TgUser() user?: TelegramUser,
  ) {
    this.logger.debug(`getPendingApproval ${id} for user ${user?.id}`);

    const approval = await this.pendingApprovalService.getById(id);

    if (!approval) {
      throw new NotFoundException(`Pending approval ${id} not found`);
    }

    return await this.mapPendingApprovalToResponse(approval);
  }

  /**
   * POST /api/mini-app/pending-approval/:id/approve
   *
   * Approve a single pending item.
   */
  @Post('pending-approval/:id/approve')
  @HttpCode(HttpStatus.OK)
  async approvePendingApproval(
    @Param('id', ParseUUIDPipe) id: string,
    @TgUser() user?: TelegramUser,
  ) {
    this.logger.debug(`approvePendingApproval ${id} for user ${user?.id}`);

    await this.pendingApprovalService.approve(id);

    return { success: true };
  }

  /**
   * POST /api/mini-app/pending-approval/:id/reject
   *
   * Reject a single pending item.
   */
  @Post('pending-approval/:id/reject')
  @HttpCode(HttpStatus.OK)
  async rejectPendingApproval(
    @Param('id', ParseUUIDPipe) id: string,
    @TgUser() user?: TelegramUser,
  ) {
    this.logger.debug(`rejectPendingApproval ${id} for user ${user?.id}`);

    await this.pendingApprovalService.reject(id);

    return { success: true };
  }

  /**
   * Map PendingApproval entity to API response format.
   * Loads full target data for rich display.
   */
  private async mapPendingApprovalToResponse(approval: PendingApproval) {
    return {
      id: approval.id,
      itemType: approval.itemType,
      targetId: approval.targetId,
      confidence: approval.confidence,
      sourceQuote: approval.sourceQuote,
      status: approval.status,
      createdAt: approval.createdAt.toISOString(),
      target: await this.loadTargetData(approval),
    };
  }

  /**
   * Load full target entity data based on item type.
   * Returns rich data for Commitment, Activity, Fact.
   */
  private async loadTargetData(
    approval: PendingApproval,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      if (approval.itemType === PendingApprovalItemType.COMMITMENT) {
        const commitment = await this.commitmentService.findOne(approval.targetId);
        return {
          title: commitment.title,
          description: commitment.description,
          type: commitment.type,
          typeName: this.getCommitmentTypeName(commitment.type),
          dueDate: commitment.dueDate?.toISOString(),
          priority: commitment.priority,
          fromEntity: commitment.fromEntity
            ? {
                id: commitment.fromEntity.id,
                name: commitment.fromEntity.name,
              }
            : null,
          toEntity: commitment.toEntity
            ? {
                id: commitment.toEntity.id,
                name: commitment.toEntity.name,
              }
            : null,
          preview: approval.sourceQuote?.substring(0, 200),
        };
      }

      // Fallback for other types - return basic preview
      if (approval.sourceQuote) {
        return {
          preview: approval.sourceQuote.substring(0, 200),
        };
      }
    } catch (error) {
      this.logger.warn(
        `Failed to load target data for ${approval.itemType}/${approval.targetId}: ${error}`,
      );
      // Return basic fallback on error
      if (approval.sourceQuote) {
        return { preview: approval.sourceQuote.substring(0, 200) };
      }
    }

    return undefined;
  }

  /**
   * Get human-readable commitment type name.
   */
  private getCommitmentTypeName(type: CommitmentType): string {
    const names: Record<CommitmentType, string> = {
      [CommitmentType.PROMISE]: 'Обещание',
      [CommitmentType.REQUEST]: 'Запрос',
      [CommitmentType.AGREEMENT]: 'Договорённость',
      [CommitmentType.DEADLINE]: 'Дедлайн',
      [CommitmentType.REMINDER]: 'Напоминание',
      [CommitmentType.RECURRING]: 'Периодическое',
    };
    return names[type] || type;
  }

  // ─────────────────────────────────────────────────────────────
  // Extraction Carousel Helpers
  // ─────────────────────────────────────────────────────────────

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
