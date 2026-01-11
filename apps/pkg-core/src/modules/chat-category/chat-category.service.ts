import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { ChatCategoryRecord, ChatCategory } from '@pkg/entities';
import { SettingsService } from '../settings/settings.service';

interface TelegramChatInfo {
  telegramChatId: string;
  title: string | null;
  participantsCount: number | null;
  chatType: 'private' | 'group' | 'supergroup' | 'channel' | 'forum';
  username?: string;
  description?: string;
  photoBase64?: string;
  isForum?: boolean;
}

export interface BackfillResult {
  total: number;
  updated: number;
  failed: number;
  errors: Array<{ chatId: string; error: string }>;
}

export interface CategorizeResult {
  category: ChatCategory;
  autoExtractionEnabled: boolean;
  isNew: boolean;
}

@Injectable()
export class ChatCategoryService {
  private readonly logger = new Logger(ChatCategoryService.name);
  private readonly telegramAdapterUrl: string;

  constructor(
    @InjectRepository(ChatCategoryRecord)
    private chatCategoryRepo: Repository<ChatCategoryRecord>,
    private settingsService: SettingsService,
    private httpService: HttpService,
    private configService: ConfigService,
  ) {
    this.telegramAdapterUrl = this.configService.get<string>('TELEGRAM_ADAPTER_URL') || 'http://localhost:3001';
  }

  /**
   * Get or create chat category based on chat type and participants count
   */
  async categorize(params: {
    telegramChatId: string;
    chatType: string;
    participantsCount?: number | null;
    title?: string | null;
  }): Promise<CategorizeResult> {
    const { telegramChatId, chatType, participantsCount, title } = params;

    // Check if category already exists
    const existing = await this.chatCategoryRepo.findOne({
      where: { telegramChatId },
    });

    if (existing) {
      // Update participants count and title if provided
      let needsUpdate = false;
      if (participantsCount !== undefined && participantsCount !== null) {
        existing.participantsCount = participantsCount;
        needsUpdate = true;
      }
      if (title && !existing.title) {
        existing.title = title;
        needsUpdate = true;
      }
      if (needsUpdate) {
        await this.chatCategoryRepo.save(existing);
      }
      return {
        category: existing.category,
        autoExtractionEnabled: existing.autoExtractionEnabled,
        isNew: false,
      };
    }

    // Determine category
    const category = await this.determineCategory(chatType, participantsCount);

    // Create new record
    const record = this.chatCategoryRepo.create({
      telegramChatId,
      category,
      participantsCount,
      title,
    });
    await this.chatCategoryRepo.save(record);

    this.logger.log(`Created category for chat ${telegramChatId}: ${category}`);

    return {
      category,
      autoExtractionEnabled: record.autoExtractionEnabled,
      isNew: true,
    };
  }

  /**
   * Determine category based on chat type and participants count
   */
  async determineCategory(
    chatType: string,
    participantsCount?: number | null,
  ): Promise<ChatCategory> {
    // Private chats are always PERSONAL
    if (chatType === 'private') {
      return ChatCategory.PERSONAL;
    }

    // Groups/supergroups depend on participant count
    if (chatType === 'group' || chatType === 'supergroup' || chatType === 'forum') {
      if (participantsCount === null || participantsCount === undefined) {
        // Unknown count - default to MASS for safety
        return ChatCategory.MASS;
      }

      const threshold = await this.getWorkingGroupThreshold();
      return participantsCount <= threshold ? ChatCategory.WORKING : ChatCategory.MASS;
    }

    // Channels are MASS by default
    return ChatCategory.MASS;
  }

  /**
   * Get working group threshold from settings
   */
  async getWorkingGroupThreshold(): Promise<number> {
    const value = await this.settingsService.getValue<number>('categorization.workingGroupThreshold');
    return value ?? 20;
  }

