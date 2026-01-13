import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosError } from 'axios';

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
}
