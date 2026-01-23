import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { randomBytes } from 'crypto';
import { escapeHtml } from '@pkg/entities';
import { EntityService } from '../entity/entity.service';
import { TelegramNotifierService } from './telegram-notifier.service';

/**
 * Approval status enum
 */
export enum ApprovalStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  EDITING = 'editing',
  EXPIRED = 'expired',
}

/**
 * Edit mode for approval
 */
export type EditMode = 'describe' | 'verbatim' | null;

/**
 * Pending approval stored in Redis
 */
export interface PendingApproval {
  /** Unique approval ID */
  id: string;
  /** Entity ID of the recipient */
  entityId: string;
  /** Entity name for display */
  entityName: string;
  /** Telegram user ID of recipient */
  telegramUserId: string;
  /** Telegram username of recipient (without @) */
  telegramUsername: string | null;
  /** Message text to send */
  text: string;
  /** Current status */
  status: ApprovalStatus;
  /** Edit mode if editing */
  editMode: EditMode;
  /** Bot message ID for editMessage */
  botMessageId: number | null;
  /** Chat ID where approval was sent */
  chatId: string | null;
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
}

/**
 * Result of approval flow
 */
export interface ApprovalResult {
  approved: boolean;
  text?: string;
  reason?: string;
}

/**
 * Service for managing message approval flow.
 *
 * Architecture:
 * - State stored in Redis with TTL
 * - Pub/Sub for async notification of approval result
 * - Bot shows approval UI, user responds via callbacks
 *
 * Flow:
 * 1. Agent calls send_telegram tool
 * 2. ApprovalService creates pending approval and shows bot message
 * 3. User clicks approve/edit/cancel
 * 4. Callback handler updates approval status
 * 5. If approved, TelegramSendService sends message via userbot
 */
@Injectable()
export class ApprovalService implements OnModuleDestroy {
  private readonly logger = new Logger(ApprovalService.name);

  /** Redis key prefix for approvals */
  private readonly KEY_PREFIX = 'approval:';

  /** Redis pub/sub channel for approval results */
  private readonly CHANNEL_PREFIX = 'approval_result:';

  /** TTL for pending approvals (2 minutes) */
  private readonly TTL_SECONDS = 120;

  /** Subscriber Redis client for pub/sub */
  private subscriber: Redis | null = null;

  /** Map of pending promises waiting for approval */
  private pendingPromises = new Map<
    string,
    {
      resolve: (result: ApprovalResult) => void;
      timeout: NodeJS.Timeout;
      resolved: boolean;
    }
  >();

  constructor(
    @InjectRedis()
    private readonly redis: Redis,
    private readonly entityService: EntityService,
    private readonly telegramNotifier: TelegramNotifierService,
  ) {
    this.initSubscriber();
  }

  /**
   * Cleanup on module destroy - close Redis subscriber and pending promises
   */
  async onModuleDestroy(): Promise<void> {
    this.logger.log('ApprovalService shutting down...');

    // Close Redis subscriber
    if (this.subscriber) {
      try {
        await this.subscriber.quit();
        this.subscriber = null;
        this.logger.log('Redis subscriber closed');
      } catch (error) {
        this.logger.error('Failed to close Redis subscriber:', error);
      }
    }

    // Resolve all pending promises with shutdown reason
    for (const [id, pending] of this.pendingPromises) {
      clearTimeout(pending.timeout);
      pending.resolve({ approved: false, reason: 'Service shutdown' });
    }
    this.pendingPromises.clear();

    this.logger.log('ApprovalService shutdown complete');
  }

  /**
   * Initialize Redis subscriber for pub/sub
   */
  private async initSubscriber(): Promise<void> {
    try {
      // Create duplicate connection for subscribing
      this.subscriber = this.redis.duplicate();

      // Handle messages
      this.subscriber.on('message', (channel: string, message: string) => {
        this.handlePubSubMessage(channel, message);
      });

      this.logger.log('Approval pub/sub subscriber initialized');
    } catch (error) {
      this.logger.error('Failed to initialize pub/sub subscriber:', error);
    }
  }

  /**
   * Handle pub/sub message
   */
  private handlePubSubMessage(channel: string, message: string): void {
    const approvalId = channel.replace(this.CHANNEL_PREFIX, '');
    const pending = this.pendingPromises.get(approvalId);

    if (!pending) {
      this.logger.debug(`No pending promise for approval ${approvalId}`);
      return;
    }

    // Prevent race condition - check if already resolved
    if (pending.resolved) {
      this.logger.debug(`Approval ${approvalId} already resolved, ignoring`);
      return;
    }

    try {
      const result: ApprovalResult = JSON.parse(message);
      pending.resolved = true;
      clearTimeout(pending.timeout);
      this.pendingPromises.delete(approvalId);
      pending.resolve(result);
      this.logger.debug(`Resolved approval ${approvalId}: ${result.approved}`);
    } catch (error) {
      this.logger.error(`Failed to parse pub/sub message: ${error}`);
    }
  }

