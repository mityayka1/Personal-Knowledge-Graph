import { Injectable, Logger, Inject, forwardRef, Optional } from '@nestjs/common';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  toolSuccess,
  toolError,
  handleToolError,
  type ToolDefinition,
} from './tool.types';
import { EntityService } from '../../entity/entity.service';
import { EntityEventService } from '../../entity-event/entity-event.service';
import { ContextService } from '../../context/context.service';
import { ClaudeAgentService } from '../claude-agent.service';
import { EventType } from '@pkg/entities';

/**
 * Schema for draft generation
 */
const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string', description: 'Generated message text' },
  },
  required: ['message'],
};

/**
 * Provider for action-related tools (send messages, schedule follow-ups)
 *
 * IMPORTANT: send_telegram does NOT send messages directly.
 * It creates a pending approval that must be confirmed by the user.
 */
@Injectable()
export class ActionToolsProvider {
  private readonly logger = new Logger(ActionToolsProvider.name);
  private cachedTools: ToolDefinition[] | null = null;

  constructor(
    private readonly entityService: EntityService,
    private readonly entityEventService: EntityEventService,
    @Optional()
    @Inject(forwardRef(() => ContextService))
    private readonly contextService: ContextService | null,
    @Optional()
    @Inject(forwardRef(() => ClaudeAgentService))
    private readonly claudeAgentService: ClaudeAgentService | null,
  ) {}

  /**
   * Get action tools (cached)
   */
  getTools(): ToolDefinition[] {
    if (!this.cachedTools) {
      this.cachedTools = this.createTools();
      this.logger.debug(`Created ${this.cachedTools.length} action tools`);
    }
    return this.cachedTools;
  }

  /**
   * Create tool definitions
   */
  private createTools(): ToolDefinition[] {
    return [
      tool(
        'draft_message',
        `Generate a draft message for a contact based on intent and conversation history.
Uses recent chat context to match the communication style and tone.
Returns draft text for user review before sending.
IMPORTANT: Always use this tool before send_telegram to show user what will be sent.`,
        {
          entityId: z.string().uuid().describe('UUID of the recipient entity'),
          intent: z.string().describe(
            'What to communicate (e.g., "remind about documents", "reschedule meeting", "ask about project status")'
          ),
          tone: z.enum(['formal', 'casual', 'friendly']).default('friendly').describe(
            'Desired message tone: "formal" for business, "casual" for acquaintances, "friendly" for friends'
          ),
        },
        async (args) => this.handleDraftMessage(args),
      ),

      tool(
        'send_telegram',
        `Send a Telegram message to a contact.
IMPORTANT: This tool triggers an approval flow - the message is NOT sent immediately.
The user will see the message and must approve it via bot buttons before actual sending.
Always use draft_message first to generate and show the text.`,
        {
          entityId: z.string().uuid().describe('UUID of the recipient entity'),
          text: z.string().min(1).max(4096).describe('Message text to send (max 4096 chars)'),
        },
        async (args) => this.handleSendTelegram(args),
      ),

      tool(
        'schedule_followup',
        `Create a follow-up reminder to check for response from a contact.
Use after sending a message to track if the contact responds.
Creates a reminder event that will appear in morning brief.`,
        {
          entityId: z.string().uuid().describe('UUID of the contact to follow up with'),
          reason: z.string().describe('What to follow up about (e.g., "documents", "meeting confirmation")'),
          checkAfter: z.string().describe(
            'When to check: ISO datetime (e.g., "2025-01-20T14:00:00Z") or relative like "2h", "1d", "3d"'
          ),
        },
        async (args) => this.handleScheduleFollowup(args),
      ),
    ] as ToolDefinition[];
  }

  /**
   * Handle draft_message tool
   */
  private async handleDraftMessage(args: {
    entityId: string;
    intent: string;
    tone: 'formal' | 'casual' | 'friendly';
  }) {
    try {
      const entity = await this.entityService.findOne(args.entityId);

      // Get recent messages for context if ContextService available
      let recentMessages: string[] = [];
      if (this.contextService) {
        try {
          // Get recent messages from context
          const context = await this.contextService.generateContext({
            entityId: args.entityId,
          });
          // Extract recent messages hint from context (simplified)
          recentMessages = this.extractRecentMessagesHint(context.contextMarkdown);
        } catch (error) {
          this.logger.warn(`Failed to get context for draft: ${error}`);
        }
      }

      // Generate draft using LLM
      const draft = await this.generateDraft(
        entity.name,
        args.intent,
        args.tone,
        recentMessages,
      );

      return toolSuccess({
        draft,
        recipient: entity.name,
        entityId: args.entityId,
        tone: args.tone,
        note: 'Review this draft. Use send_telegram with this text to initiate approval flow.',
      });
    } catch (error) {
      return handleToolError(error, this.logger, 'draft_message');
    }
  }

