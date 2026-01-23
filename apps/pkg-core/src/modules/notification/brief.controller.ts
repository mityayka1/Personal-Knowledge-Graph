import {
  Controller,
  Post,
  Get,
  Param,
  ParseIntPipe,
  Body,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IsOptional, IsIn } from 'class-validator';
import { EntityEvent, EventStatus } from '@pkg/entities';
import { BriefStateService, BriefState, BriefItem } from './brief-state.service';

/**
 * DTO for action requests
 */
export class BriefActionDto {
  @IsOptional()
  @IsIn(['write', 'remind', 'prepare'])
  actionType?: 'write' | 'remind' | 'prepare';
}

/**
 * Response for brief operations
 */
export interface BriefResponse {
  success: boolean;
  state?: BriefState;
  message?: string;
  /** Formatted message text for Telegram UI update */
  formattedMessage?: string;
  /** Buttons for Telegram UI update */
  buttons?: Array<Array<{ text: string; callback_data: string }>>;
}

/**
 * Controller for Morning Brief accordion operations.
 *
 * Handles:
 * - Expand/collapse items
 * - Mark as done
 * - Mark as dismissed
 * - Trigger actions (write, remind, prepare)
 */
@Controller('brief')
export class BriefController {
  private readonly logger = new Logger(BriefController.name);

  constructor(
    private readonly briefStateService: BriefStateService,
    @InjectRepository(EntityEvent)
    private readonly entityEventRepo: Repository<EntityEvent>,
  ) {}

  /**
   * Get brief state
   */
  @Get(':briefId')
  async getBrief(@Param('briefId') briefId: string): Promise<BriefResponse> {
    const state = await this.briefStateService.get(briefId);
    if (!state) {
      throw new NotFoundException('Brief not found or expired');
    }

    return {
      success: true,
      state,
      formattedMessage: this.formatBriefMessage(state),
      buttons: this.getBriefButtons(state),
    };
  }

  /**
   * Expand an item in the brief
   */
  @Post(':briefId/expand/:index')
  async expand(
    @Param('briefId') briefId: string,
    @Param('index', ParseIntPipe) index: number,
  ): Promise<BriefResponse> {
    const state = await this.briefStateService.expand(briefId, index);
    if (!state) {
      throw new NotFoundException('Brief not found or expired');
    }

    return {
      success: true,
      state,
      formattedMessage: this.formatBriefMessage(state),
      buttons: this.getBriefButtons(state),
    };
  }

  /**
   * Collapse all items (go back to overview)
   */
  @Post(':briefId/collapse')
  async collapse(@Param('briefId') briefId: string): Promise<BriefResponse> {
    const state = await this.briefStateService.collapse(briefId);
    if (!state) {
      throw new NotFoundException('Brief not found or expired');
    }

    return {
      success: true,
      state,
      formattedMessage: this.formatBriefMessage(state),
      buttons: this.getBriefButtons(state),
    };
  }

  /**
   * Mark item as done (completed)
   */
  @Post(':briefId/done/:index')
  async markDone(
    @Param('briefId') briefId: string,
    @Param('index', ParseIntPipe) index: number,
  ): Promise<BriefResponse> {
    const item = await this.briefStateService.getItem(briefId, index);
    if (!item) {
      throw new NotFoundException('Item not found');
    }

    // Update source entity status
    await this.updateSourceStatus(item, EventStatus.COMPLETED);

    // Remove item from brief
    const state = await this.briefStateService.removeItem(briefId, index);
    if (!state) {
      throw new NotFoundException('Brief not found or expired');
    }

    this.logger.log(`Marked item as done: ${item.title} (${item.sourceType}:${item.sourceId})`);

    // Check if brief is now empty
    if (state.items.length === 0) {
      return {
        success: true,
        state,
        message: 'Все задачи выполнены! Отличная работа! 🎉',
        formattedMessage: '<b>🎉 Все задачи выполнены!</b>\n\nОтличная работа!',
        buttons: [],
      };
    }

    return {
      success: true,
      state,
      formattedMessage: this.formatBriefMessage(state),
      buttons: this.getBriefButtons(state),
    };
  }

  /**
   * Mark item as dismissed (not going to do)
   */
  @Post(':briefId/dismiss/:index')
  async markDismissed(
    @Param('briefId') briefId: string,
    @Param('index', ParseIntPipe) index: number,
  ): Promise<BriefResponse> {
    const item = await this.briefStateService.getItem(briefId, index);
    if (!item) {
      throw new NotFoundException('Item not found');
    }

    // Update source entity status
    await this.updateSourceStatus(item, EventStatus.DISMISSED);

    // Remove item from brief
    const state = await this.briefStateService.removeItem(briefId, index);
    if (!state) {
      throw new NotFoundException('Brief not found or expired');
    }

    this.logger.log(`Dismissed item: ${item.title} (${item.sourceType}:${item.sourceId})`);

    // Check if brief is now empty
    if (state.items.length === 0) {
      return {
        success: true,
        state,
        message: 'Все задачи обработаны!',
        formattedMessage: '<b>✅ Все задачи обработаны!</b>',
        buttons: [],
      };
    }

    return {
      success: true,
      state,
      formattedMessage: this.formatBriefMessage(state),
      buttons: this.getBriefButtons(state),
    };
  }

