import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  InteractionSummary,
  Interaction,
  Message,
  Decision,
  ActionItem,
  ImportantMessageRef,
  ToneType,
} from '@pkg/entities';
import { ClaudeCliService } from '../claude-cli/claude-cli.service';
import { SchemaLoaderService } from '../claude-cli/schema-loader.service';

// Result from Claude CLI
interface SummarizationResult {
  summary: string;
  keyPoints: string[];
  tone: ToneType;
  decisions: Decision[];
  actionItems: ActionItem[];
  importantMessageIds?: string[];
}

// Message with importance score
interface ScoredMessage extends Message {
  score: number;
  reason?: string;
}

@Injectable()
export class SummarizationService {
  private readonly logger = new Logger(SummarizationService.name);
  private readonly schema: object;

  constructor(
    @InjectRepository(InteractionSummary)
    private summaryRepo: Repository<InteractionSummary>,
    @InjectRepository(Interaction)
    private interactionRepo: Repository<Interaction>,
    @InjectRepository(Message)
    private messageRepo: Repository<Message>,
    private claudeCliService: ClaudeCliService,
    private schemaLoader: SchemaLoaderService,
    @InjectQueue('summarization')
    private summarizationQueue: Queue,
  ) {
    this.schema = this.schemaLoader.load('summarization', this.getInlineSchema());
  }

  /**
   * Daily cron job: schedule summarization for old completed interactions
   * Runs at 03:00 Moscow time
   */
  @Cron('0 3 * * *', { timeZone: 'Europe/Moscow' })
  async scheduleDailySummarization(): Promise<void> {
    this.logger.log('Starting daily summarization scheduling...');

    // Find completed interactions older than 7 days without summaries
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 7);

    const interactions = await this.interactionRepo
      .createQueryBuilder('i')
      .where('i.status = :status', { status: 'completed' })
      .andWhere('i.ended_at < :cutoff', { cutoff: cutoffDate })
      .andWhere(`NOT EXISTS (
        SELECT 1 FROM interaction_summaries s WHERE s.interaction_id = i.id
      )`)
      .orderBy('i.ended_at', 'ASC')
      .limit(20)
      .getMany();

