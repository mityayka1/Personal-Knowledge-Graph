import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChatCategoryRecord, ChatCategory } from '@pkg/entities';
import { SettingsService } from '../settings/settings.service';

export interface CategorizeResult {
  category: ChatCategory;
  autoExtractionEnabled: boolean;
  isNew: boolean;
}

@Injectable()
export class ChatCategoryService {
  private readonly logger = new Logger(ChatCategoryService.name);

  constructor(
    @InjectRepository(ChatCategoryRecord)
    private chatCategoryRepo: Repository<ChatCategoryRecord>,
    private settingsService: SettingsService,
  ) {}

  /**
   * Get or create chat category based on chat type and participants count
   */
  async categorize(params: {
    telegramChatId: string;
    chatType: string;
    participantsCount?: number | null;
  }): Promise<CategorizeResult> {
    const { telegramChatId, chatType, participantsCount } = params;

    // Check if category already exists
    const existing = await this.chatCategoryRepo.findOne({
      where: { telegramChatId },
    });

    if (existing) {
      // Update participants count if provided
      if (participantsCount !== undefined && participantsCount !== null) {
        await this.updateParticipantsCount(telegramChatId, participantsCount);
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
   * Update participants count and recategorize if needed
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

    // Check if category should change (only for non-personal chats)
    if (existing.category !== ChatCategory.PERSONAL) {
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
   * Check if auto extraction is enabled for a chat
   */
  async isAutoExtractionEnabled(telegramChatId: string): Promise<boolean> {
    const record = await this.getCategory(telegramChatId);
    return record?.autoExtractionEnabled ?? false;
  }

  /**
   * List all categories with pagination
   */
  async findAll(params: {
    category?: ChatCategory;
    limit?: number;
    offset?: number;
  }) {
    const { category, limit = 50, offset = 0 } = params;

    const query = this.chatCategoryRepo.createQueryBuilder('cc');

    if (category) {
      query.where('cc.category = :category', { category });
    }

    const [items, total] = await query
      .orderBy('cc.createdAt', 'DESC')
      .limit(limit)
      .offset(offset)
      .getManyAndCount();

    return { items, total, limit, offset };
  }

  /**
   * Get statistics for all categories
   */
  async getStats() {
    const stats = await this.chatCategoryRepo
      .createQueryBuilder('cc')
      .select('cc.category', 'category')
      .addSelect('COUNT(*)', 'count')
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
}
