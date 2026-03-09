# Retrieval Quality Sprint — Wave 2

> **Статус:** 📋 Design Approved
> **Дата:** 2026-03-09
> **Связан с:** [Wave 1: Fact Taxonomy Redesign](./2026-03-09-fact-taxonomy-redesign.md)
> **Следующий шаг:** После обеих волн — полная переработка всех знаний (re-extraction)

## Проблема

Retrieval pipeline в PKG имеет три слабых места, снижающих качество контекста:

1. **FTS scoring без нормализации:** `ts_rank()` не учитывает длину документа — длинные сообщения получают завышенный score просто за счёт количества вхождений.
2. **Нет reranking:** Результаты поиска и данные тиров подаются в Claude "as is" — без фильтрации по релевантности к задаче.
3. **Context assembly без приоритизации:** Все HOT-сообщения (до 50) и WARM-summaries (до 10) включаются целиком, даже если taskHint указывает на конкретную тему.

### Текущие метрики (baseline)

| Компонент | Текущая реализация | Проблема |
|-----------|-------------------|----------|
| FTS scoring | `ts_rank()` | Не нормализует по длине документа |
| FTS query | `plainto_tsquery('russian', ...)` | Нет поддержки логических операторов |
| Hybrid search | RRF k=60 | Работает, но FTS component слабый |
| Context HOT tier | Все последние 50 сообщений | Нет фильтрации по taskHint |
| Context WARM tier | 10 последних summaries | Нет ранжирования по релевантности |
| Context RELEVANT tier | Vector search top-5 | Единственный tier с relevance scoring |
| Reranking | Отсутствует | Нет LLM-based или cross-encoder reranking |

## Теоретическая основа

### BM25 vs ts_rank

PostgreSQL `ts_rank()` считает сумму весов совпавших лексем без нормализации. `ts_rank_cd()` (cover density) учитывает proximity совпавших терминов и предлагает 4 флага нормализации:

| Флаг | Нормализация |
|------|-------------|
| 0 | Без нормализации (default) |
| 1 | `1 + log(длина)` |
| 2 | Деление на длину документа |
| 4 | Mean harmonic distance |
| 8 | Уникальные слова |
| 16 | `1 + log(уникальные слова)` |
| 32 | `rank / (1 + rank)` — нормализация в [0,1) |

**Рекомендация:** `ts_rank_cd(vector, query, 2|32)` — нормализация по длине + ограничение диапазона.

### Retrieve-then-Rerank

Паттерн из IR (Information Retrieval): сначала быстрый retrieval (FTS + vector), затем точный reranking маленьким LLM:

```
Query → Retrieve (FTS + Vector, top-100) → Rerank (LLM, score 0-10) → Top-K
```

В PKG это применимо в двух местах:
1. **Search API** — `POST /search` endpoint
2. **Context Assembly** — `context.service.ts`, фильтрация HOT/WARM тиров по taskHint

### Когда reranking НЕ помогает

- **Без taskHint** — нечем ранжировать, все сообщения одинаково релевантны
- **Очень мало данных** — < 10 результатов, нечего отсекать
- **PERMANENT tier** — факты всегда включаются (после Wave 1 их ~350)
- **COLD tier** — profile всегда один, включается целиком

## Дизайн

### 1. Upgrade FTS scoring: ts_rank → ts_rank_cd

**Файл:** `apps/pkg-core/src/modules/search/fts.service.ts`

**Текущий код (строка 29):**
```sql
ts_rank(to_tsvector('russian', m.content), plainto_tsquery('russian', $1)) as score
```

**Новый код:**
```sql
ts_rank_cd(to_tsvector('russian', m.content), plainto_tsquery('russian', $1), 2|32) as score
```

Изменения:
- `ts_rank` → `ts_rank_cd` — cover density ranking, учитывает proximity
- Флаг `2|32` — нормализация по длине + ограничение в [0,1)
- Результат: короткие точные сообщения ранжируются выше длинных с размытыми упоминаниями

