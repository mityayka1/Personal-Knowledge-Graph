import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf, Context } from 'telegraf';
import { RecallHandler } from './handlers/recall.handler';
import { PrepareHandler } from './handlers/prepare.handler';

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  private bot: Telegraf | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly recallHandler: RecallHandler,
    private readonly prepareHandler: PrepareHandler,
  ) {}

  async onModuleInit(): Promise<void> {
    const botToken = this.configService.get<string>('telegram.botToken');

    if (!botToken) {
      this.logger.warn('TELEGRAM_BOT_TOKEN not configured. Bot commands disabled.');
      return;
    }

    this.bot = new Telegraf(botToken);

    // Register commands with Telegram for hints
    await this.bot.telegram.setMyCommands([
      { command: 'start', description: 'Начать работу с ботом' },
      { command: 'help', description: 'Показать справку по командам' },
      { command: 'recall', description: 'Поиск по переписке' },
      { command: 'prepare', description: 'Подготовка к встрече' },
    ]);
    this.logger.log('Bot commands registered with Telegram');

    this.setupCommands();
    this.setupErrorHandling();

    // Launch bot in polling mode
    await this.bot.launch();
    this.logger.log('Telegraf bot started successfully');
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

  private setupErrorHandling(): void {
    if (!this.bot) return;

    this.bot.catch((err: unknown, ctx: Context) => {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Bot error for ${ctx.updateType}:`, message);
    });
  }
}
