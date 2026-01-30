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
  /** Session ID for follow-up operations */
  sessionId: string;
  answer: string;
  sources: RecallSource[];
  toolsUsed: string[];
}

/** Session data from PKG Core */
export interface RecallSessionData {
  sessionId: string;
  query: string;
  dateStr: string;
  answer: string;
  sources: RecallSource[];
  model?: 'haiku' | 'sonnet' | 'opus';
  createdAt: number;
}

export interface RecallSessionResponse {
  success: boolean;
  data: RecallSessionData;
}

/** Request for saving recall session insights */
export interface RecallSaveRequest {
  userId?: string;
}

/** Response from save recall session endpoint */
export interface RecallSaveResponse {
  success: boolean;
  factId?: string;
  alreadySaved?: boolean;
  error?: string;
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

// Telegram inline keyboard button types
export type TelegramCallbackButton = { text: string; callback_data: string };
export type TelegramWebAppButton = { text: string; web_app: { url: string } };
export type TelegramInlineButton = TelegramCallbackButton | TelegramWebAppButton;

export interface CarouselNavResponse {
  success: boolean;
  complete: boolean;
  message?: string;
  buttons?: Array<Array<TelegramInlineButton>>;
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

// ============================================
// Daily Synthesis Extraction API Types (Phase 2: Jarvis)
// ============================================

export interface ExtractedProject {
  name: string;
  isNew: boolean;
  existingActivityId?: string;
  participants: string[];
  client?: string;
  status?: string;
  sourceQuote?: string;
  confidence: number;
}

export interface ExtractedTask {
  title: string;
  projectName?: string;
  deadline?: string;
  assignee?: string;
  status: 'pending' | 'in_progress' | 'done';
  priority?: 'high' | 'medium' | 'low';
  confidence: number;
}

export interface ExtractedCommitment {
  what: string;
  from: string;
  to: string;
  deadline?: string;
  type: 'promise' | 'request' | 'agreement' | 'deadline' | 'reminder';
  priority?: 'high' | 'medium' | 'low';
  confidence: number;
}

export interface InferredRelation {
  type: 'project_member' | 'works_on' | 'client_of' | 'responsible_for';
  entities: string[];
  activityName?: string;
  confidence: number;
}

export interface DailyExtractRequestDto {
  synthesisText: string;
  date?: string;
  focusTopic?: string;
}

export interface DailyExtractResponseData {
  projects: ExtractedProject[];
  tasks: ExtractedTask[];
  commitments: ExtractedCommitment[];
  inferredRelations: InferredRelation[];
  extractionSummary: string;
  tokensUsed: number;
  durationMs: number;
}

export interface DailyExtractResponse {
  success: boolean;
  data: DailyExtractResponseData;
}

// ============================================
// Extraction Carousel API Types (Phase 2.5: Jarvis)
// ============================================

export interface ExtractionCarouselItem {
  id: string;
  type: 'project' | 'task' | 'commitment';
  data: ExtractedProject | ExtractedTask | ExtractedCommitment;
}

export interface CreateExtractionCarouselDto {
  chatId: string;
  messageId: number;
  projects: ExtractedProject[];
  tasks: ExtractedTask[];
  commitments: ExtractedCommitment[];
  synthesisDate?: string;
  focusTopic?: string;
}

export interface CreateExtractionCarouselResponse {
  success: boolean;
  carouselId?: string;
  total?: number;
  message?: string;
  buttons?: Array<Array<TelegramInlineButton>>;
  error?: string;
}

export interface ExtractionCarouselNavResponse {
  success: boolean;
  complete: boolean;
  item?: ExtractionCarouselItem;
  message?: string;
  buttons?: Array<Array<TelegramInlineButton>>;
  chatId?: string;
  messageId?: number;
  index?: number;
  total?: number;
  remaining?: number;
  error?: string;
}

export interface ExtractionCarouselStatsResponse {
  success: boolean;
  stats?: {
    total: number;
    processed: number;
    confirmed: number;
    skipped: number;
    confirmedByType: { projects: number; tasks: number; commitments: number };
  };
  error?: string;
}

export interface ExtractionCarouselConfirmedResponse {
  success: boolean;
  projects?: ExtractedProject[];
  tasks?: ExtractedTask[];
  commitments?: ExtractedCommitment[];
  error?: string;
}

export interface PersistExtractionDto {
  ownerEntityId: string;
}

export interface PersistExtractionResult {
  activityIds: string[];
  commitmentIds: string[];
  projectsCreated: number;
  tasksCreated: number;
  commitmentsCreated: number;
  errors: Array<{ item: string; error: string }>;
}

export interface PersistExtractionResponse {
  success: boolean;
  result?: PersistExtractionResult;
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