  /**
   * Create a pending approval and show bot message (async, non-blocking).
   * Does NOT wait for user response - returns immediately with approval ID.
   *
   * Use this from tools when you don't want to block the agent loop.
   *
   * @param entityId - UUID of recipient entity
   * @param text - Message text to send
   * @returns Object with approvalId and status
   */
  async createApproval(
    entityId: string,
    text: string,
  ): Promise<{ approvalId: string; status: 'pending' | 'error'; error?: string }> {
    try {
      // Get entity info
      const entity = await this.entityService.findOne(entityId);
      const telegramId = entity.identifiers?.find(
        (i) => i.identifierType === 'telegram_user_id',
      );

      if (!telegramId) {
        return { approvalId: '', status: 'error', error: 'No Telegram identifier for entity' };
      }

      // Get telegram username if available
      const telegramUsername = entity.identifiers?.find(
        (i) => i.identifierType === 'telegram_username',
      );

      // Generate short approval ID
      const approvalId = `a_${randomBytes(6).toString('hex')}`;

      // Create pending approval
      const approval: PendingApproval = {
        id: approvalId,
        entityId,
        entityName: entity.name,
        telegramUserId: telegramId.identifierValue,
        telegramUsername: telegramUsername?.identifierValue || null,
        text,
        status: ApprovalStatus.PENDING,
        editMode: null,
        botMessageId: null,
        chatId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // Save to Redis
      await this.save(approvalId, approval);

      // Send approval message to user
      const messageId = await this.sendApprovalMessage(approval);

      if (messageId) {
        approval.botMessageId = messageId;
        approval.chatId = String(await this.telegramNotifier.getOwnerChatId());
        await this.save(approvalId, approval);
      }

      this.logger.log(`Created approval ${approvalId} for ${entity.name}`);

      return { approvalId, status: 'pending' };
    } catch (error) {
      this.logger.error(`Failed to create approval: ${error}`);
      return { approvalId: '', status: 'error', error: String(error) };
    }
  }

  /**
   * Create a pending approval and show bot message.
   * Returns a Promise that resolves when user responds.
   *
   * @param entityId - UUID of recipient entity
   * @param text - Message text to send
   * @returns ApprovalResult when user responds or timeout
   */
  async requestApproval(
    entityId: string,
    text: string,
  ): Promise<ApprovalResult> {
    // Get entity info
    const entity = await this.entityService.findOne(entityId);
    const telegramId = entity.identifiers?.find(
      (i) => i.identifierType === 'telegram_user_id',
    );

    if (!telegramId) {
      return { approved: false, reason: 'No Telegram identifier for entity' };
    }

    // Get telegram username if available
    const telegramUsername = entity.identifiers?.find(
      (i) => i.identifierType === 'telegram_username',
    );

    // Generate short approval ID
    const approvalId = `a_${randomBytes(6).toString('hex')}`;

    // Create pending approval
    const approval: PendingApproval = {
      id: approvalId,
      entityId,
      entityName: entity.name,
      telegramUserId: telegramId.identifierValue,
      telegramUsername: telegramUsername?.identifierValue || null,
      text,
      status: ApprovalStatus.PENDING,
      editMode: null,
      botMessageId: null,
      chatId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Save to Redis
    await this.save(approvalId, approval);

    // Send approval message to user
    const messageId = await this.sendApprovalMessage(approval);

    if (messageId) {
      approval.botMessageId = messageId;
      approval.chatId = String(await this.telegramNotifier.getOwnerChatId());
      await this.save(approvalId, approval);
    }

    // Subscribe to result channel
    if (this.subscriber) {
      await this.subscriber.subscribe(`${this.CHANNEL_PREFIX}${approvalId}`);
    }

    // Return promise that resolves on user response
    return new Promise<ApprovalResult>((resolve) => {
      const pendingEntry = {
        resolve,
        timeout: null as unknown as NodeJS.Timeout,
        resolved: false,
      };

      pendingEntry.timeout = setTimeout(() => {
        // Prevent race condition - check if already resolved
        if (pendingEntry.resolved) {
          return;
        }
        pendingEntry.resolved = true;
        this.pendingPromises.delete(approvalId);
        if (this.subscriber) {
          this.subscriber.unsubscribe(`${this.CHANNEL_PREFIX}${approvalId}`);
        }
        resolve({ approved: false, reason: 'Timeout' });
      }, this.TTL_SECONDS * 1000);

      this.pendingPromises.set(approvalId, pendingEntry);
    });
  }

  /**
   * Handle approval action from callback
   *
   * @param approvalId - Approval ID
   * @param action - User action (approve, reject, edit)
   */
  async handleAction(
    approvalId: string,
    action: 'approve' | 'reject' | 'edit',
  ): Promise<PendingApproval | null> {
    const approval = await this.get(approvalId);
    if (!approval) {
      this.logger.warn(`Approval not found: ${approvalId}`);
      return null;
    }

    switch (action) {
      case 'approve':
        approval.status = ApprovalStatus.APPROVED;
        await this.save(approvalId, approval);
        await this.publishResult(approvalId, {
          approved: true,
          text: approval.text,
        });
        break;

      case 'reject':
        approval.status = ApprovalStatus.REJECTED;
        await this.save(approvalId, approval);
        await this.publishResult(approvalId, {
          approved: false,
          reason: 'Cancelled by user',
        });
        break;

      case 'edit':
        approval.status = ApprovalStatus.EDITING;
        await this.save(approvalId, approval);
        break;
    }

    return approval;
  }

  /**
   * Set edit mode for approval
   *
   * @param approvalId - Approval ID
   * @param mode - Edit mode (describe or verbatim)
   */
  async setEditMode(
    approvalId: string,
    mode: 'describe' | 'verbatim',
  ): Promise<PendingApproval | null> {
    const approval = await this.get(approvalId);
    if (!approval) return null;

    approval.editMode = mode;
    approval.updatedAt = Date.now();
    await this.save(approvalId, approval);

    return approval;
  }

  /**
   * Update text after edit
   *
   * @param approvalId - Approval ID
   * @param text - New text
   */
  async updateText(
    approvalId: string,
    text: string,
  ): Promise<PendingApproval | null> {
    const approval = await this.get(approvalId);
    if (!approval) return null;

    approval.text = text;
    approval.status = ApprovalStatus.PENDING;
    approval.editMode = null;
    approval.updatedAt = Date.now();
    await this.save(approvalId, approval);

    // Resend approval message
    await this.sendApprovalMessage(approval);

    return approval;
  }

  /**
   * Get pending approval by ID
   */
  async get(approvalId: string): Promise<PendingApproval | null> {
    const key = `${this.KEY_PREFIX}${approvalId}`;
    const data = await this.redis.get(key);

    if (!data) return null;

    try {
      return JSON.parse(data) as PendingApproval;
    } catch (error) {
      this.logger.error(`Failed to parse approval: ${approvalId}`);
      return null;
    }
  }

  /**
   * Save approval to Redis
   */
  private async save(
    approvalId: string,
    approval: PendingApproval,
  ): Promise<void> {
    const key = `${this.KEY_PREFIX}${approvalId}`;
    await this.redis.setex(key, this.TTL_SECONDS, JSON.stringify(approval));
  }

  /**
   * Publish approval result via pub/sub
   */
  private async publishResult(
    approvalId: string,
    result: ApprovalResult,
  ): Promise<void> {
    const channel = `${this.CHANNEL_PREFIX}${approvalId}`;
    await this.redis.publish(channel, JSON.stringify(result));
  }

  /**
   * Send approval message via bot
   */
  private async sendApprovalMessage(
    approval: PendingApproval,
  ): Promise<number | null> {
    // Create clickable contact link
    // Priority: https://t.me/username (more reliable) > tg://user?id=X (limited)
    const escapedName = escapeHtml(approval.entityName);
    let contactLink: string;

    if (approval.telegramUsername) {
      // Username link - works for users and bots
      contactLink = `<a href="https://t.me/${approval.telegramUsername}">${escapedName}</a>`;
    } else if (approval.telegramUserId) {
      // User ID link - limited to users who interacted with bot
      contactLink = `<a href="tg://user?id=${approval.telegramUserId}">${escapedName}</a>`;
    } else {
      contactLink = escapedName;
    }

    const message = `📤 <b>Отправить сообщение?</b>

<b>Кому:</b> ${contactLink}

<b>Текст:</b>
${escapeHtml(approval.text)}`;

    const buttons = [
      [
        { text: '✅ Отправить', callback_data: `act_a:${approval.id}` },
        { text: '✏️ Изменить', callback_data: `act_e:${approval.id}` },
        { text: '❌ Отмена', callback_data: `act_r:${approval.id}` },
      ],
    ];

    return this.telegramNotifier.sendWithButtonsAndGetId(message, buttons, 'HTML');
  }
}
