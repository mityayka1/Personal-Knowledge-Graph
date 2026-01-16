import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf, Context } from 'telegraf';
import { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';
import { RecallHandler } from './handlers/recall.handler';
import { PrepareHandler } from './handlers/prepare.handler';
import { EventCallbackHandler } from './handlers/event-callback.handler';

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
    private readonly eventCallbackHandler: EventCallbackHandler,
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

  private setupCommands(): void {
    if (!this.bot) return;

    // /start command
    this.bot.start(async (ctx) => {
      await ctx.reply(
        '🧠 *Second Brain Bot*\n\n' +
          'Доступные команды:\n' +
          '`/recall <запрос>` — поиск по переписке\n' +
          '`/prepare <имя>` — подготовка к встрече\n\n' +
          '*Примеры:*\n' +
          '`/recall кто советовал юриста?`\n' +
          '`/prepare Иван Петров`',
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
          'Пример: `/prepare Мария Иванова`',
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

    this.logger.log('Bot commands registered: /start, /help, /recall, /prepare');
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
      if (this.eventCallbackHandler.canHandle(callbackData)) {
        await this.eventCallbackHandler.handle(ctx);
      } else {
        this.logger.warn(`Unknown callback data: ${callbackData}`);
        await ctx.answerCbQuery('Unknown action');
      }
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
}