  // ============================================
  // Recall Session API Methods
  // ============================================

  /**
   * Get recall session data by session ID.
   * Session contains LLM synthesis results for follow-up operations.
   *
   * @param sessionId Session ID from recall response (e.g., "rs_a1b2c3d4e5f6")
   */
  async getRecallSession(sessionId: string): Promise<RecallSessionResponse | null> {
    try {
      const response = await this.client.get<RecallSessionResponse>(
        `/agent/recall/session/${sessionId}`,
      );
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null; // Session not found or expired
      }
      throw error;
    }
  }

  /**
   * Continue conversation in context of existing recall session.
   * Uses session's sources as context for follow-up query.
   *
   * @param sessionId Session ID from recall response
   * @param query Follow-up question
   * @param model Optional Claude model (inherits from session if not specified)
   * @param timeout Optional timeout in ms (default: 120000)
   */
  async followupRecall(
    sessionId: string,
    query: string,
    model?: 'haiku' | 'sonnet' | 'opus',
    timeout = 120000,
  ): Promise<RecallResponse> {
    return this.withRetry(async () => {
      const body: { query: string; model?: string } = { query };
      if (model) {
        body.model = model;
      }
      const response = await this.client.post<RecallResponse>(
        `/agent/recall/session/${sessionId}/followup`,
        body,
        { timeout },
      );
      return response.data;
    });
  }

  /**
   * Extract structured data from recall session synthesis.
   * Extracts projects, tasks, commitments from the session's answer.
   *
   * @param sessionId Session ID from recall response
   * @param focusTopic Optional focus topic for extraction
   * @param model Optional Claude model (default: sonnet)
   * @param timeout Optional timeout in ms (default: 120000)
   */
  async extractFromSession(
    sessionId: string,
    focusTopic?: string,
    model?: 'haiku' | 'sonnet' | 'opus',
    timeout = 120000,
  ): Promise<DailyExtractResponse> {
    return this.withRetry(async () => {
      const body: { focusTopic?: string; model?: string } = {};
      if (focusTopic) body.focusTopic = focusTopic;
      if (model) body.model = model;

      const response = await this.client.post<DailyExtractResponse>(
        `/agent/recall/session/${sessionId}/extract`,
        body,
        { timeout },
      );
      return response.data;
    });
  }

  /**
   * Save recall session insights as a fact (idempotent).
   * Returns existing factId if already saved, preventing duplicate saves.
   *
   * @param sessionId Session ID from recall response
   * @param userId Optional user ID for verification (multi-user safety)
   */
  async saveRecallSession(
    sessionId: string,
    userId?: string,
  ): Promise<RecallSaveResponse> {
    try {
      const body: RecallSaveRequest = {};
      if (userId) body.userId = userId;

      const response = await this.client.post<RecallSaveResponse>(
        `/agent/recall/session/${sessionId}/save`,
        body,
      );
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 404) {
          return { success: false, error: 'Session not found or expired' };
        }
        if (error.response?.status === 403) {
          return { success: false, error: 'Unauthorized: session belongs to another user' };
        }
      }
      throw error;
    }
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

  // ============================================
  // Daily Synthesis Extraction API Methods (Phase 2: Jarvis)
  // ============================================