  /**
   * Trigger an action (write message, remind, prepare brief)
   */
  @Post(':briefId/action/:index')
  async triggerAction(
    @Param('briefId') briefId: string,
    @Param('index', ParseIntPipe) index: number,
    @Body() dto: BriefActionDto,
  ): Promise<BriefResponse> {
    const item = await this.briefStateService.getItem(briefId, index);
    if (!item) {
      throw new NotFoundException('Item not found');
    }

    if (!dto.actionType) {
      throw new BadRequestException('actionType is required');
    }

    // Return info for the action - actual execution is handled by telegram-adapter
    return {
      success: true,
      message: `Action ${dto.actionType} triggered for ${item.entityName}`,
      state: await this.briefStateService.get(briefId) || undefined,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────

  /**
   * Update status of the source entity
   */
  private async updateSourceStatus(item: BriefItem, status: EventStatus): Promise<void> {
    if (item.sourceType === 'entity_event') {
      await this.entityEventRepo.update(item.sourceId, { status });
    }
    // Note: extracted_event and entity_fact handling can be added here
  }

  /**
   * Format brief message for Telegram
   */
  formatBriefMessage(state: BriefState): string {
    const parts: string[] = ['<b>🌅 Доброе утро! Вот твой день:</b>', ''];

    state.items.forEach((item, index) => {
      const num = index + 1;
      const emoji = this.getItemEmoji(item.type);
      const isExpanded = state.expandedIndex === index;

      if (isExpanded) {
        // Expanded view
        parts.push(`<b>${num}. ${emoji} ${this.escapeHtml(item.title)}</b>`);
        parts.push('   ━━━━━━━━━━━━━━━━━━━━━━━━━━');
        parts.push(`   👤 ${this.escapeHtml(item.entityName)}`);
        if (item.details) {
          parts.push(`   📝 ${this.escapeHtml(item.details)}`);
        }
        if (item.sourceMessageLink) {
          const safeUrl = this.sanitizeUrl(item.sourceMessageLink);
          if (safeUrl) {
            parts.push(`   🔗 <a href="${safeUrl}">Перейти к сообщению</a>`);
          }
        }
        parts.push('   ━━━━━━━━━━━━━━━━━━━━━━━━━━');
        parts.push('');
      } else {
        // Collapsed view
        parts.push(`${num}. ${emoji} ${this.escapeHtml(item.title)}`);
      }
    });

    if (state.items.length === 0) {
      parts.push('Нет активных задач.');
    }

    return parts.join('\n');
  }

  /**
   * Get buttons for brief UI
   */
  getBriefButtons(
    state: BriefState,
  ): Array<Array<{ text: string; callback_data: string }>> {
    const buttons: Array<Array<{ text: string; callback_data: string }>> = [];

    if (state.items.length === 0) {
      return buttons;
    }

    // Number buttons for quick navigation
    if (state.expandedIndex === null) {
      // Collapsed state - show number buttons
      const numberRow: Array<{ text: string; callback_data: string }> = [];
      state.items.forEach((_, index) => {
        numberRow.push({
          text: `${index + 1}`,
          callback_data: `br_e:${state.id}:${index}`,
        });
      });
      buttons.push(numberRow);
    } else {
      // Expanded state - show action buttons
      const item = state.items[state.expandedIndex];

      // Number buttons with current highlighted
      const numberRow: Array<{ text: string; callback_data: string }> = [];
      state.items.forEach((_, index) => {
        const isExpanded = index === state.expandedIndex;
        numberRow.push({
          text: isExpanded ? `${index + 1} ▼` : `${index + 1}`,
          callback_data: `br_e:${state.id}:${index}`,
        });
      });
      buttons.push(numberRow);

      // Action buttons based on item type
      const actionRow = this.getItemActionButtons(state.id, state.expandedIndex, item);
      if (actionRow.length > 0) {
        buttons.push(actionRow);
      }

      // Collapse button
      buttons.push([{ text: '🔙 Свернуть', callback_data: `br_c:${state.id}` }]);
    }

    return buttons;
  }

  /**
   * Get action buttons for a specific item type
   */
  private getItemActionButtons(
    briefId: string,
    index: number,
    item: BriefItem,
  ): Array<{ text: string; callback_data: string }> {
    const buttons: Array<{ text: string; callback_data: string }> = [];

    switch (item.type) {
      case 'meeting':
        buttons.push({ text: '📋 Brief', callback_data: `br_p:${briefId}:${index}` });
        buttons.push({ text: '💬 Написать', callback_data: `br_w:${briefId}:${index}` });
        break;

      case 'task':
      case 'overdue':
        buttons.push({ text: '✅ Готово', callback_data: `br_d:${briefId}:${index}` });
        buttons.push({ text: '➖ Не актуально', callback_data: `br_x:${briefId}:${index}` });
        buttons.push({ text: '💬 Написать', callback_data: `br_w:${briefId}:${index}` });
        break;

      case 'followup':
        buttons.push({ text: '✅ Готово', callback_data: `br_d:${briefId}:${index}` });
        buttons.push({ text: '➖ Не актуально', callback_data: `br_x:${briefId}:${index}` });
        buttons.push({ text: '💬 Напомнить', callback_data: `br_r:${briefId}:${index}` });
        break;

      case 'birthday':
        buttons.push({ text: '💬 Поздравить', callback_data: `br_w:${briefId}:${index}` });
        break;
    }

    return buttons;
  }

  /**
   * Get emoji for item type
   */
  private getItemEmoji(type: BriefItem['type']): string {
    switch (type) {
      case 'meeting':
        return '📅';
      case 'task':
        return '📋';
      case 'followup':
        return '👀';
      case 'overdue':
        return '⚠️';
      case 'birthday':
        return '🎂';
      default:
        return '📌';
    }
  }

  /**
   * Escape HTML special characters for text content
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Validate and escape URL for use in href attribute
   */
  private sanitizeUrl(url: string): string | null {
    // Only allow https:// or tg:// protocols
    if (!url.startsWith('https://') && !url.startsWith('tg://')) {
      this.logger.warn(`Invalid URL protocol: ${url}`);
      return null;
    }
    // Escape quotes for attribute context
    return url.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
}