### 2. LLM-based Reranker Service

**Файл:** `apps/pkg-core/src/modules/search/reranker.service.ts` — **Новый**

```typescript
@Injectable()
export class RerankerService {
  constructor(
    private readonly claudeAgentService: ClaudeAgentService,
  ) {}

  /**
   * Rerank items by relevance to query using Claude Haiku.
   * Returns items sorted by relevance score (0-10), filtered by threshold.
   */
  async rerank<T extends { id: string; content: string }>(
    query: string,
    items: T[],
    options?: {
      threshold?: number;   // Min score to include (default: 3)
      maxItems?: number;     // Max items to return (default: 10)
      batchSize?: number;    // Items per LLM call (default: 20)
    },
  ): Promise<Array<T & { relevanceScore: number }>>
}
```

**Промпт для Haiku:**
```
Оцени релевантность каждого элемента к запросу по шкале 0-10.

Запрос: "{query}"

Элементы:
{items.map((item, i) => `[${i}] ${item.content.slice(0, 300)}`)}

Для каждого элемента верни score (0 = нерелевантно, 10 = точное совпадение).
```

**Structured output schema:**
```json
{
  "type": "object",
  "properties": {
    "scores": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "index": { "type": "number" },
          "score": { "type": "number", "minimum": 0, "maximum": 10 }
        },
        "required": ["index", "score"]
      }
    }
  },
  "required": ["scores"]
}
```

**Batching:** Если items > batchSize, разбиваем на chunks и обрабатываем параллельно.

**Стоимость:** Claude Haiku ~$0.00025 за 1K input tokens. Batch из 20 сообщений ≈ 2K tokens ≈ $0.0005 per rerank call.

### 3. Reranking в Search API

**Файл:** `apps/pkg-core/src/modules/search/search.service.ts`

Добавить опциональный reranking после hybrid search:

```typescript
async search(query: SearchQuery): Promise<SearchResponse> {
  // ... existing hybrid search ...

  // Optional: rerank if requested and enough results
  if (query.rerank && results.length > 5) {
    results = await this.rerankerService.rerank(
      query.query,
      results.map(r => ({ id: r.id, content: r.content || r.highlight || '' })),
      { threshold: 3, maxItems: query.limit },
    );
  }

  return { results, total: results.length, search_type: searchType };
}
```

**SearchQuery extension:**
```typescript
interface SearchQuery {
  // ... existing fields ...
  rerank?: boolean;  // Enable LLM reranking (default: false)
}
```

**Примечание:** Reranking добавляет ~1-2с latency. Включается явно через `rerank: true` в запросе.

### 4. Reranking в Context Assembly

**Файл:** `apps/pkg-core/src/modules/context/context.service.ts`

Основное применение reranking — фильтрация HOT и WARM тиров по taskHint.

#### 4a. HOT tier filtering

**Текущее поведение:** Берём все 50 последних сообщений.

**Новое поведение (при наличии taskHint):**
```typescript
private async getHotMessages(entityId: string, since: Date, taskHint?: string): Promise<Message[]> {
  // Fetch raw messages (increase limit for reranking)
  const rawMessages = await this.fetchRecentMessages(entityId, since, 100);

  if (!taskHint || rawMessages.length <= 10) {
    // No hint or few messages — return all (up to 50)
    return rawMessages.slice(0, 50);
  }

  // Rerank by taskHint relevance
  const reranked = await this.rerankerService.rerank(
    taskHint,
    rawMessages.map(m => ({ id: m.id, content: m.content || '' })),
    { threshold: 2, maxItems: 30 },
  );

  // Return reranked messages, preserving chronological order within
  const rerankedIds = new Set(reranked.map(r => r.id));
  return rawMessages.filter(m => rerankedIds.has(m.id));
}
```

#### 4b. WARM tier filtering

**Текущее поведение:** 10 последних summaries без ранжирования.

