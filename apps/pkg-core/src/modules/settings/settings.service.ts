import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Setting } from '@pkg/entities';
import { DEFAULT_SESSION_GAP_MINUTES } from '@pkg/shared';

// Default settings with their values and descriptions
const DEFAULT_SETTINGS: Array<{
  key: string;
  value: unknown;
  description: string;
  category: string;
}> = [
  // Extraction settings
  {
    key: 'extraction.autoSaveThreshold',
    value: 0.95,
    description: 'Порог уверенности для автоматического сохранения извлечённых фактов (0.0-1.0)',
    category: 'extraction',
  },
  {
    key: 'extraction.minConfidence',
    value: 0.6,
    description: 'Минимальная уверенность для отображения извлечённых фактов (0.0-1.0)',
    category: 'extraction',
  },
  {
    key: 'extraction.model',
    value: 'haiku',
    description: 'Модель Claude для извлечения фактов (haiku, sonnet, opus)',
    category: 'extraction',
  },
  {
    key: 'extraction.dailySynthesisModel',
    value: 'sonnet',
    description: 'Модель Claude для daily synthesis extraction (haiku, sonnet, opus). Sonnet рекомендуется для сложных JSON схем.',
    category: 'extraction',
  },
  {
    key: 'extraction.minMessageLength',
    value: 20,
    description: 'Минимальная длина сообщения для извлечения событий (символов)',
    category: 'extraction',
  },
  {
    key: 'extraction.maxQuoteLength',
    value: 500,
    description: 'Максимальная длина цитаты из источника (символов)',
    category: 'extraction',
  },
  {
    key: 'extraction.maxContentLength',
    value: 1000,
    description: 'Максимальная длина контента для LLM обработки (символов)',
    category: 'extraction',
  },
  // Session settings
  {
    key: 'session.gapThresholdMinutes',
    value: DEFAULT_SESSION_GAP_MINUTES,
    description: 'Порог разделения сессий в минутах. Если между сообщениями прошло больше этого времени, создаётся новая сессия.',
    category: 'session',
  },
  // Conversation-based extraction settings
  {
    key: 'extraction.conversationGapMinutes',
    value: 30,
    description: 'Порог разделения бесед в минутах для extraction (сообщения с gap больше этого значения попадают в разные беседы)',
    category: 'extraction',
  },
  {
    key: 'extraction.crossChatContextMinutes',
    value: 120,
    description: 'Окно в минутах для поиска кросс-чат контекста (сообщения из других чатов с теми же участниками)',
    category: 'extraction',
  },
  // Inference settings (relation inference from facts)
  {
    key: 'inference.similarityThreshold',
    value: 0.7,
    description: 'Минимальный порог схожести для matching организаций (0.0-1.0). Выше = строже.',
    category: 'inference',
  },
  {
    key: 'inference.defaultLimit',
    value: 1000,
    description: 'Максимальное количество фактов для обработки за один запуск inference',
    category: 'inference',
  },
  // Deduplication settings (LLM-agent review for gray-zone facts)
  {
    key: 'dedup.reviewThreshold',
    value: 0.40,
    description: 'Нижний порог семантической схожести для серой зоны (0.0-1.0). Факты с similarity между этим порогом и 0.70 отправляются на LLM-ревью.',
    category: 'dedup',
  },
  {
    key: 'dedup.reviewModel',
    value: 'haiku',
    description: 'Модель Claude для LLM-ревью дубликатов фактов (haiku, sonnet, opus)',
    category: 'dedup',
  },
  // Notification settings
  {
    key: 'notification.highConfidenceThreshold',
    value: 0.9,
    description: 'Порог уверенности для высокоприоритетных уведомлений (0.0-1.0)',
    category: 'notification',
  },
  {
    key: 'notification.urgentMeetingHoursWindow',
    value: 24,
    description: 'Часов до встречи для определения высокого приоритета уведомления',
    category: 'notification',
  },
  {
    key: 'notification.expirationDays',
    value: 7,
    description: 'Дней до истечения неподтверждённых извлечённых событий',
    category: 'notification',
  },
];

