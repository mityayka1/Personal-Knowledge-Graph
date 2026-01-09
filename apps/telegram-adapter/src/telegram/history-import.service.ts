import { Injectable, Logger } from '@nestjs/common';
import { Api } from 'telegram';
import { TelegramClient } from 'telegram';
import { Dialog } from 'telegram/tl/custom/dialog';
import { MessageHandlerService } from './message-handler.service';

export interface ImportProgress {
  status: 'idle' | 'running' | 'completed' | 'error';
  totalDialogs: number;
  processedDialogs: number;
  currentDialog?: string;
  totalMessages: number;
  processedMessages: number;
  errors: string[];
  startedAt?: Date;
  completedAt?: Date;
}

@Injectable()
export class HistoryImportService {
  private readonly logger = new Logger(HistoryImportService.name);
  private progress: ImportProgress = {
    status: 'idle',
    totalDialogs: 0,
    processedDialogs: 0,
    totalMessages: 0,
    processedMessages: 0,
    errors: [],
  };

  constructor(private messageHandler: MessageHandlerService) {}

  getProgress(): ImportProgress {
    return { ...this.progress };
  }

  async startImport(client: TelegramClient, limitPerDialog = 1000): Promise<void> {
    if (this.progress.status === 'running') {
      throw new Error('Import is already running');
    }

    this.progress = {
      status: 'running',
      totalDialogs: 0,
      processedDialogs: 0,
      totalMessages: 0,
      processedMessages: 0,
      errors: [],
      startedAt: new Date(),
    };

    try {
      this.logger.log('Starting Telegram history import...');

      // Get all dialogs (private chats only)
      const dialogs = await this.getPrivateDialogs(client);
      this.progress.totalDialogs = dialogs.length;

      this.logger.log(`Found ${dialogs.length} private dialogs to import`);

      for (const dialog of dialogs) {
        try {
          await this.importDialog(client, dialog, limitPerDialog);
          this.progress.processedDialogs++;
        } catch (error) {
          const dialogId = dialog.id?.toString() || 'unknown';
          const errorMsg = `Error importing dialog ${dialogId}: ${error instanceof Error ? error.message : String(error)}`;
          this.logger.error(errorMsg);
          this.progress.errors.push(errorMsg);
        }
      }

      this.progress.status = 'completed';
      this.progress.completedAt = new Date();
      this.logger.log(`Import completed. Processed ${this.progress.processedMessages} messages from ${this.progress.processedDialogs} dialogs`);
    } catch (error) {
      this.progress.status = 'error';
      this.progress.errors.push(
        `Fatal error: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.logger.error('Import failed', error);
      throw error;
    }
  }

  private async getPrivateDialogs(client: TelegramClient): Promise<Dialog[]> {
    const result: Dialog[] = [];

    // Fetch all dialogs
    const dialogs = await client.getDialogs({
      limit: 500,
    });

    for (const dialog of dialogs) {
      // Only include private chats (not groups, channels, or bots)
      const entity = dialog.entity;
      const isBot = entity && 'bot' in entity && entity.bot;
      if (dialog.isUser && !isBot) {
        result.push(dialog);
      }
    }

    return result;
  }

  private async importDialog(
    client: TelegramClient,
    dialog: Dialog,
    limitPerDialog: number,
  ): Promise<void> {
    const userId = dialog.id?.toString();

    if (!userId) {
      this.logger.warn('Could not extract user ID from dialog, skipping');
      return;
    }

    this.progress.currentDialog = userId;
    this.logger.log(`Importing messages from user ${userId}...`);

    let offsetId = 0;
    let messagesImported = 0;

    while (messagesImported < limitPerDialog) {
      const batchSize = Math.min(100, limitPerDialog - messagesImported);

      try {
        const messages = await client.getMessages(dialog.inputEntity, {
          limit: batchSize,
          offsetId,
        });

        if (!messages.length) {
          break;
        }

        for (const message of messages) {
          if (message instanceof Api.Message) {
            try {
              await this.messageHandler.processMessage(message, client);
              this.progress.totalMessages++;
              this.progress.processedMessages++;
            } catch (error) {
              this.logger.warn(
                `Failed to process message ${message.id}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        }

        messagesImported += messages.length;
        offsetId = messages[messages.length - 1].id;

        // Small delay to avoid rate limiting
        await this.delay(100);
      } catch (error) {
        this.logger.error(`Error fetching messages: ${error}`);
        break;
      }
    }

    this.logger.log(`Imported ${messagesImported} messages from user ${userId}`);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Re-import messages from a specific chat (supports groups/channels)
   * This will update sender_identifier for existing messages
   */
  async reimportChat(
    client: TelegramClient,
    chatId: string,
    limit = 1000,
  ): Promise<{ imported: number; updated: number; errors: string[] }> {
    const errors: string[] = [];
    let imported = 0;
    let updated = 0;

    this.logger.log(`Re-importing messages from chat ${chatId}...`);

    try {
      // Parse chat_id format: user_XXX, chat_XXX, channel_XXX
      const parts = chatId.split('_');
      const type = parts[0];
      const id = parts.slice(1).join('_');

      if (!type || !id) {
        throw new Error(`Invalid chat_id format: ${chatId}`);
      }

      // Find the entity from dialogs (works for all chat types)
      let inputEntity: Api.TypeInputPeer | undefined;

      const dialogs = await client.getDialogs({ limit: 500 });

      for (const dialog of dialogs) {
        const peer = dialog.inputEntity;
        if (type === 'user' && peer instanceof Api.InputPeerUser) {
          if (peer.userId.toString() === id) {
            inputEntity = peer;
            break;
          }
        } else if (type === 'chat' && peer instanceof Api.InputPeerChat) {
          if (peer.chatId.toString() === id) {
            inputEntity = peer;
            break;
          }
        } else if (type === 'channel' && peer instanceof Api.InputPeerChannel) {
          if (peer.channelId.toString() === id) {
            inputEntity = peer;
            break;
          }
        }
      }

      if (!inputEntity) {
        throw new Error(`Chat ${chatId} not found in dialogs`);
      }

      const entity = inputEntity;

      // Fetch messages
      let offsetId = 0;
      let messagesProcessed = 0;

      while (messagesProcessed < limit) {
        const batchSize = Math.min(100, limit - messagesProcessed);

        const messages = await client.getMessages(entity, {
          limit: batchSize,
          offsetId,
        });

        if (!messages.length) {
          break;
        }

        for (const message of messages) {
          if (message instanceof Api.Message) {
            try {
              await this.messageHandler.processMessage(message, client);
              imported++;
            } catch (error) {
              const errMsg = `Message ${message.id}: ${error instanceof Error ? error.message : String(error)}`;
              errors.push(errMsg);
            }
          }
        }

        messagesProcessed += messages.length;
        offsetId = messages[messages.length - 1].id;

        await this.delay(100);
      }

      this.logger.log(`Re-import completed: ${imported} messages processed`);
    } catch (error) {
      const errMsg = `Fatal error: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(errMsg);
      this.logger.error(errMsg);
    }

    return { imported, updated, errors };
  }
}
