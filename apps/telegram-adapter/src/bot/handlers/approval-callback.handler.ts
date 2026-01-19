import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';
import { PkgCoreApiService } from '../../api/pkg-core-api.service';

/**
 * State for edit mode conversations
 */
interface EditModeState {
  approvalId: string;
  mode: 'describe' | 'verbatim';
  chatId: number;
  expiresAt: number;
}

/**
 * Handles callback queries from message approval buttons.
 *
 * Callback data format:
 * - act_a:<approvalId> — approve and send message
 * - act_e:<approvalId> — enter edit mode
 * - act_r:<approvalId> — reject/cancel
 *
 * Edit mode callbacks:
 * - edit_d:<approvalId> — describe mode (AI regenerates)
 * - edit_v:<approvalId> — verbatim mode (user types exact text)
 */
@Injectable()
export class ApprovalCallbackHandler {
  private readonly logger = new Logger(ApprovalCallbackHandler.name);

  /**
   * Pending edit mode states by chatId
   * Used to track which approval the user is editing
   */
  private readonly editModeStates = new Map<number, EditModeState>();

  /**
   * TTL for edit mode states (5 minutes)
   */
  private readonly EDIT_MODE_TTL_MS = 5 * 60 * 1000;

  constructor(private readonly pkgCoreApi: PkgCoreApiService) {}

  /**
   * Check if this handler can process the callback
   */
  canHandle(callbackData: string): boolean {
    return (
      callbackData.startsWith('act_a:') ||
      callbackData.startsWith('act_e:') ||
      callbackData.startsWith('act_r:') ||
      callbackData.startsWith('edit_d:') ||
      callbackData.startsWith('edit_v:')
    );
  }

  /**
   * Check if user is in edit mode for any approval
   */
  isInEditMode(chatId: number): boolean {
    const state = this.editModeStates.get(chatId);
    if (!state) return false;

    // Check if expired
    if (Date.now() > state.expiresAt) {
      this.editModeStates.delete(chatId);
      return false;
    }

    return true;
  }

  /**
   * Get edit mode state for chat
   */
  getEditModeState(chatId: number): EditModeState | null {
    const state = this.editModeStates.get(chatId);
    if (!state) return null;

    // Check if expired
    if (Date.now() > state.expiresAt) {
      this.editModeStates.delete(chatId);
      return null;
    }

    return state;
  }

  /**
   * Clear edit mode state
   */
  clearEditMode(chatId: number): void {
    this.editModeStates.delete(chatId);
  }

  /**
   * Handle text message in edit mode
   */
  async handleTextMessage(ctx: Context, text: string): Promise<boolean> {
    const chatId = ctx.chat?.id;
    if (!chatId) return false;

    const state = this.getEditModeState(chatId);
    if (!state) return false;

    this.logger.log(`Processing edit mode text for approval ${state.approvalId}, mode=${state.mode}`);

    try {
      if (state.mode === 'verbatim') {
        // Update text directly
        await this.pkgCoreApi.updateApprovalText(state.approvalId, text);
        await ctx.reply('Текст обновлён. Ожидайте подтверждение.');
      } else {
        // Regenerate via AI
        await this.pkgCoreApi.regenerateApprovalText(state.approvalId, text);
        await ctx.reply('Генерирую новый текст...');
      }

      // Clear edit mode after processing
      this.clearEditMode(chatId);
      return true;
    } catch (error) {
      this.logger.error(`Failed to process edit mode text:`, error);
      await ctx.reply('Ошибка при обработке текста. Попробуйте снова.');
      return true;
    }
  }

  /**
   * Handle callback query
   */
  async handle(ctx: Context): Promise<void> {
    const callbackQuery = ctx.callbackQuery;
    if (!callbackQuery || !('data' in callbackQuery)) {
      return;
    }

    const callbackData = callbackQuery.data;

    if (!this.canHandle(callbackData)) {
      this.logger.warn(`Unknown callback data format: ${callbackData}`);
      await ctx.answerCbQuery('Unknown action');
      return;
    }

    // Handle approve
    if (callbackData.startsWith('act_a:')) {
      await this.handleApprove(ctx, callbackData);
      return;
    }

    // Handle edit
    if (callbackData.startsWith('act_e:')) {
      await this.handleEdit(ctx, callbackData);
      return;
    }

    // Handle reject
    if (callbackData.startsWith('act_r:')) {
      await this.handleReject(ctx, callbackData);
      return;
    }

    // Handle edit mode selection: describe
    if (callbackData.startsWith('edit_d:')) {
      await this.handleEditModeSelection(ctx, callbackData, 'describe');
      return;
    }

    // Handle edit mode selection: verbatim
    if (callbackData.startsWith('edit_v:')) {
      await this.handleEditModeSelection(ctx, callbackData, 'verbatim');
      return;
    }
  }

