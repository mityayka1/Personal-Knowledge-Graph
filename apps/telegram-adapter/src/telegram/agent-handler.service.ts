import { Injectable, Logger } from '@nestjs/common';
import { TelegramClient } from 'telegram';
import { Api } from 'telegram';
import {
  PkgCoreApiService,
  RecallResponse,
  PrepareResponse,
  PrepareResponseData,
} from '../api/pkg-core-api.service';

/**
 * Response from agent command processing
 */
export interface AgentCommandResult {
  /** Whether the command was handled */
  handled: boolean;
  /** Response message to send (if handled) */
  response?: string;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Patterns for natural language recall triggers
 */
const RECALL_PATTERNS = [
  /^(найди|вспомни|напомни|покажи)\s+/i,
  /^(кто|что|когда|где|зачем|почему|как)\s+/i,
  /^(о чём|о чем)\s+/i,
];

@Injectable()
export class AgentHandlerService {
  private readonly logger = new Logger(AgentHandlerService.name);

  constructor(private readonly pkgCoreApi: PkgCoreApiService) {}

  /**
   * Process incoming message and check if it's an agent command
   *
   * @param message Telegram message
   * @param client Telegram client (for sending responses)
   * @returns AgentCommandResult
   */
  async processCommand(
    message: Api.Message,
    client: TelegramClient,
  ): Promise<AgentCommandResult> {
    const text = message.message?.trim();
    if (!text) {
      return { handled: false };
    }

    // Check for /recall command
    if (text.startsWith('/recall')) {
      return this.handleRecall(text.replace('/recall', '').trim(), message, client);
    }

    // Check for /prepare command
    if (text.startsWith('/prepare')) {
      return this.handlePrepare(text.replace('/prepare', '').trim(), message, client);
    }

    // Check for natural language recall patterns (only for outgoing messages in private chats)
    if (message.out && this.isNaturalRecallQuery(text)) {
      return this.handleRecall(text, message, client);
    }

    return { handled: false };
  }

  /**
   * Check if text matches natural language recall patterns
   */
  private isNaturalRecallQuery(text: string): boolean {
    return RECALL_PATTERNS.some((pattern) => pattern.test(text));
  }

  /**
   * Handle /recall command
   */
  private async handleRecall(
    query: string,
    message: Api.Message,
    client: TelegramClient,
  ): Promise<AgentCommandResult> {
    if (!query || query.length < 3) {
      return {
        handled: true,
        response: this.formatUsage('recall'),
      };
    }

    this.logger.log(`Processing recall: "${query.slice(0, 100)}..."`);

    try {
      // Send "searching" indicator
      const chatId = this.extractChatId(message);
      if (chatId) {
        await this.sendTypingAction(client, chatId);
      }

      const response = await this.pkgCoreApi.recall(query);

      return {
        handled: true,
        response: this.formatRecallResponse(response),
      };
    } catch (error) {
      this.logger.error(`Recall failed: ${error}`);
      return {
        handled: true,
        error: 'Ошибка при поиске. Попробуйте переформулировать запрос.',
      };
    }
  }

  /**
   * Handle /prepare command
   */
  private async handlePrepare(
    entityNameOrId: string,
    message: Api.Message,
    client: TelegramClient,
  ): Promise<AgentCommandResult> {
    if (!entityNameOrId || entityNameOrId.length < 2) {
      return {
        handled: true,
        response: this.formatUsage('prepare'),
      };
    }

    this.logger.log(`Processing prepare for: "${entityNameOrId}"`);

    try {
      // Send "searching" indicator
      const chatId = this.extractChatId(message);
      if (chatId) {
        await this.sendTypingAction(client, chatId);
      }

      // Check if it's a UUID
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let entityId: string;

      if (uuidRegex.test(entityNameOrId)) {
        entityId = entityNameOrId;
      } else {
        // Search for entity by name
        const searchResult = await this.pkgCoreApi.searchEntities(entityNameOrId, 1);

        if (!searchResult.items || searchResult.items.length === 0) {
          return {
            handled: true,
            error: `Контакт "${entityNameOrId}" не найден. Попробуйте уточнить имя.`,
          };
        }

        entityId = searchResult.items[0].id;
        this.logger.log(`Found entity: ${searchResult.items[0].name} (${entityId})`);
      }

      const response = await this.pkgCoreApi.prepare(entityId);

      return {
        handled: true,
        response: this.formatPrepareResponse(response),
      };
    } catch (error) {
      this.logger.error(`Prepare failed: ${error}`);
      return {
        handled: true,
        error: 'Ошибка при подготовке брифа. Проверьте имя контакта.',
      };
    }
  }

  /**
   * Format recall response for Telegram
   */
  private formatRecallResponse(response: RecallResponse): string {
    if (!response.success || !response.data) {
      return 'Не удалось выполнить поиск.';
    }

    const { answer, sources } = response.data;

    let msg = `**Результат поиска:**\n\n${answer}`;

    if (sources && sources.length > 0) {
      msg += '\n\n**Источники:**';
      for (const source of sources.slice(0, 5)) {
        const preview = source.preview.length > 80
          ? source.preview.slice(0, 80) + '...'
          : source.preview;
        msg += `\n- ${preview}`;
      }
    }

    return msg;
  }

  /**
   * Format prepare response for Telegram
   */
  private formatPrepareResponse(response: PrepareResponse): string {
    if (!response.success || !response.data) {
      return 'Не удалось подготовить бриф.';
    }

    const data: PrepareResponseData = response.data;

    let msg = `**Бриф: ${data.entityName}**\n\n`;
    msg += data.brief;

    if (data.recentInteractions > 0) {
      msg += `\n\n**Взаимодействий:** ${data.recentInteractions}`;
    }

    if (data.openQuestions && data.openQuestions.length > 0) {
      msg += '\n\n**Открытые вопросы:**';
      for (const question of data.openQuestions) {
        msg += `\n- ${question}`;
      }
    }

    return msg;
  }

  /**
   * Format usage help message
   */
  private formatUsage(command: 'recall' | 'prepare'): string {
    if (command === 'recall') {
      return `**Использование:** /recall <запрос>

**Примеры:**
- /recall кто советовал юриста?
- /recall о чём договорились с Петром
- /recall когда последний раз общались с Иваном

Также можно использовать естественные запросы:
- найди рекомендации по ресторанам
- кто работает в Сбере?
- вспомни что обсуждали вчера`;
    }

    return `**Использование:** /prepare <имя контакта>

**Примеры:**
- /prepare Иван Петров
- /prepare Сергей
- /prepare Компания ABC`;
  }

  /**
   * Extract chat ID from message for sending typing action
   */
  private extractChatId(message: Api.Message): Api.TypePeer | null {
    return message.peerId || null;
  }

  /**
   * Send typing action to indicate processing
   */
  private async sendTypingAction(
    client: TelegramClient,
    peer: Api.TypePeer,
  ): Promise<void> {
    try {
      await client.invoke(
        new Api.messages.SetTyping({
          peer,
          action: new Api.SendMessageTypingAction(),
        }),
      );
    } catch (error) {
      // Ignore typing action errors
      this.logger.debug(`Failed to send typing action: ${error}`);
    }
  }
}
