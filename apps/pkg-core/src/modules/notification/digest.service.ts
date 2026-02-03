import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  PendingApproval,
  PendingApprovalStatus,
  PendingApprovalItemType,
  Commitment,
  CommitmentType,
  Activity,
  EntityFact,
  escapeHtml,
} from '@pkg/entities';
import { TelegramNotifierService } from './telegram-notifier.service';
import { DigestActionStoreService } from './digest-action-store.service';
import { BriefStateService, BriefItem } from './brief-state.service';
import { BriefDataProvider, MorningBriefData } from './brief-data-provider.service';

@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  constructor(
    @InjectRepository(PendingApproval)
    private pendingApprovalRepo: Repository<PendingApproval>,
    @InjectRepository(Commitment)
    private commitmentRepo: Repository<Commitment>,
    @InjectRepository(Activity)
    private activityRepo: Repository<Activity>,
    @InjectRepository(EntityFact)
    private entityFactRepo: Repository<EntityFact>,
    private briefDataProvider: BriefDataProvider,
    private telegramNotifier: TelegramNotifierService,
    private digestActionStore: DigestActionStoreService,
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
   * Send hourly digest with pending approvals.
   * Shows items awaiting user confirmation.
   */
  async sendHourlyDigest(): Promise<void> {
    const approvals = await this.getPendingApprovals(10);

    if (approvals.length === 0) {
      await this.telegramNotifier.send({
        message: '<b>Дайджест событий</b>\n\nНет новых событий для обработки.',
        parseMode: 'HTML',
      });
      this.logger.debug('Hourly digest sent (empty)');
      return;
    }

    // Format message with pending items
    const message = await this.formatApprovalDigest(approvals, 'hourly');
    const buttons = await this.getApprovalDigestButtons(approvals);

    const success = await this.telegramNotifier.sendWithButtons(message, buttons);

    if (success) {
      this.logger.log(`Hourly digest sent with ${approvals.length} pending approvals`);
    }
  }

  /**
   * Send daily digest with all pending approvals.
   * Shows all items awaiting user confirmation.
   */
  async sendDailyDigest(): Promise<void> {
    const approvals = await this.getPendingApprovals(30);

    if (approvals.length === 0) {
      await this.telegramNotifier.send({
        message: '<b>Дайджест за день</b>\n\nНет новых событий для обработки.',
        parseMode: 'HTML',
      });
      return;
    }

    // Format message with pending items
    const message = await this.formatApprovalDigest(approvals, 'daily');
    const buttons = await this.getApprovalDigestButtons(approvals);

    const success = await this.telegramNotifier.sendWithButtons(message, buttons);

    if (success) {
      this.logger.log(`Daily digest sent with ${approvals.length} pending approvals`);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // PendingApproval Methods
  // ─────────────────────────────────────────────────────────────────

  /**
   * Get pending approvals for digest.
   */
  private async getPendingApprovals(limit: number): Promise<PendingApproval[]> {
    return this.pendingApprovalRepo.find({
      where: { status: PendingApprovalStatus.PENDING },
      order: { createdAt: 'ASC' },
      take: limit,
    });
  }

  /**
   * Format digest message for pending approvals.
   */
  private async formatApprovalDigest(
    approvals: PendingApproval[],
    digestType: 'hourly' | 'daily',
  ): Promise<string> {
    const header =
      digestType === 'hourly' ? '<b>Новые события:</b>' : '<b>Дайджест за день</b>';
    const lines: string[] = [header, ''];

    for (let i = 0; i < approvals.length; i++) {
      const approval = approvals[i];
      const emoji = this.getApprovalEmoji(approval.itemType);
      const summary = await this.getApprovalSummary(approval);
      lines.push(`${i + 1}. ${emoji} ${summary}`);
    }

    if (digestType === 'daily') {
      lines.push('');
      lines.push(`<i>Всего: ${approvals.length} событий</i>`);
    }

    return lines.join('\n');
  }

  /**
   * Get emoji for approval item type.
   */
  private getApprovalEmoji(itemType: PendingApprovalItemType): string {
    const emojis: Record<PendingApprovalItemType, string> = {
      [PendingApprovalItemType.COMMITMENT]: '🤝',
      [PendingApprovalItemType.TASK]: '📋',
      [PendingApprovalItemType.PROJECT]: '📁',
      [PendingApprovalItemType.FACT]: 'ℹ️',
    };
    return emojis[itemType] || '📌';
  }

  /**
   * Get summary text for a pending approval.
   */
  private async getApprovalSummary(approval: PendingApproval): Promise<string> {
    try {
      switch (approval.itemType) {
        case PendingApprovalItemType.COMMITMENT: {
          const commitment = await this.commitmentRepo.findOne({
            where: { id: approval.targetId },
          });
          if (commitment) {
            return escapeHtml(commitment.title || 'Обязательство');
          }
          break;
        }

        case PendingApprovalItemType.TASK:
        case PendingApprovalItemType.PROJECT: {
          const activity = await this.activityRepo.findOne({
            where: { id: approval.targetId },
          });
          if (activity) {
            return escapeHtml(activity.name || 'Активность');
          }
          break;
        }

        case PendingApprovalItemType.FACT: {
          const fact = await this.entityFactRepo.findOne({
            where: { id: approval.targetId },
          });
          if (fact) {
            return escapeHtml(`${fact.factType}: ${fact.value}`);
          }
          break;
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to get summary for approval ${approval.id}: ${error}`);
    }

    return approval.sourceQuote
      ? escapeHtml(approval.sourceQuote.slice(0, 50))
      : 'Событие';
  }

  /**
   * Get buttons for pending approval digest.
   * Uses digestActionStore for short IDs.
   */
  private async getApprovalDigestButtons(
    approvals: PendingApproval[],
  ): Promise<Array<Array<{ text: string; callback_data: string }>>> {
    const approvalIds = approvals.map((a) => a.id);
    const shortId = await this.digestActionStore.store(approvalIds);

    const confirmText = approvals.length === 1 ? 'Подтвердить' : 'Подтвердить все';
    const rejectText = approvals.length === 1 ? 'Игнорировать' : 'Игнорировать все';

    return [
      [
        { text: confirmText, callback_data: `pa_c:${shortId}` },
        { text: rejectText, callback_data: `pa_r:${shortId}` },
      ],
    ];
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
      [CommitmentType.MEETING]: 'Встреча',
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


  private getDaysOverdue(eventDate: Date | null): number {
    if (!eventDate) return 0;
    const now = new Date();
    const diffMs = now.getTime() - eventDate.getTime();
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
  }
}
