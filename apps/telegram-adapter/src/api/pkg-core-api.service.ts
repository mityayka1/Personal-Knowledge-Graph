import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosError } from 'axios';
import type { BriefResponse } from '@pkg/entities';

interface MessagePayload {
  source: string;
  telegram_chat_id: string;
  telegram_user_id: string;
  telegram_username?: string;
  telegram_display_name?: string;
  message_id: string;
  text?: string;
  timestamp: string;
  is_outgoing: boolean;
  reply_to_message_id?: string;
  media_type?: string;
  media_url?: string;
  chat_type?: string;
  topic_id?: number;
  topic_name?: string;
  /** Number of participants for categorization */
  participants_count?: number;
}

export interface MembershipChangePayload {
  telegram_chat_id: string;
  telegram_user_id: string;
  display_name?: string;
  action: 'joined' | 'left';
  timestamp: string;
}

export interface MessageResponse {
  id: string;
  interaction_id: string;
  entity_id: string | null;
  entity_resolution_status: 'resolved' | 'pending';
  pending_resolution_id: string | null;
  /** True if a new Entity was automatically created for this contact (private chats only) */
  auto_created_entity?: boolean;
  created_at: string;
  is_update?: boolean;
}

interface HealthResponse {
  status: string;
  services: {
    database: string;
  };
}

export interface ChatStats {
  telegramChatId: string;
  lastMessageId: string | null;
  lastMessageTimestamp: string | null;
  messageCount: number;
}

export interface ChatStatsResponse {
  chats: ChatStats[];
}

// ============================================
// Second Brain Agent API Types
// ============================================

export interface RecallSource {
  type: 'message' | 'interaction';
  id: string;
  preview: string;
}

export interface RecallResponseData {
  answer: string;
  sources: RecallSource[];
  toolsUsed: string[];
}

export interface RecallResponse {
  success: boolean;
  data: RecallResponseData;
}

export interface RecallRequestDto {
  query: string;
  userId?: string;
}

export interface PrepareResponseData {
  entityId: string;
  entityName: string;
  brief: string;
  recentInteractions: number;
  openQuestions: string[];
}

export interface PrepareResponse {
  success: boolean;
  data: PrepareResponseData;
}

export interface EntitySearchResult {
  id: string;
  name: string;
  type: string;
  createdAt: string;
}

export interface EntitiesResponse {
  items: EntitySearchResult[];
  total: number;
}

// ============================================
// Extracted Events API Types
// ============================================

export interface ExtractedEventActionResponse {
  success: boolean;
  createdEntityId?: string;
  error?: string;
}

export interface RemindResponse {
  success: boolean;
  createdEntityId?: string;
  reminderDate?: string;
}

export interface RescheduleResponse {
  success: boolean;
  newDate?: string;
  updatedEntityEventId?: string;
}

// ============================================
// Carousel API Types
// ============================================

export interface CarouselNavResponse {
  success: boolean;
  complete: boolean;
  message?: string;
  buttons?: Array<Array<{ text: string; callback_data: string }>>;
  chatId?: string;
  messageId?: number;
  processedCount?: number;
  error?: string;
}

// ============================================
// Message Approval API Types (Phase A: Act)
// ============================================

export interface ApprovalResponse {
  success: boolean;
  sendResult?: {
    messageId?: number;
    chatId?: string;
  };
  approval?: {
    id: string;
    status: string;
    text?: string;
    entityName?: string;
    editMode?: 'describe' | 'verbatim' | null;
  };
  error?: string;
}

// Brief types are imported from @pkg/entities
// Re-export for backward compatibility
export { BriefResponse, BriefItem, BriefState, BriefItemType, BriefSourceType } from '@pkg/entities';

// ============================================
// Act API Types (Phase A: Act command)
// ============================================

export interface ActRequestDto {
  instruction: string;
}

export interface ActActionDto {
  type: 'draft_created' | 'message_sent' | 'approval_rejected' | 'followup_created';
  entityId?: string;
  entityName?: string;
  details?: string;
}

export interface ActResponseData {
  result: string;
  actions: ActActionDto[];
  toolsUsed: string[];
}

export interface ActResponse {
  success: boolean;
  data: ActResponseData;
  error?: string;
}

// ============================================
// Fact Conflict API Types
// ============================================

export interface FactConflictResolutionResult {
  success: boolean;
  action: 'used_new' | 'kept_old' | 'created_both';
  factId?: string;
  error?: string;
}

@Injectable()
export class PkgCoreApiService {
  private readonly logger = new Logger(PkgCoreApiService.name);
  private readonly client: AxiosInstance;
  private readonly retryAttempts: number;
  private readonly retryDelay: number;

