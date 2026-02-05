import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  NotFoundException,
  BadRequestException,
  Logger,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { TelegramAuthGuard, TelegramUser } from '../guards/telegram-auth.guard';
import { TgUser } from '../decorators/telegram-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { PendingApprovalService } from '../../pending-approval/pending-approval.service';
import { PendingApprovalStatus } from '@pkg/entities';
import { MiniAppMapperService } from '../services/mini-app-mapper.service';
import { UpdatePendingApprovalTargetDto } from '../dto/mini-app.dto';

/**
 * Valid status values for filtering pending approvals.
 */
const VALID_STATUSES = Object.values(PendingApprovalStatus);

/**
 * Mini App Pending Approval Controller.
 * Handles: /pending-approval/*
 */
@Controller('mini-app')
@Public()
@UseGuards(TelegramAuthGuard)
export class MiniAppApprovalController {
  private readonly logger = new Logger(MiniAppApprovalController.name);

  constructor(
    private readonly pendingApprovalService: PendingApprovalService,
    private readonly mapper: MiniAppMapperService,
  ) {}

  /**
   * GET /api/mini-app/pending-approval
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

    // 'all' is a special value meaning no filter
    const effectiveBatchId = batchId && batchId !== 'all' ? batchId : undefined;

    // Validate status enum if provided
    let validatedStatus: PendingApprovalStatus | undefined;
    if (status) {
      if (!VALID_STATUSES.includes(status as PendingApprovalStatus)) {
        throw new BadRequestException(
          `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`,
        );
      }
      validatedStatus = status as PendingApprovalStatus;
    }

    const { items, total } = await this.pendingApprovalService.list({
      batchId: effectiveBatchId,
      status: validatedStatus,
      limit,
      offset,
    });

    return {
      items: await Promise.all(items.map((item) => this.mapper.mapPendingApprovalToResponse(item))),
      total,
      limit,
      offset,
    };
  }

  /**
   * GET /api/mini-app/pending-approval/stats
   * Get global pending approval statistics.
   */
  @Get('pending-approval/stats')
  async getPendingApprovalGlobalStats(@TgUser() user?: TelegramUser) {
    this.logger.debug(`getPendingApprovalGlobalStats for user ${user?.id}`);
    return await this.pendingApprovalService.getGlobalStats();
  }

  /**
   * GET /api/mini-app/pending-approval/batch/:batchId/stats
   * Get batch statistics.
   */
  @Get('pending-approval/batch/:batchId/stats')
  async getPendingApprovalBatchStats(
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @TgUser() user?: TelegramUser,
  ) {
    this.logger.debug(`getPendingApprovalBatchStats ${batchId} for user ${user?.id}`);
    const stats = await this.pendingApprovalService.getBatchStats(batchId);
    return { batchId, ...stats };
  }

  /**
   * POST /api/mini-app/pending-approval/batch/:batchId/approve
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
    return { approved: result.processed, errors: result.errors };
  }

  /**
   * POST /api/mini-app/pending-approval/batch/:batchId/reject
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
    return { rejected: result.processed, errors: result.errors };
  }

  /**
   * GET /api/mini-app/pending-approval/:id
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

    return await this.mapper.mapPendingApprovalToResponse(approval);
  }

  /**
   * PATCH /api/mini-app/pending-approval/:id
   * Update the target entity of a pending approval.
   * Allows editing draft entities before approving.
   */
  @Patch('pending-approval/:id')
  async updatePendingApprovalTarget(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePendingApprovalTargetDto,
    @TgUser() user?: TelegramUser,
  ) {
    this.logger.debug(`updatePendingApprovalTarget ${id} for user ${user?.id}`);

    // Convert DTO to service input
    const updates = {
      name: dto.name,
      description: dto.description,
      priority: dto.priority,
      deadline: dto.deadline ? new Date(dto.deadline) : dto.deadline === null ? null : undefined,
      parentId: dto.parentId,
      // For commitments, deadline maps to dueDate
      dueDate: dto.deadline ? new Date(dto.deadline) : dto.deadline === null ? null : undefined,
    };

    // Remove undefined values
    Object.keys(updates).forEach((key) => {
      if (updates[key as keyof typeof updates] === undefined) {
        delete updates[key as keyof typeof updates];
      }
    });

    await this.pendingApprovalService.updateTargetEntity(id, updates);

    // Return updated approval with target data
    const approval = await this.pendingApprovalService.getById(id);
    if (!approval) {
      throw new NotFoundException(`Pending approval ${id} not found`);
    }

    return await this.mapper.mapPendingApprovalToResponse(approval);
  }

  /**
   * POST /api/mini-app/pending-approval/:id/approve
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
}
