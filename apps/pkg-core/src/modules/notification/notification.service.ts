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
    const buttons = this.getEventButtons(event);

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
   */
  async getPendingEventsForDigest(
    priority: EventPriority,
    limit = 20,
  ): Promise<ExtractedEvent[]> {
    const all = await this.extractedEventRepo.find({
      where: {
        status: ExtractedEventStatus.PENDING,
        notificationSentAt: IsNull(),
      },
      order: { createdAt: 'ASC' },
      take: limit * 3, // Get more to filter by priority
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
      digestType === 'hourly' ? '*Новые события:*' : '*Дайджест за день*';
    const lines: string[] = [header, ''];

    events.forEach((event, index) => {
      const emoji = this.getEventEmoji(event.eventType);
      const summary = this.getEventSummary(event);
      lines.push(`${index + 1}. ${emoji} ${summary}`);
    });

    if (digestType === 'daily') {
      lines.push('');
      lines.push(`_Всего: ${events.length} событий_`);
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

    if (data.topic) return String(data.topic);
    if (data.what) return String(data.what);
    if (data.value) return `${data.factType}: ${data.value}`;

    return 'Событие без описания';
  }

  /**
   * Get buttons for digest notification.
   * Single event: use UUID directly (fits in 64 bytes).
   * Multiple events: store IDs in Redis and use short ID.
   */
  private async getDigestButtons(
    events: ExtractedEvent[],
  ): Promise<Array<Array<{ text: string; callback_data: string }>>> {
    if (events.length === 1) {
      // Single event - UUID fits in callback_data (ev_c:UUID = ~41 chars)
      return [
        [
          { text: 'Подтвердить', callback_data: `ev_c:${events[0].id}` },
          { text: 'Игнорировать', callback_data: `ev_r:${events[0].id}` },
        ],
      ];
    }

    // Multiple events - store IDs in Redis and use short ID
    const eventIds = events.map((e) => e.id);
    const shortId = await this.digestActionStore.store(eventIds);

    // d_c:d_<12hex> = ~18 chars (well under 64 byte limit)
    return [
      [
        { text: 'Подтвердить все', callback_data: `d_c:${shortId}` },
        { text: 'Игнорировать все', callback_data: `d_r:${shortId}` },
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
    switch (event.eventType) {
      case ExtractedEventType.MEETING: {
        const data = event.extractedData as MeetingData;
        return (
          `*Договорились о встрече:*\n` +
          `${data.topic || 'Созвон'}\n` +
          `${data.dateText || data.datetime || 'Дата не указана'}`
        );
      }

      case ExtractedEventType.PROMISE_BY_ME: {
        const data = event.extractedData as PromiseData;
        return (
          `*Ты обещал:*\n` +
          `${data.what}\n` +
          `${data.deadlineText ? `${data.deadlineText}` : ''}`
        );
      }

      case ExtractedEventType.PROMISE_BY_THEM: {
        const data = event.extractedData as PromiseData;
        return (
          `*Тебе обещали:*\n` +
          `${data.what}\n` +
          `${data.deadlineText ? `${data.deadlineText}` : ''}`
        );
      }

      case ExtractedEventType.TASK: {
        const data = event.extractedData as TaskData;
        return `*Тебя просят:*\n${data.what}`;
      }

      case ExtractedEventType.FACT: {
        const data = event.extractedData as FactData;
        return `*Новый факт:*\n${data.factType}: ${data.value}`;
      }

      case ExtractedEventType.CANCELLATION: {
        const data = event.extractedData as CancellationData;
        return `*Отмена/перенос:*\n${data.what}`;
      }

      default:
        return `*Событие:*\n${JSON.stringify(event.extractedData)}`;
    }
  }

  /**
   * Get inline keyboard buttons for event actions
   */
  private getEventButtons(
    event: ExtractedEvent,
  ): Array<Array<{ text: string; callback_data: string }>> {
    const baseButtons = [
      { text: 'Подтвердить', callback_data: `event_confirm:${event.id}` },
      { text: 'Игнорировать', callback_data: `event_reject:${event.id}` },
    ];

    // Add type-specific buttons
    if (event.eventType === ExtractedEventType.MEETING) {
      return [
        baseButtons,
        [{ text: 'Изменить время', callback_data: `event_reschedule:${event.id}` }],
      ];
    }

    if (
      event.eventType === ExtractedEventType.PROMISE_BY_ME ||
      event.eventType === ExtractedEventType.TASK
    ) {
      return [
        baseButtons,
        [{ text: 'Напомнить позже', callback_data: `event_remind:${event.id}` }],
      ];
    }

    return [baseButtons];
  }
}