  /**
   * Handle send_telegram tool
   * Creates pending approval, does NOT send directly
   */
  private async handleSendTelegram(args: {
    entityId: string;
    text: string;
  }) {
    try {
      const entity = await this.entityService.findOne(args.entityId);

      // Find Telegram identifier
      const telegramId = entity.identifiers?.find(
        (i) => i.identifierType === 'telegram_user_id',
      );

      if (!telegramId) {
        return toolError(
          `Entity "${entity.name}" has no Telegram identifier`,
          'This contact cannot receive Telegram messages. Check if they have a telegram_user_id.',
        );
      }

      // Return pending status - actual approval is handled by ApprovalService
      return toolSuccess({
        status: 'pending_approval',
        entityId: args.entityId,
        entityName: entity.name,
        text: args.text,
        telegramUserId: telegramId.identifierValue,
        message: `Message to ${entity.name} is pending user approval. User will see this message and can approve, edit, or cancel.`,
      });
    } catch (error) {
      return handleToolError(error, this.logger, 'send_telegram');
    }
  }

  /**
   * Handle schedule_followup tool
   */
  private async handleScheduleFollowup(args: {
    entityId: string;
    reason: string;
    checkAfter: string;
  }) {
    try {
      const entity = await this.entityService.findOne(args.entityId);
      const checkDate = this.parseCheckAfter(args.checkAfter);

      const event = await this.entityEventService.create({
        entityId: args.entityId,
        eventType: EventType.FOLLOW_UP,
        title: `Проверить ответ: ${args.reason}`,
        description: `Follow-up reminder for ${entity.name}`,
        eventDate: checkDate,
      });

      return toolSuccess({
        created: true,
        id: event.id,
        entityName: entity.name,
        checkDate: checkDate.toISOString(),
        message: `Follow-up reminder created. Will appear in morning brief on ${checkDate.toLocaleDateString('ru-RU')}.`,
      });
    } catch (error) {
      return handleToolError(error, this.logger, 'schedule_followup');
    }
  }

  /**
   * Generate draft message using LLM
   */
  private async generateDraft(
    name: string,
    intent: string,
    tone: string,
    recentMessages: string[],
  ): Promise<string> {
    if (!this.claudeAgentService) {
      // Fallback to simple template
      return this.generateSimpleDraft(name, intent, tone);
    }

    const firstName = name.split(' ')[0];
    const greetings: Record<string, string> = {
      formal: 'Добрый день',
      casual: 'Привет',
      friendly: 'Привет',
    };

    const prompt = `Сгенерируй короткое сообщение для ${firstName}.

Задача: ${intent}
Тон: ${tone}

${recentMessages.length > 0 ? `Недавние сообщения (для понимания стиля общения):
${recentMessages.slice(0, 5).map((m) => `- "${m}"`).join('\n')}` : ''}

Требования:
- Краткое (1-3 предложения максимум)
- Естественное, как будто пишет реальный человек
- Соответствует указанному тону
- Без излишних формальностей если casual/friendly
- Если есть история - соответствует стилю общения из неё`;

    try {
      const { data } = await this.claudeAgentService.call<{ message: string }>({
        mode: 'oneshot',
        taskType: 'draft_generation',
        prompt,
        model: 'haiku',
        schema: DRAFT_SCHEMA,
      });

      return data.message;
    } catch (error) {
      this.logger.warn(`LLM draft generation failed, using template: ${error}`);
      return this.generateSimpleDraft(name, intent, tone);
    }
  }

  /**
   * Simple template-based draft generation (fallback)
   */
  private generateSimpleDraft(name: string, intent: string, tone: string): string {
    const firstName = name.split(' ')[0];
    const greetings: Record<string, string> = {
      formal: 'Добрый день',
      casual: 'Привет',
      friendly: 'Привет',
    };

    return `${greetings[tone] || 'Привет'}, ${firstName}! ${intent}`;
  }

  /**
   * Parse checkAfter to Date
   * Supports ISO datetime or relative like "2h", "1d", "3d"
   */
  private parseCheckAfter(checkAfter: string): Date {
    // Try ISO datetime first
    const isoDate = new Date(checkAfter);
    if (!isNaN(isoDate.getTime())) {
      return isoDate;
    }

    // Parse relative time
    const match = checkAfter.match(/^(\d+)(h|d)$/);
    if (!match) {
      throw new Error(
        `Invalid checkAfter format: ${checkAfter}. Use ISO datetime or relative like "2h", "1d".`,
      );
    }

    const [, amount, unit] = match;
    const now = new Date();

    if (unit === 'h') {
      now.setHours(now.getHours() + parseInt(amount, 10));
    } else {
      now.setDate(now.getDate() + parseInt(amount, 10));
    }

    return now;
  }

  /**
   * Extract recent messages hint from context markdown
   */
  private extractRecentMessagesHint(contextMarkdown: string): string[] {
    // Simple extraction - look for lines starting with [date] in HOT section
    const hotSection = contextMarkdown.match(/## HOT:[\s\S]*?(?=##|$)/);
    if (!hotSection) return [];

    const lines = hotSection[0].split('\n');
    const messages: string[] = [];

    for (const line of lines) {
      const match = line.match(/\[\d{4}-\d{2}-\d{2}\] .+: (.+)/);
      if (match) {
        messages.push(match[1].slice(0, 100));
      }
    }

    return messages.slice(0, 10);
  }
}