**Новое поведение (при наличии taskHint):**
```typescript
private async getWarmSummaries(entityId: string, since: Date, until: Date, taskHint?: string): Promise<InteractionSummary[]> {
  // Fetch more summaries for reranking
  const rawSummaries = await this.fetchSummaries(entityId, since, until, 20);

  if (!taskHint || rawSummaries.length <= 5) {
    return rawSummaries.slice(0, 10);
  }

  // Rerank summaries by taskHint
  const reranked = await this.rerankerService.rerank(
    taskHint,
    rawSummaries.map(s => ({
      id: s.id,
      content: `${s.summaryText} ${(s.keyPoints || []).join(' ')}`,
    })),
    { threshold: 3, maxItems: 8 },
  );

  const rerankedIds = new Set(reranked.map(r => r.id));
  return rawSummaries.filter(s => rerankedIds.has(s.id));
}
```

#### 4c. KNOWLEDGE tier filtering

**Текущее поведение:** 10 последних KnowledgePacks.

**Новое поведение (при наличии taskHint):**
```typescript
private async getKnowledgePacks(entityId: string, taskHint?: string): Promise<KnowledgePack[]> {
  const packs = await this.fetchKnowledgePacks(entityId, 20);

  if (!taskHint || packs.length <= 5) {
    return packs.slice(0, 10);
  }

  const reranked = await this.rerankerService.rerank(
    taskHint,
    packs.map(kp => ({
      id: kp.id,
      content: `${kp.title} ${kp.summary}`,
    })),
    { threshold: 3, maxItems: 8 },
  );

  const rerankedIds = new Set(reranked.map(r => r.id));
  return packs.filter(kp => rerankedIds.has(kp.id));
}
```

### 5. Hybrid Scoring Improvements

**Файл:** `apps/pkg-core/src/modules/search/search.service.ts`

Текущий RRF работает хорошо, но можно улучшить:

#### 5a. Weighted RRF

Вместо равных весов FTS и vector — настраиваемые коэффициенты:

```typescript
private async hybridSearch(query: SearchQuery, limit: number): Promise<SearchResult[]> {
  const k = 60;
  const ftsWeight = 0.4;     // FTS менее надёжен для русского
  const vectorWeight = 0.6;  // Vector лучше для семантики

  // ... fetch results ...

  ftsResults.forEach((result, rank) => {
    const rrfScore = ftsWeight / (k + rank + 1);
    scores.set(result.id, (scores.get(result.id) || 0) + rrfScore);
  });

  vectorResults.forEach((result, rank) => {
    const rrfScore = vectorWeight / (k + rank + 1);
    scores.set(result.id, (scores.get(result.id) || 0) + rrfScore);
  });

  // ...
}
```

#### 5b. Boost for both-signal matches

Результаты, найденные обоими методами, получают дополнительный boost:

```typescript
// After RRF scoring
const ftsIds = new Set(ftsResults.map(r => r.id));
const vectorIds = new Set(vectorResults.map(r => r.id));

scores.forEach((score, id) => {
  if (ftsIds.has(id) && vectorIds.has(id)) {
    scores.set(id, score * 1.2); // 20% boost for dual-signal
  }
});
```

### 6. Context Size Tracking

**Файл:** `apps/pkg-core/src/modules/context/context.service.ts`

Добавить метрики качества retrieval в ContextResponse:

```typescript
interface ContextResponse {
  // ... existing fields ...
  retrievalMetrics?: {
    hotMessagesTotal: number;     // Сколько было до reranking
    hotMessagesAfterRerank: number; // Сколько осталось после
    warmSummariesTotal: number;
    warmSummariesAfterRerank: number;
    rerankLatencyMs: number;       // Время на reranking
    taskHintUsed: boolean;
  };
}
```

## Связь с Wave 1

Wave 1 (Fact Taxonomy Redesign) уменьшает PERMANENT tier с ~1330 до ~350-400 чистых фактов. Это важно для Wave 2:

- **Меньше шума в prompt:** Чистые факты → Claude лучше синтезирует контекст
- **Точнее reranking:** Факты с правильными типами → лучше семантическое понимание
- **activityId на фактах:** Позволяет фильтровать факты по проекту (taskHint)

