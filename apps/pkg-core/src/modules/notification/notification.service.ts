import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import {
  ExtractedEvent,
  ExtractedEventType,
  ExtractedEventStatus,
} from '@pkg/entities';
import { TelegramNotifierService } from './telegram-notifier.service';

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
   * Process pending events and send notifications based on priority
   * High priority events are sent immediately
   * Medium/low priority events are batched for digest
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

    let notifiedCount = 0;

    for (const event of pending) {
      const priority = this.calculatePriority(event);

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
   * Get pending events for digest
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

    return all.filter((e) => this.calculatePriority(e) === priority).slice(0, limit);
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
   * Calculate event priority based on type and timing
   */
  calculatePriority(event: ExtractedEvent): EventPriority {
    // High priority: cancellations, high confidence meetings within 24h
    if (event.eventType === ExtractedEventType.CANCELLATION) {
      return 'high';
    }

    if (event.confidence > 0.9) {
      if (event.eventType === ExtractedEventType.MEETING) {
        const data = event.extractedData as MeetingData;
        if (data.datetime) {
          const meetingDate = new Date(data.datetime);
          const hoursUntil = (meetingDate.getTime() - Date.now()) / (1000 * 60 * 60);
          if (hoursUntil > 0 && hoursUntil < 24) {
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