  /**
   * Update participants count and recategorize if needed.
   * NOTE: Will NOT recategorize if isManualOverride is true.
   */
  async updateParticipantsCount(
    telegramChatId: string,
    participantsCount: number,
  ): Promise<CategorizeResult | null> {
    const existing = await this.chatCategoryRepo.findOne({
      where: { telegramChatId },
    });

    if (!existing) {
      return null;
    }

    // Update count
    existing.participantsCount = participantsCount;

    // Check if category should change (only for non-personal chats and non-manual overrides)
    // IMPORTANT: Skip recategorization if user manually set the category
    if (existing.category !== ChatCategory.PERSONAL && !existing.isManualOverride) {
      const threshold = await this.getWorkingGroupThreshold();
      const newCategory = participantsCount <= threshold
        ? ChatCategory.WORKING
        : ChatCategory.MASS;

      if (newCategory !== existing.category) {
        this.logger.log(
          `Category change for ${telegramChatId}: ${existing.category} -> ${newCategory}`,
        );
        existing.category = newCategory;
      }
    } else if (existing.isManualOverride) {
      this.logger.debug(
        `Skipping auto-recategorization for ${telegramChatId} - manual override is set`,
      );
    }

    await this.chatCategoryRepo.save(existing);

    return {
      category: existing.category,
      autoExtractionEnabled: existing.autoExtractionEnabled,
      isNew: false,
    };
  }

  /**
   * Get category for a chat
   */
  async getCategory(telegramChatId: string): Promise<ChatCategoryRecord | null> {
    return this.chatCategoryRepo.findOne({
      where: { telegramChatId },
    });
  }

  /**
   * Manually update category for a chat.
   * Sets isManualOverride = true to prevent automatic recategorization.
   * Used to override automatic categorization (e.g., mark small group as PERSONAL instead of WORKING)
   */
  async updateCategory(
    telegramChatId: string,
    category: ChatCategory,
  ): Promise<ChatCategoryRecord> {
    let record = await this.chatCategoryRepo.findOne({
      where: { telegramChatId },
    });

    if (!record) {
      // Create new record with manual category
      record = this.chatCategoryRepo.create({
        telegramChatId,
        category,
        isManualOverride: true, // Mark as manually set
      });
    } else {
      // Update existing record
      const oldCategory = record.category;
      record.category = category;
      record.isManualOverride = true; // Protect from auto-recategorization
      this.logger.log(
        `Manual category change for ${telegramChatId}: ${oldCategory} -> ${category} (manual override set)`,
      );
    }

    return this.chatCategoryRepo.save(record);
  }

  /**
   * Reset manual override and allow automatic categorization again
   */
  async resetManualOverride(telegramChatId: string): Promise<ChatCategoryRecord | null> {
    const record = await this.chatCategoryRepo.findOne({
      where: { telegramChatId },
    });

    if (!record) {
      return null;
    }

    record.isManualOverride = false;
    this.logger.log(`Manual override reset for ${telegramChatId}`);

    return this.chatCategoryRepo.save(record);
  }

  /**
   * Check if auto extraction is enabled for a chat
   */
  async isAutoExtractionEnabled(telegramChatId: string): Promise<boolean> {
    const record = await this.getCategory(telegramChatId);
    return record?.autoExtractionEnabled ?? false;
  }

  /**
   * List group/channel categories with pagination (excludes personal dialogs)
   */
  async findAll(params: {
    category?: ChatCategory;
    limit?: number;
    offset?: number;
    includePersonalDialogs?: boolean;
  }) {
    const { category, limit = 50, offset = 0, includePersonalDialogs = false } = params;

    const query = this.chatCategoryRepo.createQueryBuilder('cc');

    // Exclude personal dialogs (user_XXX) unless explicitly requested
    if (!includePersonalDialogs) {
      query.where("cc.telegramChatId NOT LIKE 'user_%'");
    }

    if (category) {
      query.andWhere('cc.category = :category', { category });
    }

    const [items, total] = await query
      .orderBy('cc.createdAt', 'DESC')
      .limit(limit)
      .offset(offset)
      .getManyAndCount();

    return { items, total, limit, offset };
  }

