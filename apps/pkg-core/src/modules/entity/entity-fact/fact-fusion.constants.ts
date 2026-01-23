import { FactSource } from '@pkg/entities';

/**
 * Fusion decision types (Wikidata-inspired)
 */
export enum FusionAction {
  /** Same information, just confirmation - increase confidence */
  CONFIRM = 'confirm',
  /** Complementary info, merge into richer fact */
  ENRICH = 'enrich',
  /** New is more specific/accurate - deprecate old */
  SUPERSEDE = 'supersede',
  /** Both valid (different time periods or perspectives) */
  COEXIST = 'coexist',
  /** Contradictory, needs human review */
  CONFLICT = 'conflict',
}

/**
 * Source priority for automatic decisions
 * Higher = more trustworthy
 */
export const SOURCE_PRIORITY: Record<FactSource, number> = {
  [FactSource.MANUAL]: 100,
  [FactSource.EXTRACTED]: 70,
  [FactSource.IMPORTED]: 50,
};

/**
 * JSON Schema for LLM fusion decision
 */
export const FUSION_DECISION_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['confirm', 'enrich', 'supersede', 'coexist', 'conflict'],
      description: 'Decision type for fact fusion',
    },
    mergedValue: {
      type: 'string',
      description: 'Merged value for ENRICH action (combines both facts)',
    },
    explanation: {
      type: 'string',
      description: 'Why this decision was made (Russian, 1-2 sentences)',
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Confidence in decision (0.0-1.0)',
    },
  },
  required: ['action', 'explanation', 'confidence'],
};

/**
 * Fusion decision interface
 */
export interface FusionDecision {
  action: FusionAction;
  mergedValue?: string;
  explanation: string;
  confidence: number;
}

/**
 * Build prompt for LLM fusion decision
 */
export function buildFusionPrompt(params: {
  existingFact: {
    factType: string;
    value: string | null;
    source: string;
    confidence: number | null;
    createdAt: Date;
  };
  newFactValue: string;
  newFactSource: string;
  messageContext?: string;
}): string {
  const { existingFact, newFactValue, newFactSource, messageContext } = params;

  const existingPriority = SOURCE_PRIORITY[existingFact.source as FactSource] || 50;
  const newPriority = SOURCE_PRIORITY[newFactSource as FactSource] || 50;

  return `Проанализируй два факта об одном человеке/организации и определи их отношение.

СУЩЕСТВУЮЩИЙ ФАКТ:
- Тип: ${existingFact.factType}
- Значение: "${existingFact.value || ''}"
- Источник: ${existingFact.source} (приоритет: ${existingPriority})
- Уверенность: ${existingFact.confidence ?? 'не указана'}
- Добавлен: ${existingFact.createdAt.toISOString().split('T')[0]}

НОВЫЙ ФАКТ:
- Тип: ${existingFact.factType}
- Значение: "${newFactValue}"
- Источник: ${newFactSource} (приоритет: ${newPriority})
${messageContext ? `- Контекст сообщения: "${messageContext.slice(0, 300)}"` : ''}

ПРИОРИТЕТ ИСТОЧНИКОВ: MANUAL(100) > EXTRACTED(70) > IMPORTED(50)

Определи отношение между фактами:

1. CONFIRM — Та же информация, просто подтверждение
   Пример: "Работает в Сбере" ≈ "Работает в Сбербанке"
   → Увеличиваем уверенность существующего

2. ENRICH — Дополняющая информация, можно объединить
   Пример: "В Сбере" + "Ведущий разработчик в Сбербанке"
   → Слияние: "Ведущий разработчик в Сбербанке"
   ОБЯЗАТЕЛЬНО укажи mergedValue!

3. SUPERSEDE — Новый факт точнее/актуальнее
   Пример: "ДР в марте" → "ДР 15.03.1990"
   → Deprecate старый, использовать новый

4. COEXIST — Оба валидны (разные периоды или оба верны)
   Пример: "CTO в 2020" + "CEO в 2024"
   → Сохранить оба с временными маркерами

5. CONFLICT — Противоречие, требует проверки человеком
   Пример: "Работает в Сбере" + "Работает в Тинькофф" (одновременно)
   → Пометить для разрешения пользователем

Верни JSON с action, mergedValue (только для enrich!), explanation (на русском), confidence.`;
}

/**
 * Threshold for automatic fusion vs conflict
 */
export const FUSION_CONFIDENCE_THRESHOLD = 0.7;
