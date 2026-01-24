import { Injectable } from '@nestjs/common';
import {
  BriefState,
  BriefItem,
  TelegramInlineKeyboard,
  TelegramKeyboardButton,
  escapeHtml,
  sanitizeUrl,
  BRIEF_CALLBACKS,
  makeBriefCallback,
} from '@pkg/entities';

/**
 * Service for formatting Morning Brief data for Telegram display.
 *
 * This service is responsible for all Telegram-specific formatting:
 * - HTML message rendering
 * - Inline keyboard button generation
 *
 * Following Source-Agnostic principle: pkg-core returns raw data,
 * telegram-adapter handles presentation.
 */
@Injectable()
export class BriefFormatterService {
  /**
   * Format brief state as HTML message for Telegram.
   *
   * Renders items in collapsed or expanded view depending on state.expandedIndex.
   */
  formatMessage(state: BriefState): string {
    const parts: string[] = ['<b>🌅 Доброе утро! Вот твой день:</b>', ''];

    state.items.forEach((item: BriefItem, index: number) => {
      const num = index + 1;
      const emoji = this.getItemEmoji(item.type);
      const isExpanded = state.expandedIndex === index;

      if (isExpanded) {
        // Expanded view
        parts.push(`<b>${num}. ${emoji} ${escapeHtml(item.title)}</b>`);
        parts.push('   ━━━━━━━━━━━━━━━━━━━━━━━━━━');
        parts.push(`   👤 ${escapeHtml(item.entityName)}`);
        if (item.details) {
          parts.push(`   📝 ${escapeHtml(item.details)}`);
        }
        if (item.sourceMessageLink) {
          const safeUrl = sanitizeUrl(item.sourceMessageLink);
          if (safeUrl) {
            parts.push(`   🔗 <a href="${safeUrl}">Перейти к сообщению</a>`);
          }
        }
        parts.push('   ━━━━━━━━━━━━━━━━━━━━━━━━━━');
        parts.push('');
      } else {
        // Collapsed view
        parts.push(`${num}. ${emoji} ${escapeHtml(item.title)}`);
      }
    });

    if (state.items.length === 0) {
      parts.push('Нет активных задач.');
    }

    return parts.join('\n');
  }

  /**
   * Format "all done" completion message.
   */
  formatAllDoneMessage(): string {
    return '<b>🎉 Все задачи выполнены!</b>\n\nОтличная работа!';
  }

  /**
   * Format "all processed" completion message (used when items are dismissed).
   */
  formatAllProcessedMessage(): string {
    return '<b>✅ Все задачи обработаны!</b>';
  }

  /**
   * Generate inline keyboard buttons for brief.
   *
   * In collapsed state: number buttons for quick navigation.
   * In expanded state: number buttons + action buttons + collapse button.
   */
  getButtons(state: BriefState): TelegramInlineKeyboard {
    const buttons: TelegramInlineKeyboard = [];

    if (state.items.length === 0) {
      return buttons;
    }

    // Number buttons for quick navigation
    if (state.expandedIndex === null) {
      // Collapsed state - show number buttons
      const numberRow: TelegramKeyboardButton[] = [];
      state.items.forEach((_: BriefItem, index: number) => {
        numberRow.push({
          text: `${index + 1}`,
          callback_data: makeBriefCallback(BRIEF_CALLBACKS.EXPAND, state.id, index),
        });
      });
      buttons.push(numberRow);
    } else {
      // Expanded state - show action buttons
      const item = state.items[state.expandedIndex];

      // Number buttons with current highlighted
      const numberRow: TelegramKeyboardButton[] = [];
      state.items.forEach((_: BriefItem, index: number) => {
        const isExpanded = index === state.expandedIndex;
        numberRow.push({
          text: isExpanded ? `${index + 1} ▼` : `${index + 1}`,
          callback_data: makeBriefCallback(BRIEF_CALLBACKS.EXPAND, state.id, index),
        });
      });
      buttons.push(numberRow);

      // Action buttons based on item type
      const actionRow = this.getItemActionButtons(state.id, state.expandedIndex, item);
      if (actionRow.length > 0) {
        buttons.push(actionRow);
      }

      // Collapse button
      buttons.push([
        {
          text: '🔙 Свернуть',
          callback_data: makeBriefCallback(BRIEF_CALLBACKS.COLLAPSE, state.id),
        },
      ]);
    }

    return buttons;
  }

  /**
   * Get emoji for item type.
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
   * Get action buttons for a specific item type.
   */
  private getItemActionButtons(
    briefId: string,
    index: number,
    item: BriefItem,
  ): TelegramKeyboardButton[] {
    const buttons: TelegramKeyboardButton[] = [];

    switch (item.type) {
      case 'meeting':
        buttons.push({
          text: '📋 Brief',
          callback_data: makeBriefCallback(BRIEF_CALLBACKS.PREPARE, briefId, index),
        });
        buttons.push({
          text: '💬 Написать',
          callback_data: makeBriefCallback(BRIEF_CALLBACKS.WRITE, briefId, index),
        });
        break;

      case 'task':
      case 'overdue':
        buttons.push({
          text: '✅ Готово',
          callback_data: makeBriefCallback(BRIEF_CALLBACKS.DONE, briefId, index),
        });
        buttons.push({
          text: '➖ Не актуально',
          callback_data: makeBriefCallback(BRIEF_CALLBACKS.DISMISS, briefId, index),
        });
        buttons.push({
          text: '💬 Написать',
          callback_data: makeBriefCallback(BRIEF_CALLBACKS.WRITE, briefId, index),
        });
        break;

      case 'followup':
        buttons.push({
          text: '✅ Готово',
          callback_data: makeBriefCallback(BRIEF_CALLBACKS.DONE, briefId, index),
        });
        buttons.push({
          text: '➖ Не актуально',
          callback_data: makeBriefCallback(BRIEF_CALLBACKS.DISMISS, briefId, index),
        });
        buttons.push({
          text: '💬 Напомнить',
          callback_data: makeBriefCallback(BRIEF_CALLBACKS.REMIND, briefId, index),
        });
        break;

      case 'birthday':
        buttons.push({
          text: '💬 Поздравить',
          callback_data: makeBriefCallback(BRIEF_CALLBACKS.WRITE, briefId, index),
        });
        break;
    }

    return buttons;
  }
}
