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
    key: 'session.gapThresholdMinutes',
    value: DEFAULT_SESSION_GAP_MINUTES,
    description: 'Порог разделения сессий в минутах. Если между сообщениями прошло больше этого времени, создаётся новая сессия.',
    category: 'session',
  },
];

@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);

  // Cache for session gap threshold (queried on every message)
  private sessionGapCache: { value: number; expiresAt: number } | null = null;
  private readonly CACHE_TTL_MS = 60_000; // 1 minute

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
  }> {
    const [autoSaveThreshold, minConfidence, model] = await Promise.all([
      this.getValue<number>('extraction.autoSaveThreshold'),
      this.getValue<number>('extraction.minConfidence'),
      this.getValue<string>('extraction.model'),
    ]);

    return {
      autoSaveThreshold: autoSaveThreshold ?? 0.95,
      minConfidence: minConfidence ?? 0.6,
      model: model ?? 'haiku',
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
}