@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);

  // Cache for frequently accessed settings (queried on every message)
  private sessionGapCache: { value: number; expiresAt: number } | null = null;
  private conversationGapCache: { value: number; expiresAt: number } | null = null;
  private crossChatContextCache: { value: number; expiresAt: number } | null = null;
  private readonly CACHE_TTL_MS = 60_000; // 1 minute

  // Default values for conversation-based extraction
  private readonly DEFAULT_CONVERSATION_GAP_MINUTES = 30;
  private readonly DEFAULT_CROSS_CHAT_CONTEXT_MINUTES = 120;

  constructor(
    @InjectRepository(Setting)
    private settingRepo: Repository<Setting>,
  ) {}

  async onModuleInit() {
    // Initialize default settings if they don't exist
    for (const setting of DEFAULT_SETTINGS) {
      const existing = await this.settingRepo.findOne({ where: { key: setting.key } });
      if (!existing) {
        await this.settingRepo.save(setting);
        this.logger.log(`Created default setting: ${setting.key}`);
      }
    }
  }

  async findAll(): Promise<Setting[]> {
    return this.settingRepo.find({ order: { category: 'ASC', key: 'ASC' } });
  }

  async findByCategory(category: string): Promise<Setting[]> {
    return this.settingRepo.find({ where: { category }, order: { key: 'ASC' } });
  }

  async findOne(key: string): Promise<Setting | null> {
    return this.settingRepo.findOne({ where: { key } });
  }

  async getValue<T = unknown>(key: string): Promise<T | null> {
    const setting = await this.findOne(key);
    return setting ? (setting.value as T) : null;
  }

  async update(key: string, value: unknown, description?: string): Promise<Setting> {
    // Validate and handle session.gapThresholdMinutes
    if (key === 'session.gapThresholdMinutes') {
      const numValue = Number(value);
      if (isNaN(numValue) || numValue < 15 || numValue > 1440) {
        throw new Error('Session gap must be between 15 and 1440 minutes');
      }
      this.sessionGapCache = null;
      this.logger.log(`Session gap threshold changed to ${numValue} minutes`);
    }

    let setting = await this.settingRepo.findOne({ where: { key } });

    if (!setting) {
      setting = this.settingRepo.create({
        key,
        value,
        description,
        category: key.split('.')[0] || 'general',
      });
    } else {
      setting.value = value;
      if (description !== undefined) {
        setting.description = description;
      }
    }

    return this.settingRepo.save(setting);
  }

  async delete(key: string): Promise<void> {
    await this.settingRepo.delete({ key });
  }

  // Helper to get extraction settings
  async getExtractionSettings(): Promise<{
    autoSaveThreshold: number;
    minConfidence: number;
    model: string;
    dailySynthesisModel: string;
    minMessageLength: number;
    maxQuoteLength: number;
    maxContentLength: number;
  }> {
    const [
      autoSaveThreshold,
      minConfidence,
      model,
      dailySynthesisModel,
      minMessageLength,
      maxQuoteLength,
      maxContentLength,
    ] = await Promise.all([
      this.getValue<number>('extraction.autoSaveThreshold'),
      this.getValue<number>('extraction.minConfidence'),
      this.getValue<string>('extraction.model'),
      this.getValue<string>('extraction.dailySynthesisModel'),
      this.getValue<number>('extraction.minMessageLength'),
      this.getValue<number>('extraction.maxQuoteLength'),
      this.getValue<number>('extraction.maxContentLength'),
    ]);

    return {
      autoSaveThreshold: autoSaveThreshold ?? 0.95,
      minConfidence: minConfidence ?? 0.6,
      model: model ?? 'haiku',
      dailySynthesisModel: dailySynthesisModel ?? 'sonnet',
      minMessageLength: minMessageLength ?? 20,
      maxQuoteLength: maxQuoteLength ?? 500,
      maxContentLength: maxContentLength ?? 1000,
    };
  }

  /**
   * Get daily synthesis extraction model.
   * Separate from regular extraction model because daily synthesis uses complex JSON schema.
   */
  async getDailySynthesisModel(): Promise<'haiku' | 'sonnet' | 'opus'> {
    const model = await this.getValue<string>('extraction.dailySynthesisModel');
    return (model ?? 'sonnet') as 'haiku' | 'sonnet' | 'opus';
  }

  // Helper to get notification settings
  async getNotificationSettings(): Promise<{
    highConfidenceThreshold: number;
    urgentMeetingHoursWindow: number;
    expirationDays: number;
  }> {
    const [highConfidenceThreshold, urgentMeetingHoursWindow, expirationDays] = await Promise.all([
      this.getValue<number>('notification.highConfidenceThreshold'),
      this.getValue<number>('notification.urgentMeetingHoursWindow'),
      this.getValue<number>('notification.expirationDays'),
    ]);

    return {
      highConfidenceThreshold: highConfidenceThreshold ?? 0.9,
      urgentMeetingHoursWindow: urgentMeetingHoursWindow ?? 24,
      expirationDays: expirationDays ?? 7,
    };
  }

  // Helper to get inference settings (relation inference from facts)
  async getInferenceSettings(): Promise<{
    similarityThreshold: number;
    defaultLimit: number;
  }> {
    const [similarityThreshold, defaultLimit] = await Promise.all([
      this.getValue<number>('inference.similarityThreshold'),
      this.getValue<number>('inference.defaultLimit'),
    ]);

    return {
      similarityThreshold: similarityThreshold ?? 0.7,
      defaultLimit: defaultLimit ?? 1000,
    };
  }

  /**
   * Get deduplication settings (LLM-agent review for gray-zone facts).
   */
  async getDedupSettings(): Promise<{
    reviewThreshold: number;
    reviewModel: 'haiku' | 'sonnet' | 'opus';
  }> {
    const [reviewThreshold, reviewModel] = await Promise.all([
      this.getValue<number>('dedup.reviewThreshold'),
      this.getValue<string>('dedup.reviewModel'),
    ]);

    return {
      reviewThreshold: reviewThreshold ?? 0.40,
      reviewModel: (reviewModel ?? 'haiku') as 'haiku' | 'sonnet' | 'opus',
    };
  }

  /**
   * Get session gap threshold in milliseconds.
   * Cached for 1 minute to avoid DB query on every message.
   */
  async getSessionGapMs(): Promise<number> {
    const now = Date.now();

    if (this.sessionGapCache && this.sessionGapCache.expiresAt > now) {
      return this.sessionGapCache.value;
    }

    const minutes = await this.getValue<number>('session.gapThresholdMinutes');
    const value = (minutes ?? DEFAULT_SESSION_GAP_MINUTES) * 60 * 1000;

    this.sessionGapCache = { value, expiresAt: now + this.CACHE_TTL_MS };
    return value;
  }

  /**
   * Get conversation gap threshold in milliseconds for grouping messages into conversations.
   * Cached for 1 minute to avoid DB query on every message.
   */
  async getConversationGapMs(): Promise<number> {
    const now = Date.now();

    if (this.conversationGapCache && this.conversationGapCache.expiresAt > now) {
      return this.conversationGapCache.value;
    }

    const minutes = await this.getValue<number>('extraction.conversationGapMinutes');
    const value = (minutes ?? this.DEFAULT_CONVERSATION_GAP_MINUTES) * 60 * 1000;

    this.conversationGapCache = { value, expiresAt: now + this.CACHE_TTL_MS };
    return value;
  }

  /**
   * Get cross-chat context window in milliseconds.
   * Used to find related messages from other chats with same participants.
   * Cached for 1 minute.
   */
  async getCrossChatContextMs(): Promise<number> {
    const now = Date.now();

    if (this.crossChatContextCache && this.crossChatContextCache.expiresAt > now) {
      return this.crossChatContextCache.value;
    }

    const minutes = await this.getValue<number>('extraction.crossChatContextMinutes');
    const value = (minutes ?? this.DEFAULT_CROSS_CHAT_CONTEXT_MINUTES) * 60 * 1000;

    this.crossChatContextCache = { value, expiresAt: now + this.CACHE_TTL_MS };
    return value;
  }
}
