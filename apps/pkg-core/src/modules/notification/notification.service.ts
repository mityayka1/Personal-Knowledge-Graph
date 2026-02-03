import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, In } from 'typeorm';
import {
  ExtractedEvent,
  ExtractedEventType,
  ExtractedEventStatus,
  EntityRecord,
  EntityIdentifier,
  IdentifierType,
  Message,
  Interaction,
  escapeHtml,
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
    @InjectRepository(EntityRecord)
    private entityRepo: Repository<EntityRecord>,
    @InjectRepository(EntityIdentifier)
    private identifierRepo: Repository<EntityIdentifier>,
    @InjectRepository(Message)
    private messageRepo: Repository<Message>,
    @InjectRepository(Interaction)
    private interactionRepo: Repository<Interaction>,
    private telegramNotifier: TelegramNotifierService,
    private settingsService: SettingsService,
    private digestActionStore: DigestActionStoreService,
  ) {}

  /**
   * Send notification for extracted event.
   * Uses atomic update to prevent race conditions.
   */
  async notifyAboutEvent(event: ExtractedEvent): Promise<boolean> {
    const message = await this.formatEnhancedEventNotification(event);
    const buttons = await this.getEventButtons(event);

    const success = await this.telegramNotifier.sendWithButtons(message, buttons);

    if (success) {
      // Atomic mark as notified (only if not already notified)
      const result = await this.extractedEventRepo
        .createQueryBuilder()
        .update()
        .set({ notificationSentAt: new Date() })
        .where('id = :id', { id: event.id })
        .andWhere('notification_sent_at IS NULL')
        .execute();

      if (result.affected === 0) {
        this.logger.debug(`Event ${event.id} was already notified by another process`);
      }
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
    // Also excludes events from bot entities (e.g. automated notifications)
    const all = await this.extractedEventRepo
      .createQueryBuilder('event')
      .where('event.status = :status', { status: ExtractedEventStatus.PENDING })
      .andWhere('event.notification_sent_at IS NULL')
      .andWhere(
        `NOT EXISTS (
          SELECT 1 FROM entities e
          WHERE e.id = event.entity_id AND e.is_bot = true
        )`,
      )
      .orderBy('event.created_at', 'ASC')
      .take(200) // Reasonable max to scan
      .getMany();

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
   * Mark events as notified (after sending digest).
   * Uses atomic update with WHERE clause to prevent race conditions.
   * Returns number of events actually marked (excludes already notified).
   */
  async markEventsAsNotified(eventIds: string[]): Promise<number> {
    if (eventIds.length === 0) return 0;

    // Atomic update: only update events that haven't been notified yet
    // This prevents race conditions when multiple processes try to mark same events
    const result = await this.extractedEventRepo
      .createQueryBuilder()
      .update()
      .set({ notificationSentAt: new Date() })
      .where('id IN (:...ids)', { ids: eventIds })
      .andWhere('notification_sent_at IS NULL')
      .execute();

    return result.affected || 0;
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
   * Includes duplicate prevention check.
   */
  async sendNotificationForEvent(eventId: string): Promise<void> {
    // Check for event that hasn't been notified yet (prevents duplicates)
    const event = await this.extractedEventRepo.findOne({
      where: {
        id: eventId,
        notificationSentAt: IsNull(),
      },
    });

    if (!event) {
      this.logger.debug(`Event ${eventId} not found or already notified, skipping`);
      return;
    }

    await this.notifyAboutEvent(event);
  }

  /**
   * Send digest notification for specific events.
   * Called by notification processor for queued digest jobs.
   * Includes duplicate prevention - filters out already notified events.
   */
  async sendDigestForEvents(
    eventIds: string[],
    digestType: 'hourly' | 'daily',
  ): Promise<void> {
    if (eventIds.length === 0) {
      this.logger.debug(`No events for ${digestType} digest`);
      return;
    }

    // Filter out already notified events (prevents duplicates on retry)
    const events = await this.extractedEventRepo.find({
      where: {
        id: In(eventIds),
        notificationSentAt: IsNull(),
      },
      order: { createdAt: 'ASC' },
    });

    if (events.length === 0) {
      this.logger.debug(`All events for ${digestType} digest already notified, skipping`);
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

    return escapeHtml(text);
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
      text ? escapeHtml(text) : '';

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
        return `<b>Событие:</b>\n${escapeHtml(JSON.stringify(event.extractedData))}`;
    }
  }

  /**
   * Format enhanced event notification with contact links, message deep links,
   * needsContext warning, and enrichment synthesis.
   * Public method for use by DigestService for rich single-event formatting.
   */
  async formatEnhancedEventNotification(event: ExtractedEvent): Promise<string> {
    const [contactInfo, messageLinkInfo] = await Promise.all([
      this.getContactInfo(event),
      this.getMessageLinkInfo(event),
    ]);

    const lines: string[] = [];

    // Event type header with emoji
    const emoji = this.getEventEmoji(event.eventType);
    const typeLabel = this.getEventTypeLabel(event.eventType);
    lines.push(`${emoji} <b>${typeLabel}</b>`);

    // Contact link (clickable if telegram info available)
    if (contactInfo) {
      const contactLink = this.formatContactLink(
        contactInfo.name,
        contactInfo.telegramUserId,
        contactInfo.telegramUsername,
      );
      lines.push(`👤 От: ${contactLink}`);
    }

    // Event content (basic formatting)
    const basicContent = this.formatEventNotification(event);
    // Remove the header from basic content (it's duplicated)
    const contentWithoutHeader = basicContent.replace(/<b>[^<]+<\/b>\n/, '');
    if (contentWithoutHeader.trim()) {
      lines.push(`📝 ${contentWithoutHeader.trim()}`);
    }

    // Source quote (if available)
    if (messageLinkInfo.sourceQuote) {
      const truncatedQuote = messageLinkInfo.sourceQuote.length > 100
        ? messageLinkInfo.sourceQuote.slice(0, 100) + '...'
        : messageLinkInfo.sourceQuote;
      lines.push(`💬 <i>"${escapeHtml(truncatedQuote)}"</i>`);
    }

    // Message deep link (if available)
    if (messageLinkInfo.deepLink) {
      lines.push(this.formatMessageLink(messageLinkInfo.deepLink));
    }

    // Warning for abstract events that need context clarification
    if (event.needsContext) {
      lines.push('');
      lines.push('⚠️ <i>Контекст не найден. Уточните о чём речь.</i>');
    }

    // Show linked event info if enrichment found a related event
    if (event.linkedEventId && event.enrichmentData?.synthesis) {
      lines.push('');
      lines.push(`🔗 <i>${escapeHtml(String(event.enrichmentData.synthesis))}</i>`);
    }

    return lines.join('\n');
  }

  /**
   * Get inline keyboard buttons for single event actions.
   * Uses unified callback_data format with Redis short ID.
   * Format:
   * - d_c:<shortId> (confirm)
   * - d_r:<shortId> (reject)
   * - d_rm:<shortId> (remind +7 days)
   * - d_rs:<shortId> (reschedule - show options)
   *
   * Additional buttons based on event type:
   * - MEETING: Перенести (reschedule)
   * - PROMISE_BY_ME, TASK: Напомнить (remind)
   */
  private async getEventButtons(
    event: ExtractedEvent,
  ): Promise<Array<Array<{ text: string; callback_data: string }>>> {
    const shortId = await this.digestActionStore.store([event.id]);

    const buttons: Array<Array<{ text: string; callback_data: string }>> = [
      [
        { text: 'Подтвердить', callback_data: `d_c:${shortId}` },
        { text: 'Игнорировать', callback_data: `d_r:${shortId}` },
      ],
    ];

    // Add type-specific buttons
    const additionalButtons: Array<{ text: string; callback_data: string }> = [];

    // Remind button for promises and tasks
    if (
      event.eventType === ExtractedEventType.PROMISE_BY_ME ||
      event.eventType === ExtractedEventType.TASK
    ) {
      additionalButtons.push({
        text: 'Напомнить',
        callback_data: `d_rm:${shortId}`,
      });
    }

    // Reschedule button for meetings
    if (event.eventType === ExtractedEventType.MEETING) {
      additionalButtons.push({
        text: 'Перенести',
        callback_data: `d_rs:${shortId}`,
      });
    }

    if (additionalButtons.length > 0) {
      buttons.push(additionalButtons);
    }

    return buttons;
  }

  // ─────────────────────────────────────────────────────────────────
  // Contact Link Helpers (Issue #62 - UX Improvements)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Get contact info for an event (entity name, telegram ID, and username).
   * Returns name, telegram ID, and username if available.
   */
  private async getContactInfo(event: ExtractedEvent): Promise<{
    name: string;
    telegramUserId: string | null;
    telegramUsername: string | null;
  } | null> {
    // First try to get entityId directly from the event
    let entityId = event.entityId;

    // If not set, try to get from the source message's sender
    if (!entityId && event.sourceMessageId) {
      const message = await this.messageRepo.findOne({
        where: { id: event.sourceMessageId },
        select: ['senderEntityId'],
      });
      entityId = message?.senderEntityId ?? null;
    }

    if (!entityId) {
      return null;
    }

    // Get entity name
    const entity = await this.entityRepo.findOne({
      where: { id: entityId },
      select: ['name'],
    });

    if (!entity) {
      return null;
    }

    // Get telegram user ID and username from identifiers
    const telegramIdentifier = await this.identifierRepo.findOne({
      where: {
        entityId,
        identifierType: IdentifierType.TELEGRAM_USER_ID,
      },
      select: ['identifierValue', 'metadata'],
    });

    // Extract username from metadata if available
    const metadata = telegramIdentifier?.metadata as { username?: string } | null;
    const username = metadata?.username ?? null;

    return {
      name: entity.name,
      telegramUserId: telegramIdentifier?.identifierValue ?? null,
      telegramUsername: username,
    };
  }

  /**
   * Format contact name as a clickable Telegram link.
   * Priority:
   * 1. If username available: https://t.me/username (works for users and bots)
   * 2. If only user ID: tg://user?id=123 (limited to users who interacted with bot)
   * 3. Falls back to plain text if no telegram info.
   */
  private formatContactLink(
    name: string,
    telegramUserId: string | null,
    telegramUsername: string | null,
  ): string {
    const escapedName = escapeHtml(name);

    // Prefer username (works reliably for both users and bots)
    if (telegramUsername) {
      return `<a href="https://t.me/${telegramUsername}">${escapedName}</a>`;
    }

    // Fallback to user ID (limited, may not work for all users)
    if (telegramUserId) {
      return `<a href="tg://user?id=${telegramUserId}">${escapedName}</a>`;
    }

    return escapedName;
  }

  /**
   * Get message link info for an event (deep link to original message).
   * Returns the telegram chat ID and message ID if available.
   */
  private async getMessageLinkInfo(event: ExtractedEvent): Promise<{
    deepLink: string | null;
    sourceQuote: string | null;
  }> {
    // Get sourceQuote directly from event
    const sourceQuote = event.sourceQuote ?? null;

    // Need sourceMessageId and sourceInteractionId to build deep link
    if (!event.sourceMessageId) {
      return { deepLink: null, sourceQuote };
    }

    // Get the message to find telegram message ID
    const message = await this.messageRepo.findOne({
      where: { id: event.sourceMessageId },
      select: ['sourceMessageId', 'interactionId'],
    });

    if (!message?.sourceMessageId) {
      return { deepLink: null, sourceQuote };
    }

    // Get the interaction to find telegram chat ID
    const interactionId = event.sourceInteractionId ?? message.interactionId;
    if (!interactionId) {
      return { deepLink: null, sourceQuote };
    }

    const interaction = await this.interactionRepo.findOne({
      where: { id: interactionId },
      select: ['sourceMetadata'],
    });

    const telegramChatId = interaction?.sourceMetadata?.telegram_chat_id;
    if (!telegramChatId) {
      return { deepLink: null, sourceQuote };
    }

    // Format deep link: https://t.me/c/CHAT_ID/MSG_ID
    // For private chats/groups, we need to normalize the chat ID:
    // - Remove 'channel_' prefix (from some storage formats)
    // - Remove '-100' prefix (Telegram internal format for supergroups/channels)
    // - Remove '-' prefix (for regular groups)
    // Convert to string first - telegram_chat_id may be stored as number
    let chatIdForLink = String(telegramChatId);
    if (chatIdForLink.startsWith('channel_')) {
      chatIdForLink = chatIdForLink.substring(8); // Remove 'channel_' prefix
    }
    if (chatIdForLink.startsWith('-100')) {
      chatIdForLink = chatIdForLink.substring(4); // Remove -100 prefix
    } else if (chatIdForLink.startsWith('-')) {
      chatIdForLink = chatIdForLink.substring(1); // Remove - prefix for groups
    }

    const deepLink = `https://t.me/c/${chatIdForLink}/${message.sourceMessageId}`;
    return { deepLink, sourceQuote };
  }

  /**
   * Format message link as a clickable Telegram deep link.
   */
  private formatMessageLink(deepLink: string): string {
    return `<a href="${deepLink}">📎 Сообщение</a>`;
  }

  /**
   * Get human-readable event type label.
   */
  private getEventTypeLabel(type: ExtractedEventType): string {
    const labels: Record<ExtractedEventType, string> = {
      [ExtractedEventType.MEETING]: 'Встреча',
      [ExtractedEventType.PROMISE_BY_ME]: 'Моё обещание',
      [ExtractedEventType.PROMISE_BY_THEM]: 'Их обещание',
      [ExtractedEventType.TASK]: 'Задача',
      [ExtractedEventType.FACT]: 'Факт',
      [ExtractedEventType.CANCELLATION]: 'Отмена',
    };
    return labels[type] || 'Событие';
  }
}
