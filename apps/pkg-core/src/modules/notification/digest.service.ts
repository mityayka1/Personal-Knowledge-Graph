import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ExtractedEvent,
  ExtractedEventType,
  Commitment,
  CommitmentType,
  escapeHtml,
} from '@pkg/entities';
import { TelegramNotifierService } from './telegram-notifier.service';
import { NotificationService } from './notification.service';
import { DigestActionStoreService } from './digest-action-store.service';
import { CarouselStateService } from './carousel-state.service';
import { BriefStateService, BriefItem } from './brief-state.service';
import { BriefDataProvider, MorningBriefData } from './brief-data-provider.service';

@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  constructor(
    @InjectRepository(ExtractedEvent)
    private extractedEventRepo: Repository<ExtractedEvent>,
    private briefDataProvider: BriefDataProvider,
    private telegramNotifier: TelegramNotifierService,
    private notificationService: NotificationService,
    private digestActionStore: DigestActionStoreService,
    private carouselStateService: CarouselStateService,
    private briefStateService: BriefStateService,
  ) {}

  /**
   * Send morning brief with today's schedule and reminders.
   * Uses accordion UI with action buttons.
   */
  async sendMorningBrief(): Promise<void> {
    const now = new Date();
    // Use UTC to avoid timezone issues
    const startOfDay = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0, 0, 0, 0
    ));
    const endOfDay = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      23, 59, 59, 999
    ));

    try {
      // Fetch all data via BriefDataProvider
      const data = await this.briefDataProvider.getMorningBriefData(startOfDay, endOfDay);

      // Build brief items from data
      const items = this.buildBriefItems(data);

      // If no items, send simple message
      if (items.length === 0) {
        await this.telegramNotifier.send({
          message: '<b>Доброе утро!</b>\n\nСегодня ничего запланированного. Хорошего дня!',
          parseMode: 'HTML',
        });
        this.logger.log('Morning brief sent (empty)');
        return;
      }

      // Get chat ID
      const chatId = await this.telegramNotifier.getOwnerChatId();
      if (!chatId) {
        this.logger.warn('Cannot send morning brief: no owner chat ID');
        return;
      }

      // Create brief state (max 10 items)
      const limitedItems = items.slice(0, 10);
      const briefId = await this.briefStateService.create(String(chatId), 0, limitedItems);

      // Get state for sending
      const state = await this.briefStateService.get(briefId);
      if (!state) {
        this.logger.error('Failed to get brief state after creation');
        return;
      }

      // Send brief via telegram-adapter (formatting handled there)
      const messageId = await this.telegramNotifier.sendBrief(state);

      if (messageId) {
        await this.briefStateService.updateMessageId(briefId, messageId);
        this.logger.log(`Morning brief sent with ${limitedItems.length} items (id: ${briefId})`);

        if (items.length > 10) {
          this.logger.log(`Truncated brief from ${items.length} to 10 items`);
        }
      } else {
        await this.briefStateService.delete(briefId);
        this.logger.error('Failed to send morning brief message');
      }
    } catch (error) {
      this.logger.error('Failed to send morning brief:', error);
    }
  }

  /**
   * Build BriefItems from morning brief data
   */
  private buildBriefItems(data: MorningBriefData): BriefItem[] {
    const items: BriefItem[] = [];

    // Meetings first (most time-sensitive)
    for (const meeting of data.meetings) {
      const time = meeting.eventDate
        ? meeting.eventDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
        : '??:??';

      items.push({
        type: 'meeting',
        title: `${time} — ${meeting.title || 'Встреча'}`,
        entityName: meeting.entity?.name || 'Без имени',
        sourceType: 'entity_event',
        sourceId: meeting.id,
        details: meeting.description || `Встреча с ${meeting.entity?.name || 'контактом'}`,
        entityId: meeting.entityId,
      });
    }

    // Deadlines
    for (const deadline of data.deadlines) {
      items.push({
        type: 'task',
        title: deadline.title || 'Дедлайн',
        entityName: deadline.entity?.name || 'Без имени',
        sourceType: 'entity_event',
        sourceId: deadline.id,
        details: deadline.description || 'Дедлайн сегодня',
        entityId: deadline.entityId,
      });
    }

    // Birthdays
    for (const birthday of data.birthdays) {
      items.push({
        type: 'birthday',
        title: `День рождения`,
        entityName: birthday.name,
        sourceType: 'entity',
        sourceId: birthday.id,
        details: `День рождения у ${birthday.name}`,
        entityId: birthday.id,
      });
    }

    // Overdue commitments
    for (const commitment of data.overdueCommitments) {
      const daysOverdue = this.getDaysOverdue(commitment.eventDate);
      items.push({
        type: 'overdue',
        title: `${commitment.title || 'Обещание'} (просрочено ${daysOverdue} дн.)`,
        entityName: commitment.entity?.name || 'Без имени',
        sourceType: 'entity_event',
        sourceId: commitment.id,
        details: commitment.description || `Просрочено на ${daysOverdue} дней`,
        entityId: commitment.entityId,
      });
    }

    // Pending followups
    for (const followup of data.pendingFollowups) {
      const daysWaiting = this.getDaysOverdue(followup.eventDate);
      items.push({
        type: 'followup',
        title: `${followup.title || 'Ответ'} — ждёшь ${daysWaiting} дн.`,
        entityName: followup.entity?.name || 'Неизвестно',
        sourceType: 'entity_event',
        sourceId: followup.id,
        details: followup.description || `Ожидаешь ответа уже ${daysWaiting} дней`,
        entityId: followup.entityId,
      });
    }

    // Overdue activities (from Activity table)
    for (const activity of data.overdueActivities) {
      const daysOverdue = this.getDaysOverdue(activity.deadline);
      items.push({
        type: 'overdue',
        title: `${activity.name} (просрочено ${daysOverdue} дн.)`,
        entityName: activity.ownerEntity?.name || 'Без владельца',
        sourceType: 'activity',
        sourceId: activity.id,
        details: activity.description || `Задача просрочена на ${daysOverdue} дней`,
        entityId: activity.ownerEntityId,
      });
    }

    // Deduplicate: collect sourceMessageIds from EntityEvent-based items
    const seenSourceMessageIds = new Set<string>();
    for (const commitment of data.overdueCommitments) {
      if (commitment.sourceMessageId) {
        seenSourceMessageIds.add(commitment.sourceMessageId);
      }
    }

    // Pending commitments (from Commitment table)
    for (const commitment of data.pendingCommitments) {
      // Skip if already shown from EntityEvent
      if (commitment.sourceMessageId && seenSourceMessageIds.has(commitment.sourceMessageId)) {
        continue;
      }
      const isOverdue = commitment.dueDate && commitment.dueDate < new Date();
      const daysInfo = commitment.dueDate
        ? isOverdue
          ? `(просрочено ${this.getDaysOverdue(commitment.dueDate)} дн.)`
          : ''
        : '— ждёшь ответа';

      // Determine who the commitment is from/to
      const isFromMe = commitment.type === CommitmentType.PROMISE;
      const entityName = isFromMe
        ? commitment.toEntity?.name || 'Неизвестно'
        : commitment.fromEntity?.name || 'Неизвестно';

      items.push({
        type: isOverdue ? 'overdue' : 'followup',
        title: `${commitment.title} ${daysInfo}`,
        entityName,
        sourceType: 'commitment',
        sourceId: commitment.id,
        details: commitment.description || this.getCommitmentDetails(commitment),
        entityId: isFromMe ? commitment.toEntityId : commitment.fromEntityId,
      });
    }

    // Sort by priority: overdue items first, then by date
    items.sort((a, b) => {
      // Priority 1: overdue items come first
      const aOverdue = a.type === 'overdue' ? 0 : 1;
      const bOverdue = b.type === 'overdue' ? 0 : 1;
      if (aOverdue !== bOverdue) return aOverdue - bOverdue;

      // Priority 2: meetings come before other types (time-sensitive)
      const aMeeting = a.type === 'meeting' ? 0 : 1;
      const bMeeting = b.type === 'meeting' ? 0 : 1;
      if (aMeeting !== bMeeting) return aMeeting - bMeeting;

      // Priority 3: alphabetically by entity name for stable order
      return a.entityName.localeCompare(b.entityName);
    });

    return items;
  }

  /**
   * Send hourly digest with medium-priority pending events.
   * Uses carousel mode for multiple events (> 1).
   */
  async sendHourlyDigest(): Promise<void> {
    const events = await this.notificationService.getPendingEventsForDigest('medium', 10);

    if (events.length === 0) {
      // Send "no events" message (same pattern as sendDailyDigest)
      await this.telegramNotifier.send({
        message: '<b>Дайджест событий</b>\n\nНет новых событий для обработки.',
        parseMode: 'HTML',
      });
      this.logger.debug('Hourly digest sent (empty)');
      return;
    }

    // Use carousel mode for multiple events
    if (events.length > 1) {
      await this.sendDigestAsCarousel(events, 'hourly');
      return;
    }

    // Single event - use enhanced format with full context
    const event = events[0];
    const enhancedContent = await this.notificationService.formatEnhancedEventNotification(event);
    const message = '<b>Новые события:</b>\n\n' + enhancedContent;
    const buttons = await this.getDigestButtons(events);

    const success = await this.telegramNotifier.sendWithButtons(message, buttons);

    if (success) {
      await this.notificationService.markEventsAsNotified(events.map((e) => e.id));
      this.logger.log(`Hourly digest sent with ${events.length} event`);
    }
  }

  /**
   * Send daily digest with all remaining pending events.
   * Uses carousel mode for multiple events (> 1).
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

    // Use carousel mode for multiple events
    if (allEvents.length > 1) {
      await this.sendDigestAsCarousel(allEvents, 'daily');
      return;
    }

    // Single event - use enhanced format with full context
    const event = allEvents[0];
    const enhancedContent = await this.notificationService.formatEnhancedEventNotification(event);
    const message = '<b>Дайджест за день</b>\n\n' + enhancedContent;
    const buttons = await this.getBatchDigestButtons(allEvents);

    const success = await this.telegramNotifier.sendWithButtons(message, buttons);

    if (success) {
      await this.notificationService.markEventsAsNotified(allEvents.map((e) => e.id));
      this.logger.log(`Daily digest sent with ${allEvents.length} event`);
    }
  }

  /**
   * Send digest as carousel (one event at a time with navigation).
   * Creates carousel state in Redis and sends first event card.
   */
  private async sendDigestAsCarousel(
    events: ExtractedEvent[],
    digestType: 'hourly' | 'daily',
  ): Promise<void> {
    const eventIds = events.map((e) => e.id);

    // Get owner chat ID for sending
    const chatId = await this.telegramNotifier.getOwnerChatId();
    if (!chatId) {
      this.logger.warn('Cannot send carousel: no owner chat ID configured');
      return;
    }

    // Create carousel with placeholder messageId=0 (will be updated after send)
    // The carouselId is generated first so buttons will have correct ID
    const carouselId = await this.carouselStateService.create(String(chatId), 0, eventIds);

    // Get first event to display
    const navResult = await this.carouselStateService.getCurrentEvent(carouselId);
    if (!navResult) {
      this.logger.error('Failed to get first carousel event');
      await this.carouselStateService.delete(carouselId);
      return;
    }

    // Format carousel card and buttons (buttons use carouselId which won't change)
    const message = await this.notificationService.formatCarouselCard(navResult);
    const buttons = this.notificationService.getCarouselButtons(carouselId);

    // Add header based on digest type
    const header = digestType === 'hourly' ? '<b>Новые события</b>\n\n' : '<b>Дайджест за день</b>\n\n';
    const fullMessage = header + message;

    // Send message and get messageId
    const messageId = await this.telegramNotifier.sendWithButtonsAndGetId(fullMessage, buttons);

    if (messageId) {
      // Update carousel state with actual messageId (carouselId stays the same)
      await this.carouselStateService.updateMessageId(carouselId, messageId);

      // Mark all events as notified (they are in the carousel now)
      await this.notificationService.markEventsAsNotified(eventIds);
      this.logger.log(`${digestType} carousel sent with ${events.length} events (id: ${carouselId})`);
    } else {
      // Failed to send - cleanup
      await this.carouselStateService.delete(carouselId);
      this.logger.error('Failed to send carousel message');
    }
  }

  /**
   * Get human-readable details for a Commitment.
   */
  private getCommitmentDetails(commitment: Commitment): string {
    const typeLabels: Record<CommitmentType, string> = {
      [CommitmentType.PROMISE]: 'Обещание',
      [CommitmentType.REQUEST]: 'Запрос',
      [CommitmentType.AGREEMENT]: 'Договорённость',
      [CommitmentType.DEADLINE]: 'Дедлайн',
      [CommitmentType.REMINDER]: 'Напоминание',
      [CommitmentType.RECURRING]: 'Периодическая задача',
    };

    const typeLabel = typeLabels[commitment.type] || 'Обязательство';
    const from = commitment.fromEntity?.name || 'Неизвестно';
    const to = commitment.toEntity?.name || 'Неизвестно';

    if (commitment.type === CommitmentType.PROMISE) {
      return `${typeLabel}: ${from} → ${to}`;
    } else if (commitment.type === CommitmentType.REQUEST) {
      return `${typeLabel}: ожидаешь от ${from}`;
    }

    return `${typeLabel}: ${commitment.title}`;
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

    return escapeHtml(text);
  }

  private getDaysOverdue(eventDate: Date | null): number {
    if (!eventDate) return 0;
    const now = new Date();
    const diffMs = now.getTime() - eventDate.getTime();
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
  }
}
