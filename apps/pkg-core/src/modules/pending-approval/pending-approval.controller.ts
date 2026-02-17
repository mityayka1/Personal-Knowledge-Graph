import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import {
  PendingApprovalService,
  ListPendingApprovalsOptions,
  BatchOperationResult,
  UpdateTargetInput,
} from './pending-approval.service';
import {
  PendingApproval,
  PendingApprovalStatus,
} from '@pkg/entities';

/**
 * Query parameters for listing pending approvals.
 */
interface ListQueryDto {
  batchId?: string;
  status?: PendingApprovalStatus;
  limit?: string;
  offset?: string;
}

/**
 * Response for a single pending approval (without full relation objects).
 */
type PendingApprovalResponse = Omit<PendingApproval, 'sourceInteraction' | 'sourceEntity'>;

/**
 * Response for list operation.
 */
interface ListResponse {
  items: PendingApprovalResponse[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Response for batch statistics.
 */
interface BatchStatsResponse {
  batchId: string;
  total: number;
  pending: number;
  approved: number;
  rejected: number;
}

/**
 * Request body for updating a target entity.
 */
interface UpdateTargetDto {
  name?: string;
  description?: string;
  priority?: string;
  deadline?: string | null;
  parentId?: string | null;
  clientEntityId?: string | null;
  assignee?: string | null;
  dueDate?: string | null;
}

/**
 * Controller for pending approval operations.
 *
 * Provides REST API for:
 * - Listing pending approvals with filters
 * - Getting individual approval details
 * - Approving/rejecting single items
 * - Batch approve/reject operations
 *
 * @see docs/plans/2026-01-31-refactor-extraction-carousel-to-pending-facts-plan.md
 */
@Controller('pending-approval')
export class PendingApprovalController {
  constructor(private readonly pendingApprovalService: PendingApprovalService) {}

  /**
   * List pending approvals with optional filters.
   *
   * GET /pending-approval?batchId=...&status=pending&limit=50&offset=0
   */
  @Get()
  async list(@Query() query: ListQueryDto): Promise<ListResponse> {
    const options: ListPendingApprovalsOptions = {};

    if (query.batchId) {
      options.batchId = query.batchId;
    }

    if (query.status && Object.values(PendingApprovalStatus).includes(query.status)) {
      options.status = query.status;
    }

    options.limit = query.limit ? parseInt(query.limit, 10) : 50;
    options.offset = query.offset ? parseInt(query.offset, 10) : 0;

    // Clamp values
    options.limit = Math.min(Math.max(1, options.limit), 100);
    options.offset = Math.max(0, options.offset);

    const { items, total } = await this.pendingApprovalService.list(options);

    return {
      items: items.map(this.mapApprovalToResponse),
      total,
      limit: options.limit,
      offset: options.offset,
    };
  }

  /**
   * Get the target entity of a pending approval.
   *
   * GET /pending-approval/:id/target
   */
  @Get(':id/target')
  async getTarget(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ itemType: string; target: Record<string, unknown> }> {
    const result = await this.pendingApprovalService.getTargetEntity(id);

    if (!result) {
      throw new NotFoundException(`Pending approval ${id} or its target not found`);
    }

    return result;
  }

  /**
   * Get a single pending approval by ID.
   *
   * GET /pending-approval/:id
   */
  @Get(':id')
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PendingApprovalResponse> {
    const approval = await this.pendingApprovalService.getById(id);

    if (!approval) {
      throw new NotFoundException(`Pending approval ${id} not found`);
    }

    return this.mapApprovalToResponse(approval);
  }

  /**
   * Get batch statistics.
   *
   * GET /pending-approval/batch/:batchId/stats
   */
  @Get('batch/:batchId/stats')
  async getBatchStats(
    @Param('batchId', ParseUUIDPipe) batchId: string,
  ): Promise<BatchStatsResponse> {
    const stats = await this.pendingApprovalService.getBatchStats(batchId);

    return {
      batchId,
      ...stats,
    };
  }

  /**
   * Approve a single pending item.
   *
   * POST /pending-approval/:id/approve
   */
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ success: true; id: string }> {
    await this.pendingApprovalService.approve(id);
    return { success: true, id };
  }

  /**
   * Reject a single pending item.
   *
   * POST /pending-approval/:id/reject
   */
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ success: true; id: string }> {
    await this.pendingApprovalService.reject(id);
    return { success: true, id };
  }

  /**
   * Update the target entity of a pending approval.
   * Allows editing draft entities before approving.
   *
   * PATCH /pending-approval/:id/target
   */
  @Patch(':id/target')
  async updateTarget(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateTargetDto,
  ): Promise<{ success: true; id: string }> {
    const updates: UpdateTargetInput = {};

    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.priority !== undefined) updates.priority = body.priority;
    if (body.deadline !== undefined) {
      if (body.deadline) {
        const d = new Date(body.deadline);
        if (isNaN(d.getTime())) throw new BadRequestException('Invalid deadline date format');
        updates.deadline = d;
      } else {
        updates.deadline = null;
      }
    }
    // parentId intentionally excluded — closure-table requires ActivityService.update()
    if (body.clientEntityId !== undefined) updates.clientEntityId = body.clientEntityId;
    if (body.assignee !== undefined) updates.assignee = body.assignee;
    if (body.dueDate !== undefined) {
      if (body.dueDate) {
        const d = new Date(body.dueDate);
        if (isNaN(d.getTime())) throw new BadRequestException('Invalid dueDate date format');
        updates.dueDate = d;
      } else {
        updates.dueDate = null;
      }
    }

    await this.pendingApprovalService.updateTargetEntity(id, updates);
    return { success: true, id };
  }

  /**
   * Approve all pending items in a batch.
   *
   * POST /pending-approval/batch/:batchId/approve
   */
  @Post('batch/:batchId/approve')
  @HttpCode(HttpStatus.OK)
  async approveBatch(
    @Param('batchId', ParseUUIDPipe) batchId: string,
  ): Promise<BatchOperationResult & { batchId: string }> {
    const result = await this.pendingApprovalService.approveBatch(batchId);
    return { ...result, batchId };
  }

  /**
   * Reject all pending items in a batch.
   *
   * POST /pending-approval/batch/:batchId/reject
   */
  @Post('batch/:batchId/reject')
  @HttpCode(HttpStatus.OK)
  async rejectBatch(
    @Param('batchId', ParseUUIDPipe) batchId: string,
  ): Promise<BatchOperationResult & { batchId: string }> {
    const result = await this.pendingApprovalService.rejectBatch(batchId);
    return { ...result, batchId };
  }

  // ─────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────

  private mapApprovalToResponse(approval: PendingApproval): PendingApprovalResponse {
    const { sourceInteraction, sourceEntity, ...rest } = approval;
    return {
      ...rest,
      sourceInteractionId: sourceInteraction?.id ?? approval.sourceInteractionId,
      sourceEntityId: sourceEntity?.id ?? approval.sourceEntityId,
    };
  }
}