  /**
   * Extract structured data from daily synthesis text.
   * Extracts projects, tasks, commitments, and entity relations.
   *
   * @param synthesisText The daily summary text to analyze
   * @param date Optional date of the daily (for context)
   * @param focusTopic Optional focus topic if daily was focused
   * @param timeout Optional timeout in ms (default: 120000 for LLM operations)
   */
  async extractDailySynthesis(
    synthesisText: string,
    date?: string,
    focusTopic?: string,
    timeout = 120000,
  ): Promise<DailyExtractResponse> {
    return this.withRetry(async () => {
      const body: DailyExtractRequestDto = { synthesisText };
      if (date) body.date = date;
      if (focusTopic) body.focusTopic = focusTopic;

      const response = await this.client.post<DailyExtractResponse>(
        '/agent/daily/extract',
        body,
        { timeout },
      );
      return response.data;
    });
  }

  // ============================================
  // Extraction Carousel API Methods (Phase 2.5: Jarvis)
  // ============================================

  /**
   * Create extraction carousel from extraction results.
   * Returns the carousel ID and first item for display.
   */
  async createExtractionCarousel(
    dto: CreateExtractionCarouselDto,
  ): Promise<CreateExtractionCarouselResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<CreateExtractionCarouselResponse>(
        '/extraction-carousel',
        dto,
      );
      return response.data;
    });
  }

  /**
   * Navigate to next item in extraction carousel
   */
  async extractionCarouselNext(
    carouselId: string,
  ): Promise<ExtractionCarouselNavResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<ExtractionCarouselNavResponse>(
        `/extraction-carousel/${carouselId}/next`,
      );
      return response.data;
    });
  }

  /**
   * Navigate to previous item in extraction carousel
   */
  async extractionCarouselPrev(
    carouselId: string,
  ): Promise<ExtractionCarouselNavResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<ExtractionCarouselNavResponse>(
        `/extraction-carousel/${carouselId}/prev`,
      );
      return response.data;
    });
  }

  /**
   * Confirm current item and navigate to next
   */
  async extractionCarouselConfirm(
    carouselId: string,
  ): Promise<ExtractionCarouselNavResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<ExtractionCarouselNavResponse>(
        `/extraction-carousel/${carouselId}/confirm`,
      );
      return response.data;
    });
  }

  /**
   * Skip current item and navigate to next
   */
  async extractionCarouselSkip(
    carouselId: string,
  ): Promise<ExtractionCarouselNavResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<ExtractionCarouselNavResponse>(
        `/extraction-carousel/${carouselId}/skip`,
      );
      return response.data;
    });
  }

  /**
   * Get extraction carousel statistics
   */
  async getExtractionCarouselStats(
    carouselId: string,
  ): Promise<ExtractionCarouselStatsResponse> {
    return this.withRetry(async () => {
      const response = await this.client.get<ExtractionCarouselStatsResponse>(
        `/extraction-carousel/${carouselId}/stats`,
      );
      return response.data;
    });
  }

  /**
   * Get confirmed items from extraction carousel for persistence
   */
  async getExtractionCarouselConfirmed(
    carouselId: string,
  ): Promise<ExtractionCarouselConfirmedResponse> {
    return this.withRetry(async () => {
      const response = await this.client.get<ExtractionCarouselConfirmedResponse>(
        `/extraction-carousel/${carouselId}/confirmed`,
      );
      return response.data;
    });
  }

  /**
   * Persist confirmed extraction items as Activity/Commitment entities
   * Call this when carousel is complete to save confirmed items to database.
   *
   * @param carouselId Carousel ID
   * @param ownerEntityId Owner entity ID (user's entity)
   */
  async persistExtractionCarousel(
    carouselId: string,
    ownerEntityId: string,
  ): Promise<PersistExtractionResponse> {
    return this.withRetry(async () => {
      const response = await this.client.post<PersistExtractionResponse>(
        `/extraction-carousel/${carouselId}/persist`,
        { ownerEntityId } as PersistExtractionDto,
      );
      return response.data;
    });
  }
}
