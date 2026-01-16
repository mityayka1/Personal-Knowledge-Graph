import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, In } from 'typeorm';
import {
  ExtractedEvent,
  ExtractedEventType,
  ExtractedEventStatus,
} from '@pkg/entities';
import { TelegramNotifierService } from './telegram-notifier.service';
import { SettingsService } from '../settings/settings.service';
import { DigestActionStoreService } from './digest-action-store.service';

type EventPriority = 'high' | 'medium' | 'low';

interface MeetingData {
  datetime?: string;
  dateText?: string;
  topic?: string;
  participants?: string[];
}

interface PromiseData {
  what: string;
  deadline?: string;
  deadlineText?: string;
}

interface FactData {
  factType: string;
  value: string;
  quote: string;
}

interface TaskData {
  what: string;
  deadline?: string;
}

interface CancellationData {
  what: string;
  reason?: string;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @InjectRepository(ExtractedEvent)
    private extractedEventRepo: Repository<ExtractedEvent>,
    private telegramNotifier: TelegramNotifierService,
    private settingsService: SettingsService,
    private digestActionStore: DigestActionStoreService,
  ) {}

  /**
   * Send notification for extracted event
   */
  async notifyAboutEvent(event: ExtractedEvent): Promise<boolean> {
    const message = this.formatEventNotification(event);
    const buttons = await this.getEventButtons(event);

    const success = await this.telegramNotifier.sendWithButtons(message, buttons);

    if (success) {
      // Mark as notified
      await this.extractedEventRepo.update(event.id, {
        notificationSentAt: new Date(),
      });
    }

    return success;
  }

  /**
   * Process pending events and send notifications based on priority.
   * High priority events are sent immediately.
   * Medium/low priority events are batched for digest.
   */
  async processHighPriorityEvents(): Promise<number> {
    const pending = await this.extractedEventRepo.find({
      where: {
        status: ExtractedEventStatus.PENDING,
        notificationSentAt: IsNull(),
      },
      order: { createdAt: 'ASC' },
      take: 10,
    });

    // Get settings once for batch processing
    const settings = await this.settingsService.getNotificationSettings();
    let notifiedCount = 0;

    for (const event of pending) {
      const priority = await this.calculatePriority(event, settings);

      if (priority === 'high') {
        const success = await this.notifyAboutEvent(event);
        if (success) {
          notifiedCount++;
        }
      }
      // Medium and low priority events will be handled by digest service
    }

    if (notifiedCount > 0) {
      this.logger.log(`Sent ${notifiedCount} high-priority notifications`);
    }

    return notifiedCount;
  }

  /**
   * Get pending events for digest by priority.
   * Loads all pending events to ensure correct priority filtering.
   */
  async getPendingEventsForDigest(
    priority: EventPriority,
    limit = 20,
  ): Promise<ExtractedEvent[]> {
    // Load all pending events without notification (up to reasonable max)
    // This ensures we find events of requested priority even if
    // there are many lower-priority events created earlier
    const all = await this.extractedEventRepo.find({
      where: {
        status: ExtractedEventStatus.PENDING,
        notificationSentAt: IsNull(),
      },
      order: { createdAt: 'ASC' },
      take: 200, // Reasonable max to scan
    });

    // Get settings once for batch filtering
    const settings = await this.settingsService.getNotificationSettings();

    // Filter by priority (async)
    const filtered: ExtractedEvent[] = [];
    for (const event of all) {
      if (filtered.length >= limit) break;
      const eventPriority = await this.calculatePriority(event, settings);
      if (eventPriority === priority) {
        filtered.push(event);
      }
    }

    return filtered;
  }

  /**
   * Mark events as notified (after sending digest)
   */
  async markEventsAsNotified(eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return;

    await this.extractedEventRepo.update(eventIds, {
      notificationSentAt: new Date(),
    });
  }

  /**
   * Expire old pending events that were never confirmed
   */
  async expireOldPendingEvents(olderThanDays = 7): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const result = await this.extractedEventRepo
      .createQueryBuilder()
      .update()
      .set({ status: ExtractedEventStatus.EXPIRED })
      .where('status = :status', { status: ExtractedEventStatus.PENDING })
      .andWhere('createdAt < :cutoff', { cutoff: cutoffDate })
      .execute();

    if (result.affected && result.affected > 0) {
      this.logger.log(`Expired ${result.affected} old pending events`);
    }

    return result.affected || 0;
  }

  /**
   * Send notification for a specific event by ID.
   * Called by notification processor.
   */
  async sendNotificationForEvent(eventId: string): Promise<void> {
    const event = await this.extractedEventRepo.findOne({
      where: { id: eventId },
    });

    if (!event) {
      this.logger.warn(`Event ${eventId} not found for notification`);
      return;
    }

    await this.notifyAboutEvent(event);
  }

  /**
   * Send digest notification for specific events.
   * Called by notification processor for queued digest jobs.
   */
  async sendDigestForEvents(
    eventIds: string[],
    digestType: 'hourly' | 'daily',
  ): Promise<void> {
    if (eventIds.length === 0) {
      this.logger.debug(`No events for ${digestType} digest`);
      return;
    }

    const events = await this.extractedEventRepo.find({
      where: { id: In(eventIds) },
      order: { createdAt: 'ASC' },
    });

    if (events.length === 0) {
      this.logger.warn(`No events found for digest: ${eventIds.join(', ')}`);
      return;
    }

    const message = this.formatDigestMessage(events, digestType);
    const buttons = await this.getDigestButtons(events);

    const success = await this.telegramNotifier.sendWithButtons(message, buttons);

    if (success) {
      await this.markEventsAsNotified(events.map((e) => e.id));
      this.logger.log(`${digestType} digest sent for ${events.length} events`);
    }
  }

  /**
   * Format digest message for multiple events.
   */
  private formatDigestMessage(
    events: ExtractedEvent[],
    digestType: 'hourly' | 'daily',
  ): string {
    const header =
      digestType === 'hourly' ? '<b>Новые события:</b>' : '<b>Дайджест за день</b>';
    const lines: string[] = [header, ''];

    events.forEach((event, index) => {
      const emoji = this.getEventEmoji(event.eventType);
      const summary = this.getEventSummary(event);
      lines.push(`${index + 1}. ${emoji} ${summary}`);
    });

    if (digestType === 'daily') {
      lines.push('');
      lines.push(`<i>Всего: ${events.length} событий</i>`);
    }

    return lines.join('\n');
  }

  /**
   * Get emoji for event type.
   */
  private getEventEmoji(type: ExtractedEventType): string {
    const emojis: Record<ExtractedEventType, string> = {
      [ExtractedEventType.MEETING]: '',
      [ExtractedEventType.PROMISE_BY_ME]: '',
      [ExtractedEventType.PROMISE_BY_THEM]: '',
      [ExtractedEventType.TASK]: '',
      [ExtractedEventType.FACT]: '',
      [ExtractedEventType.CANCELLATION]: '',
    };
    return emojis[type] || '';
  }

  /**
   * Get short summary for event.
   */
  private getEventSummary(event: ExtractedEvent): string {
    const data = event.extractedData as Record<string, unknown>;

    let text: string;
    if (data.topic) {
      text = String(data.topic);
    } else if (data.what) {
      text = String(data.what);
    } else if (data.value) {
      text = `${data.factType}: ${data.value}`;
    } else {
      text = 'Событие без описания';
    }

    return this.escapeHtml(text);
  }

  /**
   * Escape HTML special characters to prevent parse errors.
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Get buttons for digest notification.
   * Always uses Redis short ID for unified callback_data format.
   * Format: d_c:<shortId> (confirm), d_r:<shortId> (reject)
   */
  private async getDigestButtons(
    events: ExtractedEvent[],
  ): Promise<Array<Array<{ text: string; callback_data: string }>>> {
    const eventIds = events.map((e) => e.id);
    const shortId = await this.digestActionStore.store(eventIds);

    const confirmText = events.length === 1 ? 'Подтвердить' : 'Подтвердить все';
    const rejectText = events.length === 1 ? 'Игнорировать' : 'Игнорировать все';

    return [
      [
        { text: confirmText, callback_data: `d_c:${shortId}` },
        { text: rejectText, callback_data: `d_r:${shortId}` },
      ],
    ];
  }

  /**
   * Calculate event priority based on type and timing.
   * Uses settings for thresholds.
   */
  async calculatePriority(
    event: ExtractedEvent,
    settings?: { highConfidenceThreshold: number; urgentMeetingHoursWindow: number },
  ): Promise<EventPriority> {
    // Get settings if not provided
    const { highConfidenceThreshold, urgentMeetingHoursWindow } =
      settings ?? (await this.settingsService.getNotificationSettings());

    // High priority: cancellations, high confidence meetings within window
    if (event.eventType === ExtractedEventType.CANCELLATION) {
      return 'high';
    }

    if (event.confidence >= highConfidenceThreshold) {
      if (event.eventType === ExtractedEventType.MEETING) {
        const data = event.extractedData as MeetingData;
        if (data.datetime) {
          const meetingDate = new Date(data.datetime);
          const hoursUntil = (meetingDate.getTime() - Date.now()) / (1000 * 60 * 60);
          if (hoursUntil > 0 && hoursUntil < urgentMeetingHoursWindow) {
            return 'high';
          }
        }
      }
    }

    // Medium priority: tasks and promises with deadlines
    if (event.eventType === ExtractedEventType.TASK) {
      return 'medium';
    }

    if (
      event.eventType === ExtractedEventType.PROMISE_BY_ME ||
      event.eventType === ExtractedEventType.PROMISE_BY_THEM
    ) {
      const data = event.extractedData as PromiseData;
      if (data.deadline || data.deadlineText) {
        return 'medium';
      }
    }

    // Low priority: facts, promises without deadlines
    return 'low';
  }

  /**
   * Format event notification message
   */
  private formatEventNotification(event: ExtractedEvent): string {
    const esc = (text: string | undefined | null): string =>
      text ? this.escapeHtml(text) : '';

    switch (event.eventType) {
      case ExtractedEventType.MEETING: {
        const data = event.extractedData as MeetingData;
        return (
          `<b>Договорились о встрече:</b>\n` +
          `${esc(data.topic) || 'Созвон'}\n` +
          `${esc(data.dateText) || esc(data.datetime) || 'Дата не указана'}`
        );
      }

      case ExtractedEventType.PROMISE_BY_ME: {
        const data = event.extractedData as PromiseData;
        return (
          `<b>Ты обещал:</b>\n` +
          `${esc(data.what)}\n` +
          `${data.deadlineText ? esc(data.deadlineText) : ''}`
        );
      }

      case ExtractedEventType.PROMISE_BY_THEM: {
        const data = event.extractedData as PromiseData;
        return (
          `<b>Тебе обещали:</b>\n` +
          `${esc(data.what)}\n` +
          `${data.deadlineText ? esc(data.deadlineText) : ''}`
        );
      }

      case ExtractedEventType.TASK: {
        const data = event.extractedData as TaskData;
        return `<b>Тебя просят:</b>\n${esc(data.what)}`;
      }

      case ExtractedEventType.FACT: {
        const data = event.extractedData as FactData;
        return `<b>Новый факт:</b>\n${esc(data.factType)}: ${esc(data.value)}`;
      }

      case ExtractedEventType.CANCELLATION: {
        const data = event.extractedData as CancellationData;
        return `<b>Отмена/перенос:</b>\n${esc(data.what)}`;
      }

      default:
        return `<b>Событие:</b>\n${this.escapeHtml(JSON.stringify(event.extractedData))}`;
    }
  }

  /**
   * Get inline keyboard buttons for single event actions.
   * Uses unified callback_data format with Redis short ID.
   * Format: d_c:<shortId> (confirm), d_r:<shortId> (reject)
   */
  private async getEventButtons(
    event: ExtractedEvent,
  ): Promise<Array<Array<{ text: string; callback_data: string }>>> {
    const shortId = await this.digestActionStore.store([event.id]);

    return [
      [
        { text: 'Подтвердить', callback_data: `d_c:${shortId}` },
        { text: 'Игнорировать', callback_data: `d_r:${shortId}` },
      ],
    ];
  }
}