  constructor(private configService: ConfigService) {
    const baseURL = this.configService.get<string>('api.pkgCoreUrl', 'http://localhost:3000/api/v1');
    const timeout = this.configService.get<number>('api.timeout', 30000);
    const apiKey = this.configService.get<string>('api.pkgCoreApiKey');

    this.retryAttempts = this.configService.get<number>('api.retryAttempts', 3);
    this.retryDelay = this.configService.get<number>('api.retryDelay', 1000);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (apiKey) {
      headers['X-API-Key'] = apiKey;
    }

    this.client = axios.create({
      baseURL,
      timeout,
      headers,
    });

    this.logger.log(`PKG Core API client configured: ${baseURL}`);
  }

  async sendMessage(payload: MessagePayload): Promise<MessageResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<MessageResponse>('/messages', payload);
      return response.data;
    });
  }

  async checkHealth(): Promise<HealthResponse> {
    const response = await this.client.get<HealthResponse>('/health');
    return response.data;
  }

  /**
   * Report membership change (join/leave) to PKG Core
   */
  async reportMembershipChange(payload: MembershipChangePayload): Promise<void> {
    return this.withRetry(async () => {
      await this.client.post('/group-memberships/change', payload);
    });
  }

  /**
   * Get statistics for all Telegram chats (for import optimization).
   * Returns telegram_chat_id, last message info, and message count.
   */
  async getChatStats(): Promise<ChatStatsResponse> {
    const response = await this.client.get<ChatStatsResponse>('/interactions/chat-stats');
    return response.data;
  }

  // ============================================
  // Second Brain Agent API Methods
  // ============================================

  /**
   * Recall - natural language search through past conversations
   * @param query Natural language query
   * @param timeout Optional timeout in ms (default: 120000 for agent operations)
   * @param model Optional Claude model (haiku, sonnet, opus)
   */
  async recall(
    query: string,
    timeout = 120000,
    model?: 'haiku' | 'sonnet' | 'opus',
  ): Promise<RecallResponse> {
    return this.withRetry(async () => {
      const body: { query: string; model?: string } = { query };
      if (model) {
        body.model = model;
      }
      const response = await this.client.post<RecallResponse>(
        '/agent/recall',
        body,
        { timeout },
      );
      return response.data;
    });
  }

  /**
   * Prepare - get briefing before meeting with a person/organization
   * @param entityId UUID of the entity
   * @param timeout Optional timeout in ms (default: 120000 for agent operations)
   */
  async prepare(entityId: string, timeout = 120000): Promise<PrepareResponse> {
    return this.withRetry(async () => {
      const response = await this.client.get<PrepareResponse>(
        `/agent/prepare/${entityId}`,
        { timeout },
      );
      return response.data;
    });
  }

  /**
   * Search entities by name
   * @param search Search query
   * @param limit Max results (default: 5)
   */
  async searchEntities(search: string, limit = 5): Promise<EntitiesResponse> {
    return this.withRetry(async () => {
      const response = await this.client.get<EntitiesResponse>('/entities', {
        params: { search, limit },
      });
      return response.data;
    });
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        if (axios.isAxiosError(error)) {
          const axiosError = error as AxiosError;

          // Don't retry on client errors (4xx)
          if (axiosError.response && axiosError.response.status >= 400 && axiosError.response.status < 500) {
            this.logger.error(
              `Client error (${axiosError.response.status}): ${JSON.stringify(axiosError.response.data)}`,
            );
            throw error;
          }
        }

        if (attempt < this.retryAttempts) {
          this.logger.warn(`Attempt ${attempt} failed, retrying in ${this.retryDelay}ms...`);
          await this.sleep(this.retryDelay * attempt);
        }
      }
    }

    this.logger.error(`All ${this.retryAttempts} attempts failed`);
    throw lastError;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ============================================
  // Extracted Events API Methods
  // ============================================

  /**
   * Confirm an extracted event and create corresponding entity/reminder
   */
  async confirmExtractedEvent(eventId: string): Promise<ExtractedEventActionResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<ExtractedEventActionResponse>(
        `/extracted-events/${eventId}/confirm`,
      );
      return response.data;
    });
  }

  /**
   * Reject an extracted event (mark as ignored)
   */
  async rejectExtractedEvent(eventId: string): Promise<ExtractedEventActionResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<ExtractedEventActionResponse>(
        `/extracted-events/${eventId}/reject`,
      );
      return response.data;
    });
  }

  /**
   * Create a reminder for an extracted event (+7 days)
   */
  async remindExtractedEvent(eventId: string): Promise<RemindResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<RemindResponse>(
        `/extracted-events/${eventId}/remind`,
      );
      return response.data;
    });
  }

  /**
   * Reschedule an extracted event by specified number of days
   */
  async rescheduleExtractedEvent(eventId: string, days: number): Promise<RescheduleResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<RescheduleResponse>(
        `/extracted-events/${eventId}/reschedule`,
        { days },
      );
      return response.data;
    });
  }

  /**
   * Get event IDs from Redis by digest short ID.
   * Used for batch actions on digest notifications.
   */
  async getDigestEventIds(shortId: string): Promise<string[] | null> {
    try {
      const response = await this.client.get<{ eventIds: string[] | null }>(
        `/digest-actions/${shortId}`,
      );
      return response.data.eventIds;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null; // Short ID not found or expired
      }
      throw error;
    }
  }

  // ============================================
  // Carousel API Methods
  // ============================================

  /**
   * Navigate to next event in carousel
   */
  async carouselNext(carouselId: string): Promise<CarouselNavResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<CarouselNavResponse>(
        `/carousel/${carouselId}/next`,
      );
      return response.data;
    });
  }

  /**
   * Navigate to previous event in carousel
   */
  async carouselPrev(carouselId: string): Promise<CarouselNavResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<CarouselNavResponse>(
        `/carousel/${carouselId}/prev`,
      );
      return response.data;
    });
  }

  /**
   * Confirm current carousel event and navigate to next
   */
  async carouselConfirm(carouselId: string): Promise<CarouselNavResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<CarouselNavResponse>(
        `/carousel/${carouselId}/confirm`,
      );
      return response.data;
    });
  }

  /**
   * Reject current carousel event and navigate to next
   */
  async carouselReject(carouselId: string): Promise<CarouselNavResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<CarouselNavResponse>(
        `/carousel/${carouselId}/reject`,
      );
      return response.data;
    });
  }

  // ============================================
  // Message Approval API Methods (Phase A: Act)
  // ============================================

  /**
   * Approve and send message via userbot
   */
  async approveAndSend(approvalId: string): Promise<ApprovalResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<ApprovalResponse>(
        `/approvals/${approvalId}/approve`,
      );
      return response.data;
    });
  }

  /**
   * Reject/cancel approval
   */
  async rejectApproval(approvalId: string): Promise<ApprovalResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<ApprovalResponse>(
        `/approvals/${approvalId}/reject`,
      );
      return response.data;
    });
  }

  /**
   * Set edit mode for approval
   */
  async setApprovalEditMode(
    approvalId: string,
    mode: 'describe' | 'verbatim',
  ): Promise<ApprovalResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<ApprovalResponse>(
        `/approvals/${approvalId}/edit-mode`,
        { mode },
      );
      return response.data;
    });
  }

  /**
   * Update approval text (verbatim edit mode)
   */
  async updateApprovalText(approvalId: string, text: string): Promise<ApprovalResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<ApprovalResponse>(
        `/approvals/${approvalId}/update-text`,
        { text },
      );
      return response.data;
    });
  }

  /**
   * Regenerate approval text based on description (describe edit mode)
   */
  async regenerateApprovalText(
    approvalId: string,
    description: string,
  ): Promise<ApprovalResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<ApprovalResponse>(
        `/approvals/${approvalId}/regenerate`,
        { description },
      );
      return response.data;
    });
  }

  // ============================================
  // Act API Methods (Phase A: Act command)
  // ============================================

  /**
   * Execute an action instruction via Claude agent
   * @param instruction Natural language instruction (e.g., "напиши Сергею что встреча переносится")
   * @param timeout Optional timeout in ms (default: 120000 for agent operations)
   */
  async act(instruction: string, timeout = 120000): Promise<ActResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<ActResponse>(
        '/agent/act',
        { instruction } as ActRequestDto,
        { timeout },
      );
      return response.data;
    });
  }

  // ============================================
  // Notification Trigger API Methods
  // ============================================

  /**
   * Trigger morning brief
   */
  async triggerMorningBrief(): Promise<{ success: boolean; message: string }> {
    return this.withRetry(async () => {
      const response = await this.client.post<{ success: boolean; message: string }>(
        '/notifications/trigger/morning-brief',
      );
      return response.data;
    });
  }

  /**
   * Trigger hourly digest (pending events)
   */
  async triggerHourlyDigest(): Promise<{ success: boolean; message: string }> {
    return this.withRetry(async () => {
      const response = await this.client.post<{ success: boolean; message: string }>(
        '/notifications/trigger/hourly-digest',
      );
      return response.data;
    });
  }

  /**
   * Trigger daily digest
   */
  async triggerDailyDigest(): Promise<{ success: boolean; message: string }> {
    return this.withRetry(async () => {
      const response = await this.client.post<{ success: boolean; message: string }>(
        '/notifications/trigger/daily-digest',
      );
      return response.data;
    });
  }

  // ============================================
  // Brief API Methods (Morning Brief Accordion)
  // ============================================

  /**
   * Get brief state
   * @param briefId Brief ID
   * @param timeout Optional timeout in ms (default: 10000)
   */
  async getBrief(briefId: string, timeout = 10000): Promise<BriefResponse> {
    return this.withRetry(async () => {
      const response = await this.client.get<BriefResponse>(`/brief/${briefId}`, { timeout });
      return response.data;
    });
  }

  /**
   * Expand an item in the brief
   * @param briefId Brief ID
   * @param index Item index (0-based)
   * @param timeout Optional timeout in ms (default: 10000)
   */
  async briefExpand(briefId: string, index: number, timeout = 10000): Promise<BriefResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<BriefResponse>(
        `/brief/${briefId}/expand/${index}`,
        {},
        { timeout },
      );
      return response.data;
    });
  }

  /**
   * Collapse all items in the brief
   * @param briefId Brief ID
   * @param timeout Optional timeout in ms (default: 10000)
   */
  async briefCollapse(briefId: string, timeout = 10000): Promise<BriefResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<BriefResponse>(
        `/brief/${briefId}/collapse`,
        {},
        { timeout },
      );
      return response.data;
    });
  }

  /**
   * Mark item as done (completed)
   * @param briefId Brief ID
   * @param index Item index (0-based)
   * @param timeout Optional timeout in ms (default: 10000)
   */
  async briefMarkDone(briefId: string, index: number, timeout = 10000): Promise<BriefResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<BriefResponse>(
        `/brief/${briefId}/done/${index}`,
        {},
        { timeout },
      );
      return response.data;
    });
  }

  /**
   * Mark item as dismissed (not going to do)
   * @param briefId Brief ID
   * @param index Item index (0-based)
   * @param timeout Optional timeout in ms (default: 10000)
   */
  async briefMarkDismissed(briefId: string, index: number, timeout = 10000): Promise<BriefResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<BriefResponse>(
        `/brief/${briefId}/dismiss/${index}`,
        {},
        { timeout },
      );
      return response.data;
    });
  }

  /**
   * Trigger action for an item (write, remind, prepare)
   * @param briefId Brief ID
   * @param index Item index (0-based)
   * @param actionType Action type
   * @param timeout Optional timeout in ms (default: 10000)
   */
  async briefAction(
    briefId: string,
    index: number,
    actionType: 'write' | 'remind' | 'prepare',
    timeout = 10000,
  ): Promise<BriefResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<BriefResponse>(
        `/brief/${briefId}/action/${index}`,
        { actionType },
        { timeout },
      );
      return response.data;
    });
  }

  // ============================================
  // Fact Conflict API Methods
  // ============================================

  /**
   * Resolve a fact conflict.
   * @param shortId Short ID from callback_data
   * @param resolution Resolution type: 'new' | 'old' | 'both'
   */
  async resolveFactConflict(
    shortId: string,
    resolution: 'new' | 'old' | 'both',
  ): Promise<FactConflictResolutionResult> {
    return this.withRetry(async () => {
      const response = await this.client.post<FactConflictResolutionResult>(
        `/fact-conflicts/${shortId}/${resolution}`,
      );
      return response.data;
    });
  }

  // ============================================
  // Daily Summary API Methods
  // ============================================

  /**
   * Get owner entity ("me")
   */
  async getOwnerEntity(): Promise<{ id: string; name: string } | null> {
    try {
      const response = await this.client.get<{ id: string; name: string }>('/entities/me');
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Save daily summary as a fact for owner entity
   * @param content Summary content to save
   * @param dateStr Date string for the summary (e.g., "28 января 2025")
   */
  async saveDailySummary(
    content: string,
    dateStr: string,
  ): Promise<{ success: boolean; factId?: string; error?: string }> {
    try {
      // Get owner entity
      const owner = await this.getOwnerEntity();
      if (!owner) {
        return { success: false, error: 'Owner entity not found' };
      }

      // Create fact with daily_summary type
      const response = await this.client.post<{ id: string }>(
        `/entities/${owner.id}/facts`,
        {
          type: 'daily_summary',
          category: 'personal',
          value: content.slice(0, 500), // Short preview
          valueJson: {
            fullContent: content,
            dateStr,
            savedAt: new Date().toISOString(),
          },
          source: 'extracted',
          confidence: 1.0,
        },
      );

      return { success: true, factId: response.data.id };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to save daily summary: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }
}