  /**
   * Get statistics for group/channel categories (excludes personal dialogs)
   */
  async getStats() {
    const stats = await this.chatCategoryRepo
      .createQueryBuilder('cc')
      .select('cc.category', 'category')
      .addSelect('COUNT(*)', 'count')
      .where("cc.telegramChatId NOT LIKE 'user_%'")
      .groupBy('cc.category')
      .getRawMany();

    const total = stats.reduce((sum, s) => sum + parseInt(s.count, 10), 0);

    const byCategory: Record<string, number> = {};
    for (const s of stats) {
      byCategory[s.category] = parseInt(s.count, 10);
    }

    return {
      total,
      byCategory,
      personal: byCategory[ChatCategory.PERSONAL] ?? 0,
      working: byCategory[ChatCategory.WORKING] ?? 0,
      mass: byCategory[ChatCategory.MASS] ?? 0,
    };
  }

  /**
   * Get chat info from Telegram Adapter
   */
  async getChatInfoFromTelegram(telegramChatId: string): Promise<TelegramChatInfo | null> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<TelegramChatInfo>(
          `${this.telegramAdapterUrl}/api/v1/chats/${telegramChatId}/info`,
        ),
      );
      return response.data;
    } catch (error) {
      this.logger.warn(`Failed to get chat info for ${telegramChatId}: ${error}`);
      return null;
    }
  }

  /**
   * Update single chat with info from Telegram
   */
  async updateChatFromTelegram(telegramChatId: string): Promise<ChatCategoryRecord | null> {
    const info = await this.getChatInfoFromTelegram(telegramChatId);
    if (!info) {
      return null;
    }

    const record = await this.chatCategoryRepo.findOne({
      where: { telegramChatId },
    });

    if (!record) {
      return null;
    }

    let updated = false;

    if (info.title && info.title !== record.title) {
      record.title = info.title;
      updated = true;
    }

    if (info.participantsCount !== null && info.participantsCount !== record.participantsCount) {
      record.participantsCount = info.participantsCount;
      updated = true;
    }

    // Update isForum flag
    const isForum = info.isForum === true || info.chatType === 'forum';
    if (isForum !== record.isForum) {
      record.isForum = isForum;
      updated = true;
    }

    if (updated) {
      await this.chatCategoryRepo.save(record);
      this.logger.log(`Updated chat ${telegramChatId}: title="${info.title}", participants=${info.participantsCount}, isForum=${isForum}`);
    }

    return record;
  }

  /**
   * Backfill all chats without titles from Telegram
   */
  async backfillChatsFromTelegram(options?: {
    onlyMissingTitles?: boolean;
    limit?: number;
  }): Promise<BackfillResult> {
    const { onlyMissingTitles = true, limit } = options || {};

    const query = this.chatCategoryRepo.createQueryBuilder('cc');

    // Exclude personal dialogs
    query.where("cc.telegramChatId NOT LIKE 'user_%'");

    if (onlyMissingTitles) {
      query.andWhere('cc.title IS NULL');
    }

    if (limit) {
      query.limit(limit);
    }

    const chats = await query.getMany();

    const result: BackfillResult = {
      total: chats.length,
      updated: 0,
      failed: 0,
      errors: [],
    };

    this.logger.log(`Starting backfill for ${chats.length} chats...`);

    for (const chat of chats) {
      try {
        const info = await this.getChatInfoFromTelegram(chat.telegramChatId);

        if (!info) {
          result.failed++;
          result.errors.push({ chatId: chat.telegramChatId, error: 'No info returned' });
          continue;
        }

        let updated = false;

        if (info.title) {
          chat.title = info.title;
          updated = true;
        }

        if (info.participantsCount !== null) {
          chat.participantsCount = info.participantsCount;
          updated = true;
        }

        // Update isForum flag
        const isForum = info.isForum === true || info.chatType === 'forum';
        if (isForum !== chat.isForum) {
          chat.isForum = isForum;
          updated = true;
        }

        if (updated) {
          await this.chatCategoryRepo.save(chat);
          result.updated++;
          this.logger.debug(`Updated ${chat.telegramChatId}: ${info.title}, isForum=${chat.isForum}`);
        }

        // Small delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        result.failed++;
        result.errors.push({
          chatId: chat.telegramChatId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.log(`Backfill complete: ${result.updated} updated, ${result.failed} failed`);
    return result;
  }
}
