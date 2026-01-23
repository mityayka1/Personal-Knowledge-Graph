import {
  Controller,
  Post,
  Get,
  Param,
  ParseIntPipe,
  Body,
  BadRequestException,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { BriefResponse } from '@pkg/entities';
import { BriefService } from './brief.service';
import { BriefActionDto } from './brief.dto';

/**
 * Controller for Morning Brief accordion operations.
 *
 * Handles:
 * - Expand/collapse items
 * - Mark as done
 * - Mark as dismissed
 * - Trigger actions (write, remind, prepare)
 *
 * Business logic is delegated to BriefService.
 * Formatting is done by the client (telegram-adapter) following Source-Agnostic principle.
 */
@ApiTags('brief')
@Controller('brief')
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class BriefController {
  constructor(private readonly briefService: BriefService) {}

  /**
   * Get brief state
   */
  @Get(':briefId')
  @ApiOperation({
    summary: 'Get brief state',
    description: 'Returns brief state (formatting is done by client)',
  })
  @ApiParam({ name: 'briefId', description: 'Brief ID (e.g., b_abc123)' })
  @ApiResponse({ status: 200, description: 'Brief state retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Brief not found or expired' })
  async getBrief(@Param('briefId') briefId: string): Promise<BriefResponse> {
    const state = await this.briefService.getBrief(briefId);

    return {
      success: true,
      state,
    };
  }

  /**
   * Expand an item in the brief
   */
  @Post(':briefId/expand/:index')
  @ApiOperation({
    summary: 'Expand item',
    description: 'Expands an item to show details and action buttons',
  })
  @ApiParam({ name: 'briefId', description: 'Brief ID' })
  @ApiParam({ name: 'index', description: 'Item index (0-based)' })
  @ApiResponse({ status: 200, description: 'Item expanded successfully' })
  @ApiResponse({ status: 404, description: 'Brief not found or expired' })
  async expand(
    @Param('briefId') briefId: string,
    @Param('index', ParseIntPipe) index: number,
  ): Promise<BriefResponse> {
    const state = await this.briefService.expand(briefId, index);

    return {
      success: true,
      state,
    };
  }

  /**
   * Collapse all items (go back to overview)
   */
  @Post(':briefId/collapse')
  @ApiOperation({
    summary: 'Collapse items',
    description: 'Collapses all items to overview mode',
  })
  @ApiParam({ name: 'briefId', description: 'Brief ID' })
  @ApiResponse({ status: 200, description: 'Items collapsed successfully' })
  @ApiResponse({ status: 404, description: 'Brief not found or expired' })
  async collapse(@Param('briefId') briefId: string): Promise<BriefResponse> {
    const state = await this.briefService.collapse(briefId);

    return {
      success: true,
      state,
    };
  }

  /**
   * Mark item as done (completed)
   */
  @Post(':briefId/done/:index')
  @ApiOperation({
    summary: 'Mark item done',
    description: 'Marks item as completed and removes from brief',
  })
  @ApiParam({ name: 'briefId', description: 'Brief ID' })
  @ApiParam({ name: 'index', description: 'Item index (0-based)' })
  @ApiResponse({ status: 200, description: 'Item marked as done' })
  @ApiResponse({ status: 404, description: 'Item or brief not found' })
  async markDone(
    @Param('briefId') briefId: string,
    @Param('index', ParseIntPipe) index: number,
  ): Promise<BriefResponse> {
    const { state, allDone } = await this.briefService.markDone(briefId, index);

    if (allDone) {
      return {
        success: true,
        state,
        message: 'Все задачи выполнены! Отличная работа!',
      };
    }

    return {
      success: true,
      state,
    };
  }

  /**
   * Mark item as dismissed (not going to do)
   */
  @Post(':briefId/dismiss/:index')
  @ApiOperation({
    summary: 'Mark item dismissed',
    description: 'Marks item as dismissed (not relevant) and removes from brief',
  })
  @ApiParam({ name: 'briefId', description: 'Brief ID' })
  @ApiParam({ name: 'index', description: 'Item index (0-based)' })
  @ApiResponse({ status: 200, description: 'Item dismissed' })
  @ApiResponse({ status: 404, description: 'Item or brief not found' })
  async markDismissed(
    @Param('briefId') briefId: string,
    @Param('index', ParseIntPipe) index: number,
  ): Promise<BriefResponse> {
    const { state, allDone } = await this.briefService.markDismissed(briefId, index);

    if (allDone) {
      return {
        success: true,
        state,
        message: 'Все задачи обработаны!',
      };
    }

    return {
      success: true,
      state,
    };
  }

  /**
   * Trigger an action (write message, remind, prepare brief)
   */
  @Post(':briefId/action/:index')
  @ApiOperation({
    summary: 'Trigger action',
    description: 'Triggers an action for the item (write, remind, prepare)',
  })
  @ApiParam({ name: 'briefId', description: 'Brief ID' })
  @ApiParam({ name: 'index', description: 'Item index (0-based)' })
  @ApiResponse({ status: 200, description: 'Action triggered successfully' })
  @ApiResponse({ status: 400, description: 'Invalid action type' })
  @ApiResponse({ status: 404, description: 'Item not found' })
  async triggerAction(
    @Param('briefId') briefId: string,
    @Param('index', ParseIntPipe) index: number,
    @Body() dto: BriefActionDto,
  ): Promise<BriefResponse> {
    const item = await this.briefService.getItem(briefId, index);

    if (!dto.actionType) {
      throw new BadRequestException('actionType is required');
    }

    // Return info for the action - actual execution is handled by telegram-adapter
    // Use getBrief which throws NotFoundException if not found
    const state = await this.briefService.getBrief(briefId);

    return {
      success: true,
      message: `Action ${dto.actionType} triggered for ${item.entityName}`,
      state,
    };
  }
}