    for (const interaction of interactions) {
      await this.summarizationQueue.add('summarize', {
        interactionId: interaction.id,
      }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60000 },
      });
    }

    this.logger.log(`Scheduled ${interactions.length} interactions for summarization`);
  }

  /**
   * Process summarization for a single interaction
   */
  async processSummarization(interactionId: string): Promise<InteractionSummary | null> {
    // Check if already summarized (race condition protection)
    const existing = await this.summaryRepo.findOne({
      where: { interactionId },
    });
    if (existing) {
      this.logger.debug(`Interaction ${interactionId} already summarized`);
      return existing;
    }

    // Fetch interaction with participants
    const interaction = await this.interactionRepo.findOne({
      where: { id: interactionId },
      relations: ['participants', 'participants.entity'],
    });

    if (!interaction) {
      throw new Error(`Interaction ${interactionId} not found`);
    }

    // Fetch messages
    const messages = await this.messageRepo.find({
      where: { interactionId },
      order: { timestamp: 'ASC' },
      take: 500,
    });

    if (messages.length < 3) {
      this.logger.debug(`Interaction ${interactionId} has < 3 messages, skipping`);
      return null;
    }

    // Score messages for importance
    const scoredMessages = this.scoreMessages(messages);

    // Build prompt and call Claude
    const prompt = this.buildPrompt(interaction, scoredMessages);

    const { data, run } = await this.claudeCliService.call<SummarizationResult>({
      taskType: 'summarization',
      agentName: 'summarizer',
      prompt,
      schema: this.schema,
      model: 'sonnet',
      referenceType: 'interaction',
      referenceId: interactionId,
    });

    // Extract important messages
    const importantMessages = this.extractImportantMessages(
      scoredMessages,
      data.importantMessageIds || [],
    );

    // Calculate metrics
    const sourceTokenCount = this.estimateTokens(prompt);
    const summaryTokenCount = this.estimateTokens(JSON.stringify(data));

    // Save summary
    const summary = this.summaryRepo.create({
      interactionId,
      summaryText: data.summary,
      keyPoints: data.keyPoints,
      tone: data.tone,
      decisions: data.decisions || [],
      actionItems: data.actionItems || [],
      importantMessages,
      messageCount: messages.length,
      sourceTokenCount,
      summaryTokenCount,
      compressionRatio: summaryTokenCount > 0 ? sourceTokenCount / summaryTokenCount : null,
      modelVersion: run.model,
      generationCostUsd: run.costUsd,
    });

    await this.summaryRepo.save(summary);

    // Update message importance scores
    await this.updateMessageImportance(scoredMessages);

    this.logger.log(
      `Summarized interaction ${interactionId}: ` +
      `${messages.length} msgs → ${data.keyPoints.length} points, ` +
      `compression ${summary.compressionRatio?.toFixed(1)}x`
    );

    return summary;
  }

  /**
   * Score messages for importance based on patterns
   */
  private scoreMessages(messages: Message[]): ScoredMessage[] {
    // Patterns for importance detection
    const DATE_PATTERN = /\d{1,2}[.\/]\d{1,2}|\d{1,2}\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)|завтра|послезавтра|в\s+(понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)/i;
    const AMOUNT_PATTERN = /\d+[kкКK]|\$\d+|€\d+|\d+\s*(руб|рублей|долларов|евро|usd|eur)/i;
    const AGREEMENT_PATTERN = /договорились|согласен|\bокей\b|\bок\b|хорошо[,.]?\s*сделаю|принято|\bdeal\b|договор/i;
    const DEADLINE_PATTERN = /дедлайн|срок|до\s+\d|крайний срок|deadline/i;

    return messages.map(msg => {
      let score = 0;
      let reason: string | undefined;
      const text = msg.content || '';

      if (DATE_PATTERN.test(text)) { score += 0.3; reason = 'has_date'; }
      if (AMOUNT_PATTERN.test(text)) { score += 0.3; reason = reason || 'has_amount'; }
      if (AGREEMENT_PATTERN.test(text)) { score += 0.4; reason = reason || 'has_agreement'; }
      if (DEADLINE_PATTERN.test(text)) { score += 0.3; reason = reason || 'has_deadline'; }
      if (text.length > 300) { score += 0.2; reason = reason || 'long_message'; }

      return { ...msg, score: Math.min(score, 1), reason } as ScoredMessage;
    });
  }

  /**
   * Build prompt for Claude summarization
   */
  private buildPrompt(interaction: Interaction, messages: ScoredMessage[]): string {
    const otherParticipant = interaction.participants?.find(p => p.role !== 'self');
    const entityName = otherParticipant?.entity?.name || otherParticipant?.displayName || 'Собеседник';

    const formattedMessages = messages
      .map((m) => {
        const sender = m.isOutgoing ? 'Я' : entityName;
        const importance = m.score > 0.5 ? ' [!]' : '';
        return `[${m.id}] ${sender}${importance}: ${m.content || '(медиа)'}`;
      })
      .join('\n\n');

    return `## Участники
- Я (пользователь PKG)
- Собеседник: ${entityName}

## Переписка
${formattedMessages}

## Задача
Создай структурированное резюме переписки согласно JSON схеме.`;
  }

  /**
   * Extract important messages based on scoring and LLM selection
   */
  private extractImportantMessages(
    messages: ScoredMessage[],
    llmSelectedIds: string[],
  ): ImportantMessageRef[] {
    return messages
      .filter(m => m.score >= 0.5 || llmSelectedIds.includes(m.id))
      .map(m => ({
        messageId: m.id,
        content: (m.content || '').slice(0, 200),
        timestamp: m.timestamp.toISOString(),
        reason: this.mapReason(m.reason),
      }));
  }

  private mapReason(reason?: string): ImportantMessageRef['reason'] {
    switch (reason) {
      case 'has_agreement': return 'agreement';
      case 'has_deadline': return 'deadline';
      case 'has_date': return 'important_info';
      case 'has_amount': return 'decision';
      default: return 'important_info';
    }
  }

  /**
   * Estimate token count (rough approximation)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Update message importance scores in database
   */
  private async updateMessageImportance(messages: ScoredMessage[]): Promise<void> {
    const updates = messages.filter(m => m.score > 0);
    if (updates.length === 0) return;

    // Batch update in chunks
    const chunkSize = 100;
    for (let i = 0; i < updates.length; i += chunkSize) {
      const chunk = updates.slice(i, i + chunkSize);
      await Promise.all(
        chunk.map(u =>
          this.messageRepo.update(u.id, {
            importanceScore: u.score,
            importanceReason: u.reason as Message['importanceReason'] || null,
          })
        )
      );
    }
  }

  /**
   * Inline schema fallback
   */
  private getInlineSchema(): object {
    return {
      type: 'object',
      properties: {
        summary: { type: 'string', minLength: 10 },
        keyPoints: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 7 },
        tone: { type: 'string', enum: ['positive', 'neutral', 'negative', 'formal', 'informal'] },
        decisions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              date: { type: ['string', 'null'] },
              importance: { type: 'string', enum: ['high', 'medium', 'low'] },
              quote: { type: ['string', 'null'] },
            },
            required: ['description', 'importance'],
          },
        },
        actionItems: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              owner: { type: 'string', enum: ['self', 'them', 'both'] },
              status: { type: 'string', enum: ['open', 'closed'] },
              dueDate: { type: ['string', 'null'] },
            },
            required: ['description', 'owner', 'status'],
          },
        },
        importantMessageIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary', 'keyPoints', 'tone', 'decisions', 'actionItems'],
    };
  }
}
