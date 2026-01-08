import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface ChatSession {
  lastMessageTimestamp: Date;
  interactionId?: string;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private sessions: Map<string, ChatSession> = new Map();
  private sessionGapThreshold: number;

  constructor(private configService: ConfigService) {
    // Session gap threshold in hours (default 4 hours)
    this.sessionGapThreshold = this.configService.get<number>(
      'telegram.sessionGapThreshold',
      4,
    );
  }

  /**
   * Check if we need to start a new session based on time gap
   * Returns true if a new session should be started
   */
  async checkAndUpdateSession(chatId: string): Promise<boolean> {
    const now = new Date();
    const existingSession = this.sessions.get(chatId);

    if (!existingSession) {
      // First message in this chat
      this.sessions.set(chatId, {
        lastMessageTimestamp: now,
      });
      return true;
    }

    // Calculate time difference in hours
    const timeDiff =
      (now.getTime() - existingSession.lastMessageTimestamp.getTime()) / (1000 * 60 * 60);

    if (timeDiff >= this.sessionGapThreshold) {
      // Gap exceeds threshold, start new session
      this.sessions.set(chatId, {
        lastMessageTimestamp: now,
      });
      this.logger.log(
        `Session gap detected for chat ${chatId}: ${timeDiff.toFixed(2)} hours`,
      );
      return true;
    }

    // Update timestamp for existing session
    existingSession.lastMessageTimestamp = now;
    return false;
  }

  /**
   * Get current interaction ID for a chat
   */
  getInteractionId(chatId: string): string | undefined {
    return this.sessions.get(chatId)?.interactionId;
  }

  /**
   * Set interaction ID for a chat
   */
  setInteractionId(chatId: string, interactionId: string): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.interactionId = interactionId;
    }
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): Map<string, ChatSession> {
    return new Map(this.sessions);
  }

  /**
   * Clear old sessions (cleanup)
   */
  clearOldSessions(maxAgeHours: number = 24): number {
    const now = new Date();
    let cleared = 0;

    for (const [chatId, session] of this.sessions) {
      const ageHours =
        (now.getTime() - session.lastMessageTimestamp.getTime()) / (1000 * 60 * 60);
      if (ageHours > maxAgeHours) {
        this.sessions.delete(chatId);
        cleared++;
      }
    }

    if (cleared > 0) {
      this.logger.log(`Cleared ${cleared} old sessions`);
    }

    return cleared;
  }
}
