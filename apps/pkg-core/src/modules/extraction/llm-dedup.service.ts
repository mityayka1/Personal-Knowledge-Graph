import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';

// --- Interfaces ---

export interface DedupItemInfo {
  type: string; // 'entity' | 'task' | 'commitment' | 'fact'
  name: string;
  description?: string;
  context?: string;
}

export interface DedupExistingItem extends DedupItemInfo {
  id: string;
}

export interface DedupPair {
  newItem: DedupItemInfo;
  existingItem: DedupExistingItem;
  activityContext?: string;
}

export interface DedupLlmDecision {
  isDuplicate: boolean;
  confidence: number;
  mergeIntoId?: string;
  reason: string;
}

// --- LLM response type ---

interface LlmDecisionEntry {
  pairIndex: number;
  isDuplicate: boolean;
  confidence: number;
  reason: string;
}

interface LlmResponse {
  decisions: LlmDecisionEntry[];
}

// --- JSON Schema for structured output ---

const DEDUP_DECISION_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pairIndex: {
            type: 'number',
            description: 'Index of the pair from the list (0-based)',
          },
          isDuplicate: {
            type: 'boolean',
            description: 'true if items are duplicates, false otherwise',
          },
          confidence: {
            type: 'number',
            description: 'Confidence score from 0.0 to 1.0',
          },
          reason: {
            type: 'string',
            description: 'Short explanation of the decision in Russian',
          },
        },
        required: ['pairIndex', 'isDuplicate', 'confidence', 'reason'],
      },
    },
  },
  required: ['decisions'],
};

// --- Service ---

@Injectable()
export class LlmDedupService {
  private readonly logger = new Logger(LlmDedupService.name);

  constructor(
    @Optional()
    @Inject(forwardRef(() => ClaudeAgentService))
    private claudeAgentService: ClaudeAgentService,
  ) {}

  /**
   * Decide whether a single pair of items are duplicates.
   * Delegates to decideBatch for consistent LLM calling.
   */
  async decideDuplicate(pair: DedupPair): Promise<DedupLlmDecision> {
    const results = await this.decideBatch([pair]);
    return results[0];
  }

  /**
   * Decide duplicates for a batch of pairs in a single LLM call.
   * Graceful degradation: returns isDuplicate=false when LLM is unavailable or fails.
   */
  async decideBatch(pairs: DedupPair[]): Promise<DedupLlmDecision[]> {
    if (pairs.length === 0) {
      return [];
    }

    // Graceful degradation: no Claude service available
    if (!this.claudeAgentService) {
      this.logger.warn(
        'ClaudeAgentService is not available, returning non-duplicate for all pairs',
      );
      return pairs.map(() => ({
        isDuplicate: false,
        confidence: 0,
        reason: 'LLM dedup unavailable',
      }));
    }

    try {
      const prompt = this.buildPrompt(pairs);

      const { data } = await this.claudeAgentService.call<LlmResponse>({
        mode: 'oneshot',
        taskType: 'dedup_decision',
        prompt,
        schema: DEDUP_DECISION_SCHEMA,
        model: 'haiku',
      });

      return this.mapDecisions(pairs, data);
    } catch (error: any) {
      this.logger.error(
        `LLM dedup batch failed: ${error.message}`,
        error.stack,
      );
      return pairs.map(() => ({
        isDuplicate: false,
        confidence: 0,
        reason: `LLM dedup failed: ${error.message}`,
      }));
    }
  }

  /**
   * Map LLM response decisions to DedupLlmDecision array,
   * handling missing decisions gracefully.
   */
  private mapDecisions(
    pairs: DedupPair[],
    data: LlmResponse,
  ): DedupLlmDecision[] {
    return pairs.map((pair, index) => {
      const llmDecision = data.decisions?.find(
        (d) => d.pairIndex === index,
      );

      if (!llmDecision) {
        this.logger.warn(
          `LLM did not return decision for pair index=${index}, defaulting to non-duplicate`,
        );
        return {
          isDuplicate: false,
          confidence: 0,
          reason: 'LLM did not return decision for this pair',
        };
      }

      const result: DedupLlmDecision = {
        isDuplicate: !!llmDecision.isDuplicate,
        confidence: llmDecision.confidence ?? 0,
        reason: llmDecision.reason || '',
      };

      if (result.isDuplicate) {
        result.mergeIntoId = pair.existingItem.id;
      }

      return result;
    });
  }

  /**
   * Build Russian-language prompt with examples for the LLM.
   */
  private buildPrompt(pairs: DedupPair[]): string {
    const pairsBlock = pairs
      .map((pair, index) => {
        const lines: string[] = [
          `--- Пара #${index} (тип: ${pair.newItem.type}) ---`,
          `Новый элемент: "${pair.newItem.name}"`,
        ];

        if (pair.newItem.description) {
          lines.push(`  Описание: ${pair.newItem.description}`);
        }
        if (pair.newItem.context) {
          lines.push(`  Контекст: ${pair.newItem.context}`);
        }

        lines.push(`Существующий элемент [${pair.existingItem.id}]: "${pair.existingItem.name}"`);

        if (pair.existingItem.description) {
          lines.push(`  Описание: ${pair.existingItem.description}`);
        }

        if (pair.activityContext) {
          lines.push(`Активность: ${pair.activityContext}`);
        }

        return lines.join('\n');
      })
      .join('\n\n');

    return `Ты эксперт по дедупликации элементов в Personal Knowledge Graph.

## Пары для проверки:
${pairsBlock}

## Задача:
Для каждой пары определи: новый элемент является дубликатом существующего или это уникальный элемент?

## Примеры дубликатов:
- "Настроить CI/CD" и "Настройка CI/CD пайплайна" -- ДУБЛИКАТ (одна задача, разные формулировки)
- "Встреча с Ивановым в пятницу" и "Созвон с Ивановым И.И. на пт" -- ДУБЛИКАТ (одно событие)
- "Отправить договор Петрову" и "Выслать контракт Петрову А." -- ДУБЛИКАТ (одно обязательство)
- "работает в Сбере" и "сотрудник Сбербанка" -- ДУБЛИКАТ (один факт)

## Примеры НЕ дубликатов:
- "Настроить CI/CD" и "Написать тесты" -- НЕ ДУБЛИКАТ (разные задачи)
- "Встреча с Ивановым" и "Звонок Петрову" -- НЕ ДУБЛИКАТ (разные люди)
- "Отправить договор" и "Подписать акт" -- НЕ ДУБЛИКАТ (разные действия)
- "работает в Сбере" и "учился в МГУ" -- НЕ ДУБЛИКАТ (разная информация)

## Важно:
- Учитывай сокращения, синонимы и перефразирования
- Если задачи/обязательства различаются по сути (разные действия, разные люди) — это НЕ дубликат
- Confidence 0.0-1.0: чем увереннее решение, тем ближе к 1.0
- Верни решение для КАЖДОЙ пары`;
  }
}
