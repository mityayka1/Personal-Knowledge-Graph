import { Injectable, Logger } from '@nestjs/common';
import { PendingFactService } from '../resolution/pending-fact/pending-fact.service';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';

export interface ExtractedFact {
  factType: string;
  value: string;
  confidence: number;
  sourceQuote: string;
}

export interface ExtractionResult {
  entityId: string;
  facts: ExtractedFact[];
  tokensUsed?: number;
}

// JSON Schema for structured output
const FACTS_SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          factType: { type: 'string' },
          value: { type: 'string' },
          confidence: { type: 'number' },
          sourceQuote: { type: 'string' },
        },
        required: ['factType', 'value', 'confidence', 'sourceQuote'],
      },
    },
  },
  required: ['facts'],
};

interface FactsExtractionResponse {
  facts: ExtractedFact[];
}

@Injectable()
export class FactExtractionService {
  private readonly logger = new Logger(FactExtractionService.name);

  constructor(
    private pendingFactService: PendingFactService,
    private claudeAgentService: ClaudeAgentService,
  ) {}

  /**
   * Extract facts from message - optimized for token economy
   */
  async extractFacts(params: {
    entityId: string;
    entityName: string;
    messageContent: string;
    messageId?: string;
    interactionId?: string;
  }): Promise<ExtractionResult> {
    const { entityId, entityName, messageContent, messageId, interactionId } = params;

    // Skip very short messages
    if (messageContent.length < 20) {
      return { entityId, facts: [] };
    }

    // Truncate very long messages to save tokens
    const truncatedContent = messageContent.length > 1500
      ? messageContent.substring(0, 1500) + '...'
      : messageContent;

    const prompt = this.buildCompactPrompt(entityName, truncatedContent);

    try {
      const { data, usage } = await this.claudeAgentService.call<FactsExtractionResponse>({
        mode: 'oneshot',
        taskType: 'fact_extraction',
        prompt,
        schema: FACTS_SCHEMA,
        model: 'haiku',
        maxTurns: 5,
        referenceType: 'message',
        referenceId: messageId,
        timeout: 60000,
      });

      const rawFacts = data.facts || [];

      // Filter and normalize facts
      const validFacts = rawFacts
        .filter(f => f.factType && f.value && typeof f.confidence === 'number' && f.confidence >= 0.6)
        .map(f => ({
          factType: f.factType.toLowerCase(),
          value: String(f.value).trim(),
          confidence: Math.min(1, Math.max(0, f.confidence)),
          sourceQuote: String(f.sourceQuote || '').substring(0, 200),
        }));

      // Try to save extracted facts as pending (don't fail if save fails)
      for (const fact of validFacts) {
        try {
          await this.pendingFactService.create({
            entityId,
            factType: fact.factType,
            value: fact.value,
            confidence: fact.confidence,
            sourceQuote: fact.sourceQuote,
            sourceMessageId: messageId,
            sourceInteractionId: interactionId,
          });
        } catch (saveError) {
          const msg = saveError instanceof Error ? saveError.message : String(saveError);
          this.logger.warn(`Failed to save pending fact: ${msg}`);
        }
      }

      this.logger.log(`Extracted ${validFacts.length} facts for ${entityName}`);
      return {
        entityId,
        facts: validFacts,
        tokensUsed: usage.inputTokens + usage.outputTokens,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Extraction failed: ${message}`);
      return { entityId, facts: [] };
    }
  }

  /**
   * Batch extract from multiple messages - more efficient
   */
  async extractFactsBatch(params: {
    entityId: string;
    entityName: string;
    messages: Array<{ id: string; content: string; interactionId?: string }>;
  }): Promise<ExtractionResult> {
    const { entityId, entityName, messages } = params;

    // Combine messages into single context
    const combined = messages
      .map((m, i) => `[${i + 1}] ${m.content}`)
      .join('\n---\n')
      .substring(0, 3000); // Limit total size

    const prompt = this.buildBatchPrompt(entityName, combined);

    try {
      const { data, usage } = await this.claudeAgentService.call<FactsExtractionResponse>({
        mode: 'oneshot',
        taskType: 'fact_extraction',
        prompt,
        schema: FACTS_SCHEMA,
        model: 'haiku',
        maxTurns: 5,
        timeout: 90000,
      });

      const rawFacts = data.facts || [];

      // Filter and normalize facts
      const validFacts = rawFacts
        .filter(f => f.factType && f.value && typeof f.confidence === 'number' && f.confidence >= 0.6)
        .map(f => ({
          factType: f.factType.toLowerCase(),
          value: String(f.value).trim(),
          confidence: Math.min(1, Math.max(0, f.confidence)),
          sourceQuote: String(f.sourceQuote || '').substring(0, 200),
        }));

      for (const fact of validFacts) {
        await this.pendingFactService.create({
          entityId,
          factType: fact.factType,
          value: fact.value,
          confidence: fact.confidence,
          sourceQuote: fact.sourceQuote,
          sourceInteractionId: messages[0]?.interactionId,
        });
      }

      return {
        entityId,
        facts: validFacts,
        tokensUsed: usage.inputTokens + usage.outputTokens,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Batch extraction failed: ${message}`);
      return { entityId, facts: [] };
    }
  }

  /**
   * Compact prompt for single message
   */
  private buildCompactPrompt(name: string, text: string): string {
    const cleanText = text.replace(/\n/g, ' ').substring(0, 500);
    return `Извлеки факты о ${name}. Типы фактов: position (должность), company (компания), department (отдел), phone, email, telegram.
ВАЖНО: Все значения фактов должны быть на русском языке.

Текст: ${cleanText}`;
  }

  /**
   * Batch prompt for multiple messages
   */
  private buildBatchPrompt(name: string, text: string): string {
    const cleanText = text.replace(/\n/g, ' ').substring(0, 1000);
    return `Извлеки факты о ${name}. Удали дубликаты. Типы фактов: position (должность), company (компания), department (отдел), phone, email, telegram.
ВАЖНО: Все значения фактов должны быть на русском языке.

Сообщения: ${cleanText}`;
  }
}
