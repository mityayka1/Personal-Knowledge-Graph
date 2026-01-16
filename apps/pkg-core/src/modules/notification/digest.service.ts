import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThan, IsNull, In } from 'typeorm';
import {
  ExtractedEvent,
  ExtractedEventStatus,
  ExtractedEventType,
  EntityEvent,
  EventType,
  EventStatus,
  EntityRecord,
} from '@pkg/entities';
import { TelegramNotifierService } from './telegram-notifier.service';
import { NotificationService } from './notification.service';
import { DigestActionStoreService } from './digest-action-store.service';

interface MorningBriefData {
  meetings: EntityEvent[];
  deadlines: EntityEvent[];
  birthdays: EntityRecord[];
  overdueCommitments: EntityEvent[];
  pendingFollowups: EntityEvent[];
}

@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  constructor(
    @InjectRepository(ExtractedEvent)
    private extractedEventRepo: Repository<ExtractedEvent>,
    @InjectRepository(EntityEvent)
    private entityEventRepo: Repository<EntityEvent>,
    @InjectRepository(EntityRecord)
    private entityRepo: Repository<EntityRecord>,
    private telegramNotifier: TelegramNotifierService,
    private notificationService: NotificationService,
    private digestActionStore: DigestActionStoreService,
  ) {}

  /**
   * Send morning brief with today's schedule and reminders
   */
  async sendMorningBrief(): Promise<void> {
    const today = new Date();
    const startOfDay = new Date(today);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(today);
    endOfDay.setHours(23, 59, 59, 999);

    try {
      const [meetings, deadlines, birthdays, overdueCommitments, pendingFollowups] =
        await Promise.all([
          this.getEventsByDateRange(startOfDay, endOfDay, EventType.MEETING),
          this.getEventsByDateRange(startOfDay, endOfDay, EventType.DEADLINE),
          this.getEntitiesWithBirthdayToday(),
          this.getOverdueEvents(EventType.COMMITMENT),
          this.getOverdueEvents(EventType.FOLLOW_UP),
        ]);

      const message = this.formatMorningBrief({
        meetings,
        deadlines,
        birthdays,
        overdueCommitments,
        pendingFollowups,
      });

      await this.telegramNotifier.send({ message, parseMode: 'HTML' });
      this.logger.log('Morning brief sent successfully');
    } catch (error) {
      this.logger.error('Failed to send morning brief:', error);
    }
  }

  /**
   * Send hourly digest with medium-priority pending events
   */
  async sendHourlyDigest(): Promise<void> {
    const events = await this.notificationService.getPendingEventsForDigest('medium', 10);

    if (events.length === 0) {
      this.logger.debug('No events for hourly digest');
      return;
    }

    const message = this.formatHourlyDigest(events);
    const buttons = await this.getDigestButtons(events);

    const success = await this.telegramNotifier.sendWithButtons(message, buttons);

    if (success) {
      await this.notificationService.markEventsAsNotified(events.map((e) => e.id));
      this.logger.log(`Hourly digest sent with ${events.length} events`);
    }
  }

  /**
   * Send daily digest with all remaining pending events
   */
  async sendDailyDigest(): Promise<void> {
    // Get both medium and low priority events
    const [mediumEvents, lowEvents] = await Promise.all([
      this.notificationService.getPendingEventsForDigest('medium', 10),
      this.notificationService.getPendingEventsForDigest('low', 20),
    ]);

    const allEvents = [...mediumEvents, ...lowEvents];

    if (allEvents.length === 0) {
      // Send a "nothing pending" message
      await this.telegramNotifier.send({
        message: '<b>Дайджест за день</b>\n\nНет новых событий для обработки.',
        parseMode: 'HTML',
      });
      return;
    }

    const message = this.formatDailyDigest(allEvents);
    const buttons = await this.getBatchDigestButtons(allEvents);

    const success = await this.telegramNotifier.sendWithButtons(message, buttons);

    if (success) {
      await this.notificationService.markEventsAsNotified(allEvents.map((e) => e.id));
      this.logger.log(`Daily digest sent with ${allEvents.length} events`);
    }
  }

  private async getEventsByDateRange(
    start: Date,
    end: Date,
    eventType: EventType,
  ): Promise<EntityEvent[]> {
    return this.entityEventRepo.find({
      where: {
        eventType,
        eventDate: Between(start, end),
        status: In([EventStatus.SCHEDULED]),
      },
      relations: ['entity'],
      order: { eventDate: 'ASC' },
    });
  }

  private async getEntitiesWithBirthdayToday(): Promise<EntityRecord[]> {
    // Get today's month and day
    const today = new Date();
    const month = today.getMonth() + 1;
    const day = today.getDate();

    // Query entities with birthday on this date
    // Note: This requires birthday to be stored as a fact
    // For now, return empty array - this would need EntityFactService integration
    return [];
  }

  private async getOverdueEvents(eventType: EventType): Promise<EntityEvent[]> {
    const now = new Date();

    return this.entityEventRepo.find({
      where: {
        eventType,
        eventDate: LessThan(now),
        status: EventStatus.SCHEDULED,
      },
      relations: ['entity'],
      order: { eventDate: 'ASC' },
      take: 10,
    });
  }

  private formatMorningBrief(data: MorningBriefData): string {
    const parts: string[] = ['<b>Доброе утро! Вот твой день:</b>'];

    if (data.meetings.length > 0) {
      parts.push('');
      parts.push('<b>Встречи:</b>');
      data.meetings.forEach((m) => {
        const time = m.eventDate
          ? m.eventDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
          : '??:??';
        const name = m.entity?.name || 'Без имени';
        parts.push(`• ${time} — ${m.title || 'Встреча'} (${name})`);
      });
    }

    if (data.deadlines.length > 0) {
      parts.push('');
      parts.push('<b>Дедлайны:</b>');
      data.deadlines.forEach((d) => {
        parts.push(`• ${d.title}`);
      });
    }

    if (data.birthdays.length > 0) {
      parts.push('');
      parts.push('<b>Дни рождения:</b>');
      data.birthdays.forEach((b) => {
        parts.push(`• ${b.name}`);
      });
    }

    if (data.overdueCommitments.length > 0) {
      parts.push('');
      parts.push('<b>Просроченные обещания:</b>');
      data.overdueCommitments.forEach((c) => {
        const daysOverdue = this.getDaysOverdue(c.eventDate);
        parts.push(`• ${c.title} (${daysOverdue} дн.)`);
      });
    }

    if (data.pendingFollowups.length > 0) {
      parts.push('');
      parts.push('<b>Ждёшь ответа:</b>');
      data.pendingFollowups.forEach((f) => {
        const name = f.entity?.name || 'Неизвестно';
        parts.push(`• ${f.title} от ${name}`);
      });
    }

    if (parts.length === 1) {
      return '<b>Доброе утро!</b>\n\nСегодня ничего запланированного. Хорошего дня!';
    }

    return parts.join('\n');
  }

  private formatHourlyDigest(events: ExtractedEvent[]): string {
    const lines: string[] = ['<b>Новые события:</b>', ''];

    events.forEach((event, index) => {
      lines.push(`${index + 1}. ${this.getEventEmoji(event.eventType)} ${this.getEventSummary(event)}`);
    });

    return lines.join('\n');
  }

  private formatDailyDigest(events: ExtractedEvent[]): string {
    const lines: string[] = ['<b>Дайджест за день</b>', ''];

    // Group by type
    const grouped = this.groupEventsByType(events);

    for (const [type, typeEvents] of Object.entries(grouped)) {
      if (typeEvents.length === 0) continue;

      lines.push(`<b>${this.getEventTypeLabel(type as ExtractedEventType)}:</b>`);
      typeEvents.forEach((event) => {
        lines.push(`• ${this.getEventSummary(event)}`);
      });
      lines.push('');
    }

    lines.push(`<i>Всего: ${events.length} событий</i>`);

    return lines.join('\n');
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
   * Get batch action buttons for daily digest (vertical layout).
   */
  private async getBatchDigestButtons(
    events: ExtractedEvent[],
  ): Promise<Array<Array<{ text: string; callback_data: string }>>> {
    const eventIds = events.map((e) => e.id);
    const shortId = await this.digestActionStore.store(eventIds);

    return [
      [{ text: 'Подтвердить все', callback_data: `d_c:${shortId}` }],
      [{ text: 'Игнорировать все', callback_data: `d_r:${shortId}` }],
    ];
  }

  private groupEventsByType(events: ExtractedEvent[]): Record<string, ExtractedEvent[]> {
    return events.reduce(
      (acc, event) => {
        const type = event.eventType;
        if (!acc[type]) acc[type] = [];
        acc[type].push(event);
        return acc;
      },
      {} as Record<string, ExtractedEvent[]>,
    );
  }

  private getEventEmoji(type: ExtractedEventType): string {
    switch (type) {
      case ExtractedEventType.MEETING:
        return '';
      case ExtractedEventType.PROMISE_BY_ME:
        return '';
      case ExtractedEventType.PROMISE_BY_THEM:
        return '';
      case ExtractedEventType.TASK:
        return '';
      case ExtractedEventType.FACT:
        return '';
      case ExtractedEventType.CANCELLATION:
        return '';
      default:
        return '';
    }
  }

  private getEventTypeLabel(type: ExtractedEventType): string {
    switch (type) {
      case ExtractedEventType.MEETING:
        return 'Встречи';
      case ExtractedEventType.PROMISE_BY_ME:
        return 'Ты обещал';
      case ExtractedEventType.PROMISE_BY_THEM:
        return 'Тебе обещали';
      case ExtractedEventType.TASK:
        return 'Задачи';
      case ExtractedEventType.FACT:
        return 'Новые факты';
      case ExtractedEventType.CANCELLATION:
        return 'Отмены';
      default:
        return 'Прочее';
    }
  }

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

  private getDaysOverdue(eventDate: Date | null): number {
    if (!eventDate) return 0;
    const now = new Date();
    const diffMs = now.getTime() - eventDate.getTime();
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
  }
}