  /**
   * Handle approve action - send the message
   */
  private async handleApprove(ctx: Context, callbackData: string): Promise<void> {
    const approvalId = callbackData.substring(6); // Remove 'act_a:'
    this.logger.log(`Approve action, approvalId=${approvalId}`);

    try {
      await ctx.answerCbQuery('Отправляю...');

      const result = await this.pkgCoreApi.approveAndSend(approvalId);

      if (result.success) {
        await this.updateMessageWithResult(ctx, '✅ Сообщение отправлено');
      } else {
        await ctx.answerCbQuery('Ошибка отправки');
        await this.updateMessageWithResult(ctx, `❌ Ошибка: ${result.error || 'не удалось отправить'}`);
      }
    } catch (error) {
      this.logger.error(`Failed to approve message:`, error);
      await ctx.answerCbQuery('Ошибка сервера');
    }
  }

  /**
   * Handle edit action - show edit mode selection
   */
  private async handleEdit(ctx: Context, callbackData: string): Promise<void> {
    const approvalId = callbackData.substring(6); // Remove 'act_e:'
    this.logger.log(`Edit action, approvalId=${approvalId}`);

    try {
      // Show edit mode selection buttons
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [
          [
            { text: '💡 Задать', callback_data: `edit_d:${approvalId}` },
            { text: '📝 Как есть', callback_data: `edit_v:${approvalId}` },
          ],
          [
            { text: '« Назад', callback_data: `act_a:${approvalId}` }, // Back to approve (shows original buttons)
          ],
        ],
      });
      await ctx.answerCbQuery('Выберите режим редактирования');
    } catch (error) {
      this.logger.error(`Failed to show edit options:`, error);
      await ctx.answerCbQuery('Ошибка');
    }
  }

  /**
   * Handle reject action - cancel the message
   */
  private async handleReject(ctx: Context, callbackData: string): Promise<void> {
    const approvalId = callbackData.substring(6); // Remove 'act_r:'
    this.logger.log(`Reject action, approvalId=${approvalId}`);

    try {
      await this.pkgCoreApi.rejectApproval(approvalId);
      await ctx.answerCbQuery('Отменено');
      await this.updateMessageWithResult(ctx, '❌ Отменено');
    } catch (error) {
      this.logger.error(`Failed to reject message:`, error);
      await ctx.answerCbQuery('Ошибка');
    }
  }

  /**
   * Handle edit mode selection
   */
  private async handleEditModeSelection(
    ctx: Context,
    callbackData: string,
    mode: 'describe' | 'verbatim',
  ): Promise<void> {
    const approvalId = callbackData.substring(7); // Remove 'edit_d:' or 'edit_v:'
    const chatId = ctx.chat?.id;

    if (!chatId) {
      await ctx.answerCbQuery('Ошибка');
      return;
    }

    this.logger.log(`Edit mode selected: ${mode}, approvalId=${approvalId}`);

    try {
      // Set edit mode via API
      await this.pkgCoreApi.setApprovalEditMode(approvalId, mode);

      // Store edit mode state locally
      this.editModeStates.set(chatId, {
        approvalId,
        mode,
        chatId,
        expiresAt: Date.now() + this.EDIT_MODE_TTL_MS,
      });

      // Show appropriate prompt
      const promptText =
        mode === 'describe'
          ? '💡 Опишите, что хотите написать, и я сформулирую сообщение:'
          : '📝 Напишите точный текст, который хотите отправить:';

      await ctx.answerCbQuery();
      await ctx.reply(promptText);
    } catch (error) {
      this.logger.error(`Failed to set edit mode:`, error);
      await ctx.answerCbQuery('Ошибка');
    }
  }

  /**
   * Update message with result text
   */
  private async updateMessageWithResult(ctx: Context, resultText: string): Promise<void> {
    try {
      const message = ctx.callbackQuery?.message;
      if (message && 'text' in message) {
        // Extract original message content (before any previous result)
        const originalText = message.text.split('\n\n<i>')[0];
        await ctx.editMessageText(`${originalText}\n\n<i>${resultText}</i>`, {
          parse_mode: 'HTML',
        });
      }
    } catch (error) {
      this.logger.warn('Could not update message:', error);
    }
  }
}