**Порядок реализации:**
1. Wave 1 — чистим таксономию и данные
2. Wave 2 — улучшаем retrieval
3. Re-extraction — полная переработка с новым pipeline

## Файлы для изменения

| Файл | Изменение |
|------|-----------|
| `apps/pkg-core/src/modules/search/fts.service.ts` | ts_rank → ts_rank_cd с нормализацией |
| `apps/pkg-core/src/modules/search/reranker.service.ts` | **Новый** — LLM-based reranker |
| `apps/pkg-core/src/modules/search/search.service.ts` | Weighted RRF + optional reranking + dual-signal boost |
| `apps/pkg-core/src/modules/search/search.module.ts` | Добавить RerankerService |
| `apps/pkg-core/src/modules/context/context.service.ts` | Reranking в HOT/WARM/KNOWLEDGE тирах при taskHint |
| `packages/shared/src/types/search.types.ts` | rerank field в SearchQuery |
| `packages/shared/src/types/context.types.ts` | retrievalMetrics в ContextResponse |

## Verification

### Pre-implementation baseline
```sql
-- Проверить текущее качество FTS
SELECT
  m.id,
  ts_rank(to_tsvector('russian', m.content), plainto_tsquery('russian', 'Панавто интеграция')) as ts_rank_score,
  ts_rank_cd(to_tsvector('russian', m.content), plainto_tsquery('russian', 'Панавто интеграция'), 34) as ts_rank_cd_score,
  LEFT(m.content, 100) as preview
FROM messages m
WHERE to_tsvector('russian', m.content) @@ plainto_tsquery('russian', 'Панавто интеграция')
ORDER BY ts_rank_score DESC
LIMIT 20;
-- Сравнить ранжирование: ts_rank vs ts_rank_cd
```

### Post-implementation
```bash
# 1. FTS improvement
curl -X POST /api/v1/search \
  -d '{"query": "Панавто интеграция", "searchType": "fts", "limit": 10}'
# Ожидание: Короткие точные сообщения выше длинных

# 2. Reranking в search
curl -X POST /api/v1/search \
  -d '{"query": "статус интеграции Авито", "rerank": true, "limit": 10}'
# Ожидание: Более релевантные результаты, +1-2с latency

# 3. Context с taskHint (reranking applied)
curl -X POST /api/v1/context \
  -d '{"entityId": "...", "taskHint": "обсудить статус интеграции Авито"}'
# Ожидание: HOT tier содержит только релевантные сообщения
# Проверить: retrievalMetrics.hotMessagesAfterRerank < hotMessagesTotal
```

### A/B сравнение контекста
```bash
# Без taskHint — все HOT-сообщения
curl -X POST /api/v1/context -d '{"entityId": "..."}'

# С taskHint — reranked HOT-сообщения
curl -X POST /api/v1/context -d '{"entityId": "...", "taskHint": "интеграция с Flowwow"}'

# Сравнить: второй контекст должен быть компактнее и сфокусированнее
```

## Риски и митигация

| Риск | Вероятность | Митигация |
|------|-------------|-----------|
| Reranking добавляет latency | Высокая | Только при taskHint; Haiku быстрый (~500ms); кэширование |
| Haiku неточно оценивает русский текст | Средняя | Промпт на русском; тестирование на реальных данных |
| ts_rank_cd ломает существующий ranking | Низкая | Нормализация 2|32 стабильна; A/B тест перед deploy |
| Cost increase от LLM reranking | Средняя | ~$0.0005/rerank call; ~5-10 calls/day для context |

## Стоимость

| Операция | Частота | Стоимость |
|----------|---------|-----------|
| FTS upgrade (ts_rank_cd) | Бесплатно | SQL change only |
| Reranking в context (Haiku) | ~10/day | ~$0.005/day |
| Reranking в search (Haiku) | ~5/day | ~$0.0025/day |
| **Итого** | | **~$0.23/month** |
