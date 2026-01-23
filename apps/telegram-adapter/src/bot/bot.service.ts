import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf, Context } from 'telegraf';
import { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';
import { RecallHandler } from './handlers/recall.handler';
import { PrepareHandler } from './handlers/prepare.handler';
import { ActHandler } from './handlers/act.handler';
import { DigestHandler } from './handlers/digest.handler';
import { EventCallbackHandler } from './handlers/event-callback.handler';
import { CarouselCallbackHandler } from './handlers/carousel-callback.handler';
import { ApprovalCallbackHandler } from './handlers/approval-callback.handler';

export interface SendNotificationOptions {
  chatId: number | string;
  message: string;
  parseMode?: 'Markdown' | 'HTML';
  buttons?: Array<Array<{ text: string; callback_data: string }>>;
}

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  private bot: Telegraf | null = null;
  private allowedUsers: number[] = [];
  private ownerChatId: number | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly recallHandler: RecallHandler,
    private readonly prepareHandler: PrepareHandler,
    private readonly actHandler: ActHandler,
    private readonly digestHandler: DigestHandler,
    private readonly eventCallbackHandler: EventCallbackHandler,
    @Inject(forwardRef(() => CarouselCallbackHandler))
    private readonly carouselCallbackHandler: CarouselCallbackHandler,
    @Inject(forwardRef(() => ApprovalCallbackHandler))
    private readonly approvalCallbackHandler: ApprovalCallbackHandler,
  ) {}

  async onModuleInit(): Promise<void> {
    const botToken = this.configService.get<string>('telegram.botToken');

    if (!botToken) {
      this.logger.warn('TELEGRAM_BOT_TOKEN not configured. Bot commands disabled.');
      return;
    }

    // Load allowed users from config
    this.allowedUsers =
      this.configService.get<number[]>('telegram.allowedUsers') || [];

    if (this.allowedUsers.length === 0) {
      this.logger.warn(
        'TELEGRAM_BOT_ALLOWED_USERS not configured. Bot will reject all users!',
      );
    } else {
      this.logger.log(
        `Bot access restricted to ${this.allowedUsers.length} user(s): ${this.allowedUsers.join(', ')}`,
      );
    }

    // Load owner chat ID (first allowed user is the owner by default)
    this.ownerChatId =
      this.configService.get<number>('telegram.ownerChatId') ||
      this.allowedUsers[0] ||
      null;

    if (this.ownerChatId) {
      this.logger.log(`Owner chat ID configured: ${this.ownerChatId}`);
    } else {
      this.logger.warn('Owner chat ID not configured. Notifications will not be sent.');
    }

    this.bot = new Telegraf(botToken);

    // Security middleware: check if user is allowed
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;

      if (!userId) {
        this.logger.warn('Received update without user ID');
        return;
      }

      if (this.allowedUsers.length > 0 && !this.allowedUsers.includes(userId)) {
        this.logger.warn(
          `Unauthorized access attempt from user ${userId} (${ctx.from?.username || 'no username'})`,
        );
        await ctx.reply(
          '⛔ Доступ запрещён.\n\nЭтот бот предназначен для личного использования.',
        );
        return;
      }

      return next();
    });

    // Register commands with Telegram for hints
    await this.bot.telegram.setMyCommands([
      { command: 'start', description: 'Начать работу с ботом' },
      { command: 'help', description: 'Показать справку по командам' },
      { command: 'recall', description: 'Поиск по переписке' },
      { command: 'prepare', description: 'Подготовка к встрече' },
      { command: 'act', description: 'Выполнить действие (написать, напомнить)' },
      { command: 'morning', description: 'Утренний бриф' },
      { command: 'digest', description: 'Дайджест pending событий' },
      { command: 'daily', description: 'Дневной дайджест' },
    ]);
    this.logger.log('Bot commands registered with Telegram');

    this.setupCommands();
    this.setupCallbackHandlers();
    this.setupErrorHandling();

    // Launch bot in polling mode (don't await - it blocks forever)
    this.bot.launch().then(() => {
      this.logger.log('Telegraf bot started successfully');
    }).catch((error) => {
      this.logger.error('Failed to launch Telegraf bot', error);
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.bot) {
      this.bot.stop('SIGTERM');
      this.logger.log('Telegraf bot stopped');
    }
  }

  /**
   * Check if user is the owner (for owner-only commands)
   */
  private isOwner(userId: number | undefined): boolean {
    return this.ownerChatId !== null && userId === this.ownerChatId;
  }

  private setupCommands(): void {
    if (!this.bot) return;

    // /start command
    this.bot.start(async (ctx) => {
      await ctx.reply(
        '🧠 *Second Brain Bot*\n\n' +
          '*Поиск и подготовка:*\n' +
          '`/recall <запрос>` — поиск по переписке\n' +
          '`/prepare <имя>` — подготовка к встрече\n' +
          '`/act <действие>` — выполнить действие\n\n' +
          '*Брифы и дайджесты:*\n' +
          '`/morning` — утренний бриф\n' +
          '`/digest` — дайджест pending событий\n' +
          '`/daily` — дневной дайджест',
        { parse_mode: 'Markdown' },
      );
    });

    // /help command
    this.bot.help(async (ctx) => {
      await ctx.reply(
        '*Команды:*\n\n' +
          '`/recall <запрос>`\n' +
          'Поиск по истории переписки на естественном языке.\n' +
          'Пример: `/recall кто говорил про инвестиции?`\n\n' +
          '`/prepare <имя>`\n' +
          'Подготовка брифа перед встречей с человеком.\n' +
          'Пример: `/prepare Мария Иванова`\n\n' +
          '`/act <действие>`\n' +
          'Выполнить действие: написать контакту, напоминание.\n' +
          'Пример: `/act напиши Сергею что встреча переносится`\n\n' +
          '`/morning` — утренний бриф\n' +
          '`/digest` — дайджест pending событий\n' +
          '`/daily` — дневной дайджест',
        { parse_mode: 'Markdown' },
      );
    });

    // /recall command
    this.bot.command('recall', async (ctx) => {
      await this.recallHandler.handle(ctx);
    });

    // /prepare command
    this.bot.command('prepare', async (ctx) => {
      await this.prepareHandler.handle(ctx);
    });

    // /act command
    this.bot.command('act', async (ctx) => {
      await this.actHandler.handle(ctx);
    });

    // /morning command (owner-only)
    this.bot.command('morning', async (ctx) => {
      if (!this.isOwner(ctx.from?.id)) {
        await ctx.reply('⛔ Эта команда доступна только владельцу бота.');
        return;
      }
      await this.digestHandler.handleMorning(ctx);
    });

    // /digest command (owner-only)
    this.bot.command('digest', async (ctx) => {
      if (!this.isOwner(ctx.from?.id)) {
        await ctx.reply('⛔ Эта команда доступна только владельцу бота.');
        return;
      }
      await this.digestHandler.handleDigest(ctx);
    });

    // /daily command (owner-only)
    this.bot.command('daily', async (ctx) => {
      if (!this.isOwner(ctx.from?.id)) {
        await ctx.reply('⛔ Эта команда доступна только владельцу бота.');
        return;
      }
      await this.digestHandler.handleDaily(ctx);
    });

    this.logger.log('Bot commands registered: /start, /help, /recall, /prepare, /act, /morning, /digest, /daily');
  }

  private setupCallbackHandlers(): void {
    if (!this.bot) return;

    // Handle callback queries from inline buttons
    this.bot.on('callback_query', async (ctx) => {
      const callbackQuery = ctx.callbackQuery;
      if (!callbackQuery || !('data' in callbackQuery)) {
        return;
      }

      const callbackData = callbackQuery.data;

      // Route to appropriate handler based on callback data prefix
      if (this.approvalCallbackHandler.canHandle(callbackData)) {
        await this.approvalCallbackHandler.handle(ctx);
      } else if (this.carouselCallbackHandler.canHandle(callbackData)) {
        await this.carouselCallbackHandler.handle(ctx);
      } else if (this.eventCallbackHandler.canHandle(callbackData)) {
        await this.eventCallbackHandler.handle(ctx);
      } else {
        this.logger.warn(`Unknown callback data: ${callbackData}`);
        await ctx.answerCbQuery('Unknown action');
      }
    });

    // Handle text messages (for edit mode)
    this.bot.on('text', async (ctx) => {
      const chatId = ctx.chat?.id;
      const text = ctx.message?.text;

      if (!chatId || !text) return;

      // Check if user is in approval edit mode
      if (this.approvalCallbackHandler.isInEditMode(chatId)) {
        const handled = await this.approvalCallbackHandler.handleTextMessage(ctx, text);
        if (handled) return;
      }

      // Not in any special mode - could add general message handling here
    });

    this.logger.log('Callback handlers registered');
  }

  private setupErrorHandling(): void {
    if (!this.bot) return;

    this.bot.catch((err: unknown, ctx: Context) => {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Bot error for ${ctx.updateType}:`, message);
    });
  }

  /**
   * Send notification to a specific chat
   */
  async sendNotification(options: SendNotificationOptions): Promise<boolean> {
    if (!this.bot) {
      this.logger.warn('Cannot send notification: bot not initialized');
      return false;
    }

    try {
      const replyMarkup: InlineKeyboardMarkup | undefined = options.buttons
        ? {
            inline_keyboard: options.buttons.map((row) =>
              row.map((btn) => ({
                text: btn.text,
                callback_data: btn.callback_data,
              })),
            ),
          }
        : undefined;

      await this.bot.telegram.sendMessage(options.chatId, options.message, {
        parse_mode: options.parseMode || 'Markdown',
        reply_markup: replyMarkup,
      });

      this.logger.log(`Notification sent to chat ${options.chatId}`);
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to send notification to ${options.chatId}: ${errorMsg}`);
      return false;
    }
  }

  /**
   * Send notification to the owner (primary user)
   */
  async sendNotificationToOwner(
    message: string,
    options?: {
      parseMode?: 'Markdown' | 'HTML';
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    },
  ): Promise<boolean> {
    if (!this.ownerChatId) {
      this.logger.warn('Cannot send notification: owner chat ID not configured');
      return false;
    }

    return this.sendNotification({
      chatId: this.ownerChatId,
      message,
      parseMode: options?.parseMode,
      buttons: options?.buttons,
    });
  }

  /**
   * Get owner chat ID
   */
  getOwnerChatId(): number | null {
    return this.ownerChatId;
  }

  /**
   * Check if bot is ready for notifications
   */
  isReady(): boolean {
    return this.bot !== null && this.ownerChatId !== null;
  }

  /**
   * Send notification and return message ID (for carousel).
   */
  async sendNotificationWithId(
    options: SendNotificationOptions,
  ): Promise<{ success: boolean; messageId?: number }> {
    if (!this.bot) {
      this.logger.warn('Cannot send notification: bot not initialized');
      return { success: false };
    }

    try {
      const replyMarkup: InlineKeyboardMarkup | undefined = options.buttons
        ? {
            inline_keyboard: options.buttons.map((row) =>
              row.map((btn) => ({
                text: btn.text,
                callback_data: btn.callback_data,
              })),
            ),
          }
        : undefined;

      const result = await this.bot.telegram.sendMessage(options.chatId, options.message, {
        parse_mode: options.parseMode || 'Markdown',
        reply_markup: replyMarkup,
      });

      this.logger.log(`Notification sent to chat ${options.chatId}, messageId: ${result.message_id}`);
      return { success: true, messageId: result.message_id };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to send notification to ${options.chatId}: ${errorMsg}`);
      return { success: false };
    }
  }

  /**
   * Edit an existing message (for carousel navigation).
   */
  async editMessage(
    chatId: number | string,
    messageId: number,
    message: string,
    options?: {
      parseMode?: 'Markdown' | 'HTML';
      buttons?: Array<Array<{ text: string; callback_data: string }>>;
    },
  ): Promise<boolean> {
    if (!this.bot) {
      this.logger.warn('Cannot edit message: bot not initialized');
      return false;
    }

    try {
      const replyMarkup: InlineKeyboardMarkup | undefined = options?.buttons
        ? {
            inline_keyboard: options.buttons.map((row) =>
              row.map((btn) => ({
                text: btn.text,
                callback_data: btn.callback_data,
              })),
            ),
          }
        : undefined;

      await this.bot.telegram.editMessageText(chatId, messageId, undefined, message, {
        parse_mode: options?.parseMode || 'HTML',
        reply_markup: replyMarkup,
      });

      this.logger.debug(`Message ${messageId} edited in chat ${chatId}`);
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to edit message ${messageId}: ${errorMsg}`);
      return false;
    }
  }
}
