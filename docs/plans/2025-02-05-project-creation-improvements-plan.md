# План улучшений системы создания проектов

> **Дата:** 2025-02-05
> **Статус:** Draft
> **Автор:** Claude (Tech Lead)

## Executive Summary

Текущая система создания проектов в PKG имеет 8 критических проблем бизнес-логики, которые приводят к:
- Созданию "проектов" из обычных упоминаний ("купить молоко")
- Дубликатам проектов с похожими названиями
- Неправильной привязке клиентов
- Пропущенным дубликатам уже существующих активных проектов
- Отсутствию механизмов контроля качества данных
- **Разрыву между реализованной моделью данных и её фактическим использованием**

Этот план предлагает систематические улучшения каждой проблемы с конкретными примерами кода, миграционной стратегией и метриками успеха.

> **Обновление (2025-02-05):** План обновлён после аудита реального состояния кода и критического анализа документа KNOWLEDGE_GRAPH.md. Добавлена Проблема 8 и секция анализа расхождений.

---

## Анализ расхождений: План ↔ Knowledge Graph ↔ Реальность

> Этот раздел документирует результаты аудита трёх источников правды: текущего плана улучшений, документации Knowledge Graph (`docs/KNOWLEDGE_GRAPH.md`), и фактического состояния кода.

### Три уровня правды

| Источник | Что описывает | Надёжность |
|----------|---------------|------------|
| **Код** (реальность) | Что система делает прямо сейчас | 100% — это ground truth |
| **KNOWLEDGE_GRAPH.md** | Целевую модель данных | ~70% — entity определены, но часть не «подключена» |
| **Этот план** (до обновления) | Улучшения extraction бизнес-логики | ~55% совпадения с KG |

### Критический анализ KNOWLEDGE_GRAPH.md

Документ KNOWLEDGE_GRAPH.md представляет красивую целевую картину, но имеет несколько серьёзных проблем:

#### 1. Не различает «определено» и «работает»

KG документирует все entity одинаково, без указания статуса реализации. Реальность:

| Entity | В KG | В коде | Реально используется |
|--------|------|--------|---------------------|
| ActivityMember | ✅ Документирована | ✅ Entity файл + миграция | ❌ **DORMANT** — ни один сервис не создаёт записи |
| Commitment | ✅ Документирована | ✅ Полная реализация | ⚠️ **Частично** — `activityId` никогда не заполняется |
| EntityRelation | ✅ Документирована | ✅ Полная реализация | ⚠️ **Не используется в extraction** |
| Activity (10 типов) | ✅ 10 ActivityTypes | ✅ Enum в entity | ⚠️ **Только PROJECT и TASK** реально создаются |
| Activity поля | ✅ description, priority, etc. | ✅ Колонки в БД | ❌ **Не заполняются** при extraction |

#### 2. Аспирационная иерархия

KG документирует красивую иерархию `AREA → BUSINESS → DIRECTION → PROJECT → TASK`, но:
- Extraction создаёт только плоские PROJECT и TASK
- AREA, BUSINESS, DIRECTION — ни разу не созданы в production
- Три паттерна дерева (closure-table + adjacency list + materialized path) избыточны для текущего использования
- `depth` всегда 0 для PROJECT, нет реальной вложенности

#### 3. Выброшенные данные не задокументированы

KG **не упоминает** что extraction пайплайн:
- Извлекает `InferredRelations` (тип связи между людьми) — но **выбрасывает их**, не персистит в БД
- Хранит участников проекта как `metadata.participants: string[]` — а не как `ActivityMember` записи
- Не связывает `Commitment.activityId` с созданным проектом, хотя оба извлекаются из одного диалога

#### 4. Что в KG правильно и ценно

- **Пирамида знаний** (5 уровней) — верная концептуальная основа
- **N-арная модель EntityRelation** — правильная архитектура, просто не используется
- **ActivityMember с ролями** — правильный дизайн, нужно только «подключить»
- **Commitment → Activity связь** — поле существует, нужно заполнять
- **Phase E (TopicalSegment, KnowledgePack)** — верно помечена как «планируемая»

### Матрица расхождений

| Аспект | Этот план (до обновления) | Knowledge Graph | Реальность | Правильная цель |
|--------|--------------------------|-----------------|------------|-----------------|
| **Участники проекта** | Не упоминает | ActivityMember с 7 ролями | `metadata.participants: string[]` | ➡️ Использовать ActivityMember |
| **Связь Commitment↔Activity** | Не упоминает | `activityId` поле | Поле есть, всегда `null` | ➡️ Заполнять при extraction |
| **EntityRelation в extraction** | Не упоминает | Документирована полностью | InferredRelations выбрасываются | ➡️ Персистить InferredRelations |
| **Типы Activity** | Только PROJECT/TASK | 10 типов | Только PROJECT/TASK | ➡️ Оставить PROJECT/TASK, но расширить правила |
| **Поля Activity** | Не упоминает | description, priority, etc. | Не заполняются | ➡️ Заполнять из extraction |
| **DataQualityReport** | Предлагает создать | Не упоминается | Не существует | ➡️ Создать (это план) |
| **Entity resolution** | Улучшает matching | Упоминает identifiers | ILIKE %name% | ➡️ Многоэтапная стратегия (верно в плане) |
| **Иерархия дерева** | validateTypeHierarchy | 3 паттерна дерева | depth=0, нет вложенности | ➡️ Использовать 1 паттерн (adjacency) |

### Приоритеты обновлений

**Приоритет 1 — Подключить существующие entity (низкая стоимость, высокая ценность):**
- Проблема 8.1: ActivityMember вместо metadata.participants
- Проблема 8.2: Commitment.activityId при extraction
- Проблема 8.3: Персистить InferredRelations

**Приоритет 2 — Заполнять существующие поля:**
- Проблема 8.4: Activity.description, priority, context, deadline из extraction

**Приоритет 3 — Не делать сейчас (отложить):**
- 8 дополнительных ActivityTypes (AREA, BUSINESS, etc.) — создавать вручную через API, не через extraction
- Замена closure-table на simpler pattern — работает, не трогать
- Phase E entities (TopicalSegment, KnowledgePack) — отдельная фаза

### Рекомендации по обновлению KNOWLEDGE_GRAPH.md

После реализации этого плана необходимо обновить KG документ:
1. Добавить колонку **«Статус реализации»** в сводную таблицу (ACTIVE/DORMANT/PLANNED)
2. Добавить секцию **«Текущие ограничения»** с перечнем того, что не используется
3. Документировать **InferredRelation** как промежуточный артефакт extraction
4. Отметить что из 10 ActivityTypes только PROJECT/TASK создаются автоматически
5. Обновить диаграмму DATA FLOW — показать что extraction не использует ActivityMember/EntityRelation

---

## Проблема 1: Нечёткие критерии "что такое проект"

### Текущая ситуация

**Промпт для LLM (daily-synthesis-extraction.service.ts:238-240):**
```
Проекты — это значимые работы с участниками, клиентами и статусом.
```

**Проблемы:**
- Слишком широкое определение
- Нет критериев длительности
- Нет различия между проектом и задачей
- Создаются "проекты" типа "купить молоко", "позвонить Ивану"

**Примеры ложных срабатываний:**
```typescript
// Обычная задача, помеченная как проект
{
  name: "Позвонить клиенту по поводу договора",
  isNew: true,
  client: "ООО Клиент",
  confidence: 0.8
}

// Одноразовое действие
{
  name: "Купить подарок на день рождения",
  isNew: true,
  participants: ["Иван"],
  confidence: 0.7
}
```

### Решение

#### 1.1 Определение критериев проекта

Проект отличается от задачи по следующим характеристикам:

| Критерий | Проект | Задача |
|----------|--------|--------|
| **Длительность** | > 2 недель | < 2 недель |
| **Структура** | Имеет подзадачи | Атомарная единица работы |
| **Результат** | Продукт, deliverable | Действие, изменение |
| **Участники** | Команда (≥2 человека) | Может быть 1 исполнитель |
| **Бюджет** | Часто имеет бюджет | Обычно нет бюджета |
| **Клиент** | Внешний или внутренний стейкхолдер | Может не иметь клиента |

#### 1.2 Обновлённый промпт для LLM

```typescript
// daily-synthesis-extraction.service.ts
const IMPROVED_PROJECT_DEFINITION = `
## Что является Проектом

Проект — это структурированная работа со следующими характеристиками:

1. **Длительность**: > 2 недель (явно упомянута или подразумевается)
2. **Структура**: Состоит из нескольких этапов или подзадач
3. **Результат**: Конкретный deliverable (продукт, система, документ, событие)
4. **Участники**: Команда из ≥2 человек или несколько взаимодействий с разными людьми
5. **Контекст**: Явно упоминается как "проект", "работа над", "разработка", "запуск"

## Что НЕ является Проектом

- Одноразовые действия ("позвонить", "отправить", "купить")
- Повторяющиеся рутинные задачи ("еженедельный отчёт")
- Простые просьбы без структуры ("помочь с...", "проверить...")
- Обсуждения без решения о начале работы

## Примеры

### ✅ Проект
- "Запуск нового продукта X — нужна команда дизайнера, разработчика, маркетолога. Релиз через 3 месяца."
- "Разработка CRM системы для клиента ООО Альфа — 4 этапа, бюджет согласован"
- "Организация конференции DevOps 2025 — 200 участников, несколько спикеров"

### ❌ НЕ проект (это задачи)
- "Позвонить Ивану по поводу договора"
- "Купить подарок коллеге"
- "Отправить еженедельный отчёт руководству"
- "Проверить баги в GitHub issue #123"
`;
```

#### 1.3 Добавление confidence scoring

```typescript
interface ExtractedProject {
  name: string;
  isNew: boolean;
  // Новые поля для оценки
  projectIndicators: {
    hasDuration: boolean;        // Упомянута длительность
    hasStructure: boolean;       // Есть этапы/подзадачи
    hasDeliverable: boolean;     // Есть конкретный результат
    hasTeam: boolean;            // Упомянуто ≥2 участников
    explicitMention: boolean;    // Явно назван "проектом"
  };
  confidence: number;            // 0.0-1.0
  confidenceReason: string;      // Объяснение оценки
}
```

**JSON Schema для structured output:**
```typescript
const PROJECT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Project name' },
    isNew: { type: 'boolean' },
    projectIndicators: {
      type: 'object',
      properties: {
        hasDuration: { type: 'boolean', description: 'Duration >2 weeks mentioned' },
        hasStructure: { type: 'boolean', description: 'Has phases or subtasks' },
        hasDeliverable: { type: 'boolean', description: 'Has concrete deliverable' },
        hasTeam: { type: 'boolean', description: 'Team of ≥2 people' },
        explicitMention: { type: 'boolean', description: 'Explicitly called "project"' },
      },
      required: ['hasDuration', 'hasStructure', 'hasDeliverable', 'hasTeam', 'explicitMention'],
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Confidence score 0.0-1.0'
    },
    confidenceReason: {
      type: 'string',
      description: 'Brief explanation of confidence score'
    },
  },
  required: ['name', 'isNew', 'projectIndicators', 'confidence', 'confidenceReason'],
};
```

#### 1.4 Фильтрация низкокачественных проектов

```typescript
// daily-synthesis-extraction.service.ts
private filterLowQualityProjects(projects: ExtractedProject[]): ExtractedProject[] {
  const MIN_CONFIDENCE = 0.6;
  const MIN_INDICATORS = 2; // Минимум 2 из 5 индикаторов должны быть true

  return projects.filter(project => {
    const indicators = project.projectIndicators;
    const indicatorCount = Object.values(indicators).filter(Boolean).length;

    const isHighConfidence = project.confidence >= MIN_CONFIDENCE;
    const hasEnoughIndicators = indicatorCount >= MIN_INDICATORS;

    if (!isHighConfidence || !hasEnoughIndicators) {
      this.logger.debug(
        `Filtered out low-quality project: "${project.name}" ` +
        `(confidence=${project.confidence}, indicators=${indicatorCount}/5)`
      );
      return false;
    }

    return true;
  });
}

// В методе extractAndSave()
const rawResult = await this.extract(messages, contextFormatted);
const filteredProjects = this.filterLowQualityProjects(rawResult.projects);
```

#### 1.5 Метрики успеха

**Baseline (до изменений):**
- False positive rate: ~40% (из 100 извлечённых "проектов" 40 — на самом деле задачи)
- Precision: 60%

**Target (после изменений):**
- False positive rate: <15%
- Precision: >85%

**Как измерять:**
```sql
-- Проекты с низким числом подзадач (вероятно ложные срабатывания)
SELECT
  a.id,
  a.name,
  COUNT(child.id) as subtask_count,
  a.created_at
FROM activity a
LEFT JOIN activity child ON child.parent_id = a.id AND child.activity_type = 'task'
WHERE a.activity_type = 'project'
  AND a.created_at > '2025-02-05'
GROUP BY a.id
HAVING COUNT(child.id) < 2
ORDER BY a.created_at DESC;
```

---

## Проблема 2: Примитивный алгоритм сопоставления проектов

### Текущая ситуация

**Код (daily-synthesis-extraction.service.ts:319-350):**
```typescript
const normalizedName = project.name.toLowerCase().trim();
const match = existingActivities.find((a) => {
  const existingName = a.name.toLowerCase().trim();
  return (
    existingName === normalizedName ||
    existingName.includes(normalizedName) ||
    normalizedName.includes(existingName)
  );
});
```

**Проблемы:**
- String includes создаёт ложные совпадения:
  - "CRM" matches "CRM для клиента", "Новая CRM", "Интеграция с CRM"
- Первое совпадение побеждает (нет выбора лучшего)
- Нет учёта контекста (клиент, участники, статус)
- Нет threshold для similarity

**Примеры ошибок:**
```typescript
// Existing: "Разработка CRM системы для Альфа"
// New: "CRM"
// Result: Match! (WRONG — это разные проекты)

// Existing: "Запуск сайта"
// New: "Запуск нового сайта для клиента Бета"
// Result: Match! (WRONG — разные клиенты)
```

### Решение

#### 2.1 Многоуровневая система сопоставления

```typescript
interface ProjectMatchResult {
  activity: Activity;
  score: number;           // 0-100
  matchType: MatchType;
  reasons: string[];
}

enum MatchType {
  EXACT = 'exact',           // 100% совпадение
  HIGH = 'high',             // >80 similarity
  MEDIUM = 'medium',         // 60-80 similarity
  LOW = 'low',               // 40-60 similarity
  NO_MATCH = 'no_match',     // <40 similarity
}
```

#### 2.2 Алгоритм с scoring

```typescript
// apps/pkg-core/src/modules/extraction/project-matching.service.ts
@Injectable()
export class ProjectMatchingService {
  private readonly logger = new Logger(ProjectMatchingService.name);

  /**
   * Находит наилучшее совпадение для нового проекта среди существующих.
   * Возвращает null если нет достаточно похожего проекта (score < 60).
   */
  async findBestMatch(
    newProject: ExtractedProject,
    existingActivities: Activity[],
  ): Promise<ProjectMatchResult | null> {
    const candidates = existingActivities.map(activity =>
      this.calculateMatchScore(newProject, activity)
    );

    // Сортируем по убыванию score
    candidates.sort((a, b) => b.score - a.score);

    const best = candidates[0];
    if (!best || best.score < 60) {
      return null; // Нет достаточно похожего проекта
    }

    return best;
  }

  private calculateMatchScore(
    newProject: ExtractedProject,
    activity: Activity,
  ): ProjectMatchResult {
    const reasons: string[] = [];
    let score = 0;

    // 1. Name similarity (max 40 points)
    const nameSimilarity = this.calculateStringSimilarity(
      newProject.name,
      activity.name,
    );
    const namePoints = nameSimilarity * 40;
    score += namePoints;
    reasons.push(`Name similarity: ${(nameSimilarity * 100).toFixed(0)}%`);

    // 2. Client match (max 30 points)
    if (newProject.client && activity.clientEntityId) {
      const clientMatch = this.isClientMatch(
        newProject.client,
        activity.clientEntity,
      );
      if (clientMatch) {
        score += 30;
        reasons.push('Client matches');
      } else {
        score -= 20; // Penalty for different clients
        reasons.push('Different clients (mismatch penalty)');
      }
    }

    // 3. Participants overlap (max 20 points)
    if (newProject.participants && newProject.participants.length > 0) {
      const overlapRatio = this.calculateParticipantOverlap(
        newProject.participants,
        activity, // Нужно добавить связь с participants
      );
      const participantPoints = overlapRatio * 20;
      score += participantPoints;
      reasons.push(`Participant overlap: ${(overlapRatio * 100).toFixed(0)}%`);
    }

    // 4. Status similarity (max 10 points)
    if (newProject.status && activity.metadata?.status) {
      const statusMatch = this.normalizeStatus(newProject.status) ===
                          this.normalizeStatus(activity.metadata.status as string);
      if (statusMatch) {
        score += 10;
        reasons.push('Status matches');
      }
    }

    const matchType = this.getMatchType(score);

    return {
      activity,
      score: Math.max(0, Math.min(100, score)), // Clamp to 0-100
      matchType,
      reasons,
    };
  }

  /**
   * Levenshtein distance + нормализация.
   * Returns 0.0 (no match) to 1.0 (exact match).
   */
  private calculateStringSimilarity(str1: string, str2: string): number {
    const s1 = this.normalizeProjectName(str1);
    const s2 = this.normalizeProjectName(str2);

    if (s1 === s2) return 1.0;

    const distance = this.levenshteinDistance(s1, s2);
    const maxLen = Math.max(s1.length, s2.length);

    return 1 - (distance / maxLen);
  }

  /**
   * Нормализация названия проекта:
   * - lowercase
   * - удаление стоп-слов ("для", "по", "в", "на", "с")
   * - удаление артиклей
   * - trim
   */
  private normalizeProjectName(name: string): string {
    const stopWords = ['для', 'по', 'в', 'на', 'с', 'из', 'к', 'о', 'от', 'про'];

    return name
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter(word => !stopWords.includes(word))
      .join(' ');
  }

  private levenshteinDistance(str1: string, str2: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        const cost = str1[j - 1] === str2[i - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,        // deletion
          matrix[i][j - 1] + 1,        // insertion
          matrix[i - 1][j - 1] + cost, // substitution
        );
      }
    }

    return matrix[str2.length][str1.length];
  }

  private isClientMatch(
    clientName: string,
    clientEntity: Entity | null,
  ): boolean {
    if (!clientEntity) return false;

    const normalized1 = clientName.toLowerCase().trim();
    const normalized2 = clientEntity.name.toLowerCase().trim();

    return normalized1 === normalized2 ||
           this.calculateStringSimilarity(normalized1, normalized2) > 0.85;
  }

  private calculateParticipantOverlap(
    newParticipants: string[],
    activity: Activity,
  ): number {
    // TODO: Implement participant matching
    // Потребуется добавить связь Activity -> Participants
    return 0;
  }

  private normalizeStatus(status: string): string {
    const statusMap: Record<string, string> = {
      'в работе': 'active',
      'активен': 'active',
      'active': 'active',
      'завершён': 'completed',
      'completed': 'completed',
      'приостановлен': 'paused',
      'paused': 'paused',
    };

    return statusMap[status.toLowerCase()] || 'unknown';
  }

  private getMatchType(score: number): MatchType {
    if (score >= 90) return MatchType.EXACT;
    if (score >= 80) return MatchType.HIGH;
    if (score >= 60) return MatchType.MEDIUM;
    if (score >= 40) return MatchType.LOW;
    return MatchType.NO_MATCH;
  }
}
```

#### 2.3 Интеграция в DailySynthesisExtractionService

```typescript
// daily-synthesis-extraction.service.ts
constructor(
  // ... existing dependencies
  private readonly projectMatchingService: ProjectMatchingService,
) {}

private async matchProjectsToActivities(
  projects: ExtractedProject[],
  ownerEntityId: string,
): Promise<ExtractedProject[]> {
  const existingActivities = await this.activityService.findAll({
    ownerEntityId,
    activityType: ActivityType.PROJECT,
  });

  const matched: ExtractedProject[] = [];

  for (const project of projects) {
    const bestMatch = await this.projectMatchingService.findBestMatch(
      project,
      existingActivities,
    );

    if (bestMatch) {
      this.logger.log(
        `Matched project "${project.name}" to existing activity ${bestMatch.activity.id} ` +
        `(score=${bestMatch.score.toFixed(0)}, type=${bestMatch.matchType})`,
      );

      matched.push({
        ...project,
        isNew: false,
        existingActivityId: bestMatch.activity.id,
        // Сохраняем match metadata для отладки
        matchScore: bestMatch.score,
        matchReasons: bestMatch.reasons,
      });
    } else {
      this.logger.log(`No match found for project "${project.name}", marking as new`);
      matched.push(project);
    }
  }

  return matched;
}
```

#### 2.4 Тестирование алгоритма

```typescript
// project-matching.service.spec.ts
describe('ProjectMatchingService', () => {
  describe('findBestMatch', () => {
    it('should match exact name', async () => {
      const newProject: ExtractedProject = {
        name: 'Разработка CRM системы',
        isNew: true,
        participants: [],
        confidence: 0.9,
      };

      const existing: Activity = {
        id: 'uuid-1',
        name: 'Разработка CRM системы',
        activityType: ActivityType.PROJECT,
        // ...
      };

      const match = await service.findBestMatch(newProject, [existing]);

      expect(match).toBeDefined();
      expect(match?.matchType).toBe(MatchType.EXACT);
      expect(match?.score).toBeGreaterThan(90);
    });

    it('should NOT match different projects with similar words', async () => {
      const newProject: ExtractedProject = {
        name: 'CRM для нового клиента',
        isNew: true,
        client: 'ООО Бета',
        confidence: 0.9,
      };

      const existing: Activity = {
        id: 'uuid-1',
        name: 'Разработка CRM системы',
        activityType: ActivityType.PROJECT,
        clientEntity: { id: 'uuid-alfa', name: 'ООО Альфа' } as Entity,
        // ...
      };

      const match = await service.findBestMatch(newProject, [existing]);

      // Name похож, но разные клиенты -> score < 60
      expect(match).toBeNull();
    });

    it('should prefer better match among multiple candidates', async () => {
      const newProject: ExtractedProject = {
        name: 'Запуск нового сайта',
        isNew: true,
        confidence: 0.9,
      };

      const existing1: Activity = {
        id: 'uuid-1',
        name: 'Запуск',
        activityType: ActivityType.PROJECT,
      };

      const existing2: Activity = {
        id: 'uuid-2',
        name: 'Запуск нового сайта компании',
        activityType: ActivityType.PROJECT,
      };

      const match = await service.findBestMatch(newProject, [existing1, existing2]);

      expect(match?.activity.id).toBe('uuid-2'); // Более близкое совпадение
    });
  });
});
```

#### 2.5 Метрики успеха

**Baseline:**
- False match rate: ~30%
- True negative rate: ~70%

**Target:**
- False match rate: <10%
- True negative rate: >90%
- Precision: >85%
- Recall: >80%

**Dashboard для мониторинга:**
```typescript
interface MatchingMetrics {
  totalMatches: number;
  byMatchType: Record<MatchType, number>;
  averageScore: number;
  falsePositives: number; // Вручную помечены как ошибочные
}
```

---

## Проблема 3: Ненадёжное определение клиента

### Текущая ситуация

**Код (draft-extraction.service.ts:730-736):**
```typescript
private async findEntityByName(name: string): Promise<Entity | null> {
  return this.entityRepo
    .createQueryBuilder('e')
    .where('e.name ILIKE :pattern', { pattern: `%${name}%` })
    .orderBy('e.updatedAt', 'DESC')
    .getOne();
}
```

**Проблемы:**
- ILIKE `%name%` находит любое частичное совпадение
- Первый результат по updatedAt (может быть неправильным)
- Нет проверки типа entity (может быть PERSON вместо ORGANIZATION)
- Нет disambiguation при множественных совпадениях
- Нет fallback на идентификаторы (email, phone, INN)

**Примеры ошибок:**
```typescript
// LLM извлёк: client: "Альфа"
// В БД:
// 1. "ООО Альфа Строй" (ORGANIZATION, updated 2025-01-15)
// 2. "ПАО Альфа Банк" (ORGANIZATION, updated 2025-02-01)
// 3. "Иванов Альфа" (PERSON, updated 2025-02-03)
// Result: Иванов Альфа (WRONG — это PERSON, а не клиент)

// LLM извлёк: client: "Иван"
// В БД: 50+ людей с именем "Иван"
// Result: Последний обновлённый "Иван" (WRONG)
```

### Решение

#### 3.1 Многоэтапная стратегия resolution

```typescript
// apps/pkg-core/src/modules/extraction/client-resolution.service.ts
@Injectable()
export class ClientResolutionService {
  private readonly logger = new Logger(ClientResolutionService.name);

  constructor(
    @InjectRepository(Entity)
    private readonly entityRepo: Repository<Entity>,
    @InjectRepository(EntityIdentifier)
    private readonly identifierRepo: Repository<EntityIdentifier>,
  ) {}

  /**
   * Resolves client name to Entity with confidence scoring.
   * Returns null if no high-confidence match found.
   */
  async resolveClient(
    clientName: string,
    contextEntityIds: string[] = [], // Entities mentioned in same conversation
  ): Promise<ClientResolutionResult | null> {
    // Stage 1: Exact match на полное название организации
    const exactMatch = await this.findExactOrgMatch(clientName);
    if (exactMatch) {
      return {
        entity: exactMatch,
        confidence: 1.0,
        method: 'exact_name',
        alternatives: [],
      };
    }

    // Stage 2: Identifier match (INN, email domain, etc.)
    const identifierMatch = await this.findByIdentifier(clientName);
    if (identifierMatch) {
      return {
        entity: identifierMatch,
        confidence: 0.95,
        method: 'identifier',
        alternatives: [],
      };
    }

    // Stage 3: Fuzzy search с disambiguation
    const fuzzyMatches = await this.findFuzzyMatches(clientName, contextEntityIds);

    if (fuzzyMatches.length === 0) {
      return null; // No matches
    }

    if (fuzzyMatches.length === 1) {
      const match = fuzzyMatches[0];
      if (match.score >= 0.75) {
        return {
          entity: match.entity,
          confidence: match.score,
          method: 'fuzzy_single',
          alternatives: [],
        };
      }
    }

    // Multiple matches - need disambiguation
    if (fuzzyMatches.length > 1) {
      const best = fuzzyMatches[0];

      // Если лучший вариант сильно лучше остальных (>20% разница)
      if (best.score > fuzzyMatches[1].score + 0.2) {
        return {
          entity: best.entity,
          confidence: best.score * 0.9, // Снижаем уверенность из-за ambiguity
          method: 'fuzzy_best',
          alternatives: fuzzyMatches.slice(1, 4).map(m => ({
            entity: m.entity,
            score: m.score,
          })),
        };
      }

      // Слишком много похожих вариантов - требуется ручное разрешение
      return {
        entity: null,
        confidence: 0,
        method: 'ambiguous',
        alternatives: fuzzyMatches.slice(0, 5).map(m => ({
          entity: m.entity,
          score: m.score,
        })),
      };
    }

    return null;
  }

  private async findExactOrgMatch(name: string): Promise<Entity | null> {
    const normalized = this.normalizeOrgName(name);

    return this.entityRepo.findOne({
      where: [
        { name: normalized, type: EntityType.ORGANIZATION },
        { shortName: normalized, type: EntityType.ORGANIZATION },
      ],
    });
  }

  private normalizeOrgName(name: string): string {
    // Удаляем префиксы: ООО, ПАО, АО, ИП и т.д.
    const prefixes = ['ООО', 'ПАО', 'АО', 'ЗАО', 'ИП', 'ОАО', 'НАО'];
    let normalized = name.trim();

    for (const prefix of prefixes) {
      const regex = new RegExp(`^${prefix}\\s+"?`, 'i');
      normalized = normalized.replace(regex, '');
    }

    // Удаляем кавычки
    normalized = normalized.replace(/["""«»]/g, '');

    return normalized.trim();
  }

  private async findByIdentifier(value: string): Promise<Entity | null> {
    // Try INN (10 or 12 digits)
    if (/^\d{10}$|^\d{12}$/.test(value)) {
      const identifier = await this.identifierRepo.findOne({
        where: { identifierType: 'inn', identifierValue: value },
        relations: ['entity'],
      });
      if (identifier?.entity) return identifier.entity;
    }

    // Try email domain for organization
    if (value.includes('@')) {
      const domain = value.split('@')[1];
      const identifier = await this.identifierRepo.findOne({
        where: { identifierType: 'email_domain', identifierValue: domain },
        relations: ['entity'],
      });
      if (identifier?.entity) return identifier.entity;
    }

    return null;
  }

  private async findFuzzyMatches(
    clientName: string,
    contextEntityIds: string[],
  ): Promise<Array<{ entity: Entity; score: number }>> {
    // Fetch all ORGANIZATIONs (limit 100 для performance)
    const candidates = await this.entityRepo.find({
      where: { type: EntityType.ORGANIZATION },
      order: { updatedAt: 'DESC' },
      take: 100,
    });

    const matches = candidates
      .map(entity => ({
        entity,
        score: this.calculateNameSimilarity(clientName, entity),
      }))
      .filter(m => m.score >= 0.6); // Threshold

    // Boost score if entity is in context
    for (const match of matches) {
      if (contextEntityIds.includes(match.entity.id)) {
        match.score = Math.min(1.0, match.score + 0.15); // +15% bonus
      }
    }

    // Sort by score descending
    matches.sort((a, b) => b.score - a.score);

    return matches;
  }

  private calculateNameSimilarity(query: string, entity: Entity): number {
    const q = this.normalizeOrgName(query).toLowerCase();
    const name = this.normalizeOrgName(entity.name).toLowerCase();
    const shortName = entity.shortName?.toLowerCase() || '';

    // Exact match on any variant
    if (q === name || q === shortName) return 1.0;

    // Calculate Levenshtein similarity
    const nameSim = this.levenshteinSimilarity(q, name);
    const shortSim = shortName ? this.levenshteinSimilarity(q, shortName) : 0;

    return Math.max(nameSim, shortSim);
  }

  private levenshteinSimilarity(str1: string, str2: string): number {
    const distance = this.levenshteinDistance(str1, str2);
    const maxLen = Math.max(str1.length, str2.length);
    return 1 - (distance / maxLen);
  }

  private levenshteinDistance(str1: string, str2: string): number {
    // Same implementation as in ProjectMatchingService
    // (можно вынести в shared utils)
    // ...
  }
}

interface ClientResolutionResult {
  entity: Entity | null;
  confidence: number;
  method: 'exact_name' | 'identifier' | 'fuzzy_single' | 'fuzzy_best' | 'ambiguous';
  alternatives: Array<{ entity: Entity; score: number }>;
}
```

#### 3.2 Интеграция в DraftExtractionService

```typescript
// draft-extraction.service.ts
constructor(
  // ... existing dependencies
  private readonly clientResolutionService: ClientResolutionService,
) {}

private async createDraftProject(input: CreateDraftProjectInput): Promise<Activity> {
  let clientEntityId: string | null = null;

  if (input.clientName) {
    const resolution = await this.clientResolutionService.resolveClient(
      input.clientName,
      input.contextEntityIds || [],
    );

    if (resolution) {
      if (resolution.entity) {
        clientEntityId = resolution.entity.id;
        this.logger.log(
          `Resolved client "${input.clientName}" to ${resolution.entity.name} ` +
          `(confidence=${resolution.confidence.toFixed(2)}, method=${resolution.method})`,
        );
      } else if (resolution.method === 'ambiguous') {
        // Создаём PendingEntityResolution для ручного разрешения
        await this.createPendingClientResolution({
          clientName: input.clientName,
          alternatives: resolution.alternatives,
          projectName: input.name,
        });

        this.logger.warn(
          `Ambiguous client "${input.clientName}" - created PendingEntityResolution`,
        );
      }
    } else {
      this.logger.warn(`No match found for client "${input.clientName}"`);

      // Опционально: создать новую организацию в draft status
      // или создать PendingEntityResolution
    }
  }

  // ... rest of createDraftProject logic
}

private async createPendingClientResolution(input: {
  clientName: string;
  alternatives: Array<{ entity: Entity; score: number }>;
  projectName: string;
}): Promise<void> {
  // TODO: Implement PendingClientResolution entity
  // Similar to PendingEntityResolution but specifically for client disambiguation
}
```

#### 3.3 UI для disambiguation (Mini App)

```typescript
// Новая страница: /pending-client-resolution
interface PendingClientResolution {
  id: string;
  clientName: string;           // Исходное название из LLM
  projectName: string;           // Проект, к которому относится
  alternatives: Array<{
    entityId: string;
    entityName: string;
    score: number;
    recentInteractions: number; // Для контекста
  }>;
  status: 'pending' | 'resolved';
}

// API endpoint
@Post('pending-client-resolution/:id/resolve')
async resolveClient(
  @Param('id') id: string,
  @Body() body: { selectedEntityId: string },
) {
  // Update Project with correct clientEntityId
  // Mark resolution as resolved
}
```

#### 3.4 Fallback: создание новой организации

```typescript
private async createNewOrganization(name: string): Promise<Entity> {
  // Создаём новую Entity типа ORGANIZATION в draft status
  const entity = this.entityRepo.create({
    name: this.normalizeOrgName(name),
    type: EntityType.ORGANIZATION,
    status: EntityStatus.DRAFT, // Требуется подтверждение
  });

  await this.entityRepo.save(entity);

  this.logger.log(`Created new draft organization: ${entity.name} (${entity.id})`);

  return entity;
}
```

#### 3.5 Метрики успеха

**Baseline:**
- False positive rate: ~25% (неправильный клиент привязан)
- Ambiguous cases: ~40% (не обработаны)

**Target:**
- False positive rate: <5%
- Ambiguous cases properly handled: >95%
- Exact matches: >60%
- Identifier matches: >20%

---

## Проблема 4: Неполная дедупликация

### Текущая ситуация

**Код (draft-extraction.service.ts:617-638):**
```typescript
private async findExistingPendingProject(input: {
  name: string;
  batchId: string;
  ownerEntityId: string;
}): Promise<PendingApproval | null> {
  const qb = this.pendingApprovalRepo
    .createQueryBuilder('pa')
    .innerJoin(Activity, 'a', 'pa.target_id = a.id')
    .where('pa.batch_id = :batchId', { batchId: input.batchId })
    .andWhere('pa.item_type = :itemType', { itemType: PendingApprovalItemType.PROJECT })
    .andWhere('pa.status = :status', { status: PendingApprovalStatus.PENDING })
    .andWhere('a.name = :name', { name: input.name })
    .andWhere('a.owner_entity_id = :ownerEntityId', { ownerEntityId: input.ownerEntityId });

  return qb.getOne();
}
```

**Проблемы:**
- Проверяет только PENDING approvals в текущем batch
- НЕ проверяет уже APPROVED проекты (status=ACTIVE в Activity)
- НЕ проверяет PENDING approvals в других batches
- Exact name match (не учитывает похожие названия)
- Не учитывает клиента и других участников

**Сценарий ошибки:**
```
Day 1: Extract "Разработка CRM системы для Альфа" → PENDING
Day 1: User approves → Project becomes ACTIVE

Day 2: Extract "Разработка CRM системы для Альфа" снова
Day 2: findExistingPendingProject() → NULL (т.к. нет PENDING)
Day 2: Creates DUPLICATE project
```

### Решение

#### 4.1 Комплексная проверка на дубликаты

```typescript
// draft-extraction.service.ts

/**
 * Checks for duplicates across:
 * 1. PENDING approvals (all batches)
 * 2. APPROVED/REJECTED approvals
 * 3. ACTIVE/DRAFT projects
 */
private async findExistingProject(input: {
  name: string;
  clientEntityId: string | null;
  ownerEntityId: string;
}): Promise<ExistingProjectCheck> {
  // 1. Check PENDING approvals (any batch)
  const pendingDuplicate = await this.findPendingDuplicate(input);
  if (pendingDuplicate) {
    return {
      exists: true,
      source: 'pending_approval',
      pendingApproval: pendingDuplicate,
    };
  }

  // 2. Check ACTIVE/DRAFT projects using intelligent matching
  const activeProjects = await this.activityRepo.find({
    where: {
      ownerEntityId: input.ownerEntityId,
      activityType: ActivityType.PROJECT,
      status: In([ActivityStatus.ACTIVE, ActivityStatus.DRAFT]),
    },
  });

  if (activeProjects.length > 0) {
    const match = await this.projectMatchingService.findBestMatch(
      { name: input.name, client: input.clientEntityId } as ExtractedProject,
      activeProjects,
    );

    if (match && match.score >= 80) {
      return {
        exists: true,
        source: 'active_project',
        activity: match.activity,
        matchScore: match.score,
      };
    }
  }

  // 3. Check recently APPROVED/REJECTED (last 7 days)
  const recentApprovals = await this.pendingApprovalRepo
    .createQueryBuilder('pa')
    .innerJoinAndSelect('pa.activity', 'a')
    .where('pa.item_type = :itemType', { itemType: PendingApprovalItemType.PROJECT })
    .andWhere('pa.status IN (:...statuses)', {
      statuses: [PendingApprovalStatus.APPROVED, PendingApprovalStatus.REJECTED]
    })
    .andWhere('pa.reviewed_at > :since', {
      since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    })
    .andWhere('a.owner_entity_id = :ownerEntityId', { ownerEntityId: input.ownerEntityId })
    .getMany();

  for (const approval of recentApprovals) {
    const activity = approval.activity;
    if (!activity) continue;

    const similarity = this.calculateNameSimilarity(input.name, activity.name);
    if (similarity >= 0.85) {
      return {
        exists: true,
        source: approval.status === PendingApprovalStatus.APPROVED
          ? 'recently_approved'
          : 'recently_rejected',
        pendingApproval: approval,
        matchScore: similarity * 100,
      };
    }
  }

  return { exists: false };
}

private async findPendingDuplicate(input: {
  name: string;
  clientEntityId: string | null;
  ownerEntityId: string;
}): Promise<PendingApproval | null> {
  const qb = this.pendingApprovalRepo
    .createQueryBuilder('pa')
    .innerJoinAndSelect('pa.activity', 'a')
    .where('pa.item_type = :itemType', { itemType: PendingApprovalItemType.PROJECT })
    .andWhere('pa.status = :status', { status: PendingApprovalStatus.PENDING })
    .andWhere('a.owner_entity_id = :ownerEntityId', { ownerEntityId: input.ownerEntityId });

  // Добавляем фильтр по клиенту если указан
  if (input.clientEntityId) {
    qb.andWhere('a.client_entity_id = :clientEntityId', {
      clientEntityId: input.clientEntityId
    });
  }

  const candidates = await qb.getMany();

  // Ищем похожее название
  for (const candidate of candidates) {
    const activity = candidate.activity;
    if (!activity) continue;

    const similarity = this.calculateNameSimilarity(input.name, activity.name);
    if (similarity >= 0.85) { // 85% threshold
      return candidate;
    }
  }

  return null;
}

interface ExistingProjectCheck {
  exists: boolean;
  source?: 'pending_approval' | 'active_project' | 'recently_approved' | 'recently_rejected';
  pendingApproval?: PendingApproval;
  activity?: Activity;
  matchScore?: number;
}
```

#### 4.2 Обработка найденных дубликатов

```typescript
async createDraftProject(input: CreateDraftProjectInput): Promise<Activity> {
  // Check for duplicates
  const duplicate = await this.findExistingProject({
    name: input.name,
    clientEntityId: input.clientEntityId,
    ownerEntityId: input.ownerEntityId,
  });

  if (duplicate.exists) {
    this.logger.warn(
      `Duplicate project detected: "${input.name}" ` +
      `(source=${duplicate.source}, score=${duplicate.matchScore})`,
    );

    // Strategy depends on source
    switch (duplicate.source) {
      case 'pending_approval':
        // Skip creation - already pending in another batch
        throw new ConflictException(
          `Project "${input.name}" is already pending approval in batch ` +
          `${duplicate.pendingApproval!.batchId}`
        );

      case 'active_project':
        // Link to existing project instead of creating new
        this.logger.log(`Linking to existing active project ${duplicate.activity!.id}`);
        return duplicate.activity!;

      case 'recently_approved':
        // Was approved recently - probably a re-extraction
        this.logger.log(
          `Project was recently approved (${duplicate.pendingApproval!.reviewedAt}), ` +
          `linking to existing`
        );
        return duplicate.pendingApproval!.activity!;

      case 'recently_rejected':
        // User rejected this recently - maybe intentional duplicate?
        // Create with LOW confidence and flag for review
        this.logger.warn(
          `Project was REJECTED ${this.formatTimeSince(duplicate.pendingApproval!.reviewedAt!)} ago. ` +
          `Creating with lowered confidence.`
        );
        input.confidence = Math.min(input.confidence, 0.5);
        input.sourceQuote =
          `(Previously rejected) ${input.sourceQuote || ''}`;
        break;
    }
  }

  // Proceed with creation
  // ...
}
```

#### 4.3 Batch-level deduplication

```typescript
// daily-synthesis-extraction.service.ts
async extractAndSave(
  messages: Message[],
  ownerEntityId: string,
  options?: { batchId?: string },
): Promise<DailyExtractionSaveResult> {
  const rawResult = await this.extract(messages, contextFormatted);

  // **Intra-batch deduplication** — убираем дубликаты внутри одного batch
  const deduplicatedProjects = this.deduplicateWithinBatch(rawResult.projects);

  this.logger.log(
    `Deduplicated ${rawResult.projects.length} → ${deduplicatedProjects.length} projects`,
  );

  // Теперь для каждого проекта проверяем cross-batch duplicates в DraftExtractionService
  // ...
}

private deduplicateWithinBatch(projects: ExtractedProject[]): ExtractedProject[] {
  const seen = new Map<string, ExtractedProject>();

  for (const project of projects) {
    const key = this.getDeduplicationKey(project);

    if (seen.has(key)) {
      this.logger.debug(`Skipping duplicate project within batch: "${project.name}"`);
      continue;
    }

    seen.set(key, project);
  }

  return Array.from(seen.values());
}

private getDeduplicationKey(project: ExtractedProject): string {
  const namePart = project.name.toLowerCase().trim();
  const clientPart = project.client?.toLowerCase().trim() || '';

  return `${namePart}::${clientPart}`;
}
```

#### 4.4 Метрики и алерты

```typescript
// Метрики для мониторинга дубликатов
interface DeduplicationMetrics {
  totalExtracted: number;
  intraBatchDuplicates: number;      // В пределах одного batch
  pendingDuplicates: number;          // Pending в других batches
  activeDuplicates: number;           // Active projects
  recentlyApprovedDuplicates: number;
  recentlyRejectedDuplicates: number;
  created: number;
}

// Alert если слишком много дубликатов
if (metrics.activeDuplicates > metrics.created * 0.3) {
  this.logger.error(
    `HIGH DUPLICATE RATE: ${metrics.activeDuplicates} active duplicates vs ` +
    `${metrics.created} new projects. Check extraction quality!`
  );
}
```

#### 4.5 Тесты

```typescript
describe('Deduplication', () => {
  it('should NOT create duplicate if ACTIVE project exists', async () => {
    // 1. Create and approve project
    const project1 = await draftService.createDraftProject({
      name: 'CRM для Альфа',
      ownerEntityId: 'owner-1',
    });
    await approvalService.approve(project1.pendingApprovalId);

    // 2. Try to create same project again
    await expect(
      draftService.createDraftProject({
        name: 'CRM для Альфа',
        ownerEntityId: 'owner-1',
      })
    ).rejects.toThrow(ConflictException);
  });

  it('should warn but allow creation if recently REJECTED', async () => {
    // 1. Create and reject project
    const project1 = await draftService.createDraftProject({
      name: 'Неудачный проект',
      ownerEntityId: 'owner-1',
    });
    await approvalService.reject(project1.pendingApprovalId);

    // 2. Try to create same project again
    const project2 = await draftService.createDraftProject({
      name: 'Неудачный проект',
      ownerEntityId: 'owner-1',
    });

    // Should create with lowered confidence
    expect(project2).toBeDefined();
    expect(project2.confidence).toBeLessThan(0.6);
    expect(project2.sourceQuote).toContain('Previously rejected');
  });
});
```

---

## Проблема 5: Отсутствие REST API для создания проектов

### Текущая ситуация

**Проблемы:**
- Activity module НЕ экспортирует controller
- Нет прямого REST API для CRUD операций над Activity/Project
- Проекты создаются только через extraction (LLM-based)
- Невозможно вручную создать/редактировать проект через API

**Последствия:**
- Frontend (Mini App) не может создать проект напрямую
- Нет способа исправить ошибки LLM вручную
- Нет админки для управления проектами

### Решение

#### 5.1 REST API Design

**Endpoints:**

```
# Projects (подмножество Activity с type=PROJECT)
GET    /api/v1/projects                    - List all projects
GET    /api/v1/projects/:id                - Get project details
POST   /api/v1/projects                    - Create new project
PATCH  /api/v1/projects/:id                - Update project
DELETE /api/v1/projects/:id                - Delete project (soft delete)

# Hierarchy
GET    /api/v1/projects/:id/children       - Get subprojects/tasks
POST   /api/v1/projects/:id/children       - Add subproject/task
PATCH  /api/v1/projects/:id/parent         - Change parent

# Status transitions
POST   /api/v1/projects/:id/activate       - Activate draft project
POST   /api/v1/projects/:id/complete       - Mark as completed
POST   /api/v1/projects/:id/archive        - Archive project

# Stats
GET    /api/v1/projects/:id/stats          - Project statistics
```

#### 5.2 Controller Implementation

```typescript
// apps/pkg-core/src/modules/activity/activity.controller.ts
@Controller('projects')
@UseGuards(JwtAuthGuard)
export class ProjectController {
  private readonly logger = new Logger(ProjectController.name);

  constructor(
    private readonly activityService: ActivityService,
    private readonly draftExtractionService: DraftExtractionService,
  ) {}

  /**
   * GET /projects
   * List all projects for current user's entity.
   */
  @Get()
  async listProjects(
    @CurrentUser() user: User,
    @Query() query: ListProjectsDto,
  ) {
    const ownerEntityId = await this.getUserEntityId(user);

    const { items, total } = await this.activityService.findAll({
      ownerEntityId,
      activityType: ActivityType.PROJECT,
      status: query.status,
      parentId: query.parentId,
      limit: query.limit || 50,
      offset: query.offset || 0,
    });

    return {
      items: items.map(project => this.mapToProjectDto(project)),
      total,
      limit: query.limit || 50,
      offset: query.offset || 0,
    };
  }

  /**
   * GET /projects/:id
   */
  @Get(':id')
  async getProject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    const project = await this.activityService.findOne(id);

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    // Check ownership
    const ownerEntityId = await this.getUserEntityId(user);
    if (project.ownerEntityId !== ownerEntityId) {
      throw new ForbiddenException('Not your project');
    }

    return this.mapToProjectDto(project);
  }

  /**
   * POST /projects
   * Create new project (bypasses LLM extraction).
   */
  @Post()
  async createProject(
    @Body() dto: CreateProjectDto,
    @CurrentUser() user: User,
  ) {
    const ownerEntityId = await this.getUserEntityId(user);

    // Validate input
    await this.validateCreateProject(dto, ownerEntityId);

    // Create Activity with status=ACTIVE (no draft/approval needed)
    const project = await this.activityService.create({
      name: dto.name,
      activityType: ActivityType.PROJECT,
      status: ActivityStatus.ACTIVE,
      ownerEntityId,
      clientEntityId: dto.clientEntityId,
      parentId: dto.parentId,
      description: dto.description,
      metadata: {
        createdVia: 'manual_api',
        createdBy: user.id,
      },
    });

    this.logger.log(`Manually created project ${project.id}: "${project.name}"`);

    return this.mapToProjectDto(project);
  }

  /**
   * PATCH /projects/:id
   */
  @Patch(':id')
  async updateProject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectDto,
    @CurrentUser() user: User,
  ) {
    const project = await this.getAndValidateOwnership(id, user);

    const updated = await this.activityService.update(id, {
      name: dto.name,
      description: dto.description,
      clientEntityId: dto.clientEntityId,
      parentId: dto.parentId,
      metadata: {
        ...project.metadata,
        lastModifiedBy: user.id,
        lastModifiedAt: new Date().toISOString(),
      },
    });

    return this.mapToProjectDto(updated);
  }

  /**
   * DELETE /projects/:id (soft delete)
   */
  @Delete(':id')
  async deleteProject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    const project = await this.getAndValidateOwnership(id, user);

    // Check if has active children
    const children = await this.activityService.findChildren(id);
    if (children.some(c => c.status === ActivityStatus.ACTIVE)) {
      throw new ConflictException(
        'Cannot delete project with active children. Complete or delete them first.'
      );
    }

    await this.activityService.softDelete(id);

    return { success: true };
  }

  /**
   * GET /projects/:id/children
   */
  @Get(':id/children')
  async getChildren(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    await this.getAndValidateOwnership(id, user);

    const children = await this.activityService.findChildren(id);

    return {
      items: children.map(c => this.mapToProjectDto(c)),
      total: children.length,
    };
  }

  /**
   * POST /projects/:id/activate
   * Activate a DRAFT project.
   */
  @Post(':id/activate')
  async activateProject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    const project = await this.getAndValidateOwnership(id, user);

    if (project.status !== ActivityStatus.DRAFT) {
      throw new ConflictException('Only DRAFT projects can be activated');
    }

    const activated = await this.activityService.update(id, {
      status: ActivityStatus.ACTIVE,
    });

    return this.mapToProjectDto(activated);
  }

  /**
   * POST /projects/:id/complete
   */
  @Post(':id/complete')
  async completeProject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    const project = await this.getAndValidateOwnership(id, user);

    const completed = await this.activityService.update(id, {
      status: ActivityStatus.COMPLETED,
      metadata: {
        ...project.metadata,
        completedAt: new Date().toISOString(),
        completedBy: user.id,
      },
    });

    return this.mapToProjectDto(completed);
  }

  /**
   * GET /projects/:id/stats
   */
  @Get(':id/stats')
  async getProjectStats(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    await this.getAndValidateOwnership(id, user);

    const children = await this.activityService.findChildren(id);

    const stats = {
      totalTasks: children.filter(c => c.activityType === ActivityType.TASK).length,
      completedTasks: children.filter(
        c => c.activityType === ActivityType.TASK && c.status === ActivityStatus.COMPLETED
      ).length,
      totalSubprojects: children.filter(c => c.activityType === ActivityType.PROJECT).length,
      progress: 0,
    };

    stats.progress = stats.totalTasks > 0
      ? Math.round((stats.completedTasks / stats.totalTasks) * 100)
      : 0;

    return stats;
  }

  // Helper methods
  private async getAndValidateOwnership(
    projectId: string,
    user: User,
  ): Promise<Activity> {
    const project = await this.activityService.findOne(projectId);

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const ownerEntityId = await this.getUserEntityId(user);
    if (project.ownerEntityId !== ownerEntityId) {
      throw new ForbiddenException('Not your project');
    }

    return project;
  }

  private async validateCreateProject(
    dto: CreateProjectDto,
    ownerEntityId: string,
  ): Promise<void> {
    // 1. Check for duplicate name
    const existing = await this.activityService.findByName(
      dto.name,
      ownerEntityId,
      ActivityType.PROJECT,
    );

    if (existing) {
      throw new ConflictException(
        `Project "${dto.name}" already exists (id=${existing.id})`
      );
    }

    // 2. Validate parent exists and is owned
    if (dto.parentId) {
      const parent = await this.activityService.findOne(dto.parentId);
      if (!parent) {
        throw new NotFoundException('Parent activity not found');
      }
      if (parent.ownerEntityId !== ownerEntityId) {
        throw new ForbiddenException('Parent activity not owned by you');
      }
    }

    // 3. Validate client entity exists and is ORGANIZATION
    if (dto.clientEntityId) {
      const client = await this.entityService.findOne(dto.clientEntityId);
      if (!client) {
        throw new NotFoundException('Client entity not found');
      }
      if (client.type !== EntityType.ORGANIZATION) {
        throw new BadRequestException('Client must be an ORGANIZATION');
      }
    }
  }

  private async getUserEntityId(user: User): Promise<string> {
    // TODO: Implement user → entity mapping
    // For now, assume user has ownerEntityId in metadata
    return user.metadata?.ownerEntityId || user.id;
  }

  private mapToProjectDto(activity: Activity): ProjectDto {
    return {
      id: activity.id,
      name: activity.name,
      activityType: activity.activityType,
      status: activity.status,
      description: activity.description,
      ownerEntity: activity.ownerEntity ? {
        id: activity.ownerEntity.id,
        name: activity.ownerEntity.name,
      } : null,
      clientEntity: activity.clientEntity ? {
        id: activity.clientEntity.id,
        name: activity.clientEntity.name,
      } : null,
      parent: activity.parent ? {
        id: activity.parent.id,
        name: activity.parent.name,
      } : null,
      depth: activity.depth,
      createdAt: activity.createdAt.toISOString(),
      updatedAt: activity.updatedAt.toISOString(),
      metadata: activity.metadata,
    };
  }
}
```

#### 5.3 DTOs

```typescript
// apps/pkg-core/src/modules/activity/dto/list-projects.dto.ts
export class ListProjectsDto {
  @IsOptional()
  @IsEnum(ActivityStatus)
  status?: ActivityStatus;

  @IsOptional()
  @IsUUID()
  parentId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;
}

// create-project.dto.ts
export class CreateProjectDto {
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsUUID()
  clientEntityId?: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;
}

// update-project.dto.ts
export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsUUID()
  clientEntityId?: string | null;

  @IsOptional()
  @IsUUID()
  parentId?: string | null;
}

// project.dto.ts
export interface ProjectDto {
  id: string;
  name: string;
  activityType: ActivityType;
  status: ActivityStatus;
  description: string | null;
  ownerEntity: { id: string; name: string } | null;
  clientEntity: { id: string; name: string } | null;
  parent: { id: string; name: string } | null;
  depth: number;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown> | null;
}
```

#### 5.4 Module configuration

```typescript
// activity.module.ts
@Module({
  imports: [
    TypeOrmModule.forFeature([Activity]),
  ],
  controllers: [ProjectController], // ← ADD THIS
  providers: [ActivityService],
  exports: [ActivityService],
})
export class ActivityModule {}
```

#### 5.5 Frontend Integration (Mini App)

```typescript
// apps/mini-app/src/api/projects.ts
export const projectsApi = {
  async listProjects(params?: { status?: string; limit?: number }) {
    return api.request<{ items: ProjectDto[]; total: number }>(
      '/projects',
      { method: 'GET', query: params }
    );
  },

  async createProject(data: { name: string; clientEntityId?: string }) {
    return api.request<ProjectDto>('/projects', {
      method: 'POST',
      body: data,
    });
  },

  async updateProject(id: string, data: { name?: string }) {
    return api.request<ProjectDto>(`/projects/${id}`, {
      method: 'PATCH',
      body: data,
    });
  },

  async deleteProject(id: string) {
    return api.request(`/projects/${id}`, { method: 'DELETE' });
  },

  async getProjectStats(id: string) {
    return api.request<ProjectStatsDto>(`/projects/${id}/stats`);
  },
};
```

#### 5.6 Метрики успеха

**Target:**
- API response time: <200ms (p95)
- Manual project creation: >20% of all projects
- Error rate: <1%

---

## Проблема 6: Недостаточная бизнес-валидация

### Текущая ситуация

**Отсутствующие проверки:**
1. ✗ Уникальность названия проекта
2. ✗ Валидность parent (нельзя PROJECT → TASK parent)
3. ✗ Циклические зависимости в иерархии
4. ✗ Тип клиента (должен быть ORGANIZATION, не PERSON)
5. ✗ Максимальная глубина иерархии (performance)
6. ✗ Длина названия (слишком короткое или длинное)
7. ✗ Запрещённые символы в названии

### Решение

#### 6.1 Validation Service

```typescript
// apps/pkg-core/src/modules/activity/activity-validation.service.ts
@Injectable()
export class ActivityValidationService {
  private readonly logger = new Logger(ActivityValidationService.name);

  // Конфигурация ограничений
  private readonly MAX_DEPTH = 5;
  private readonly MIN_NAME_LENGTH = 3;
  private readonly MAX_NAME_LENGTH = 255;
  private readonly FORBIDDEN_CHARS = /[<>{}[\]|\\^`]/;

  constructor(
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
    @InjectRepository(Entity)
    private readonly entityRepo: Repository<Entity>,
  ) {}

  /**
   * Comprehensive validation before creating/updating Activity.
   */
  async validateActivity(input: ValidateActivityInput): Promise<ValidationResult> {
    const errors: ValidationError[] = [];

    // 1. Name validation
    errors.push(...this.validateName(input.name));

    // 2. Uniqueness check
    if (input.checkUniqueness) {
      const uniqueness = await this.checkUniqueName(
        input.name,
        input.ownerEntityId,
        input.activityType,
        input.excludeId,
      );
      if (!uniqueness.isUnique) {
        errors.push(uniqueness.error!);
      }
    }

    // 3. Parent validation
    if (input.parentId) {
      const parentCheck = await this.validateParent(
        input.parentId,
        input.activityType,
        input.ownerEntityId,
      );
      if (!parentCheck.isValid) {
        errors.push(...parentCheck.errors);
      }
    }

    // 4. Client entity validation
    if (input.clientEntityId) {
      const clientCheck = await this.validateClientEntity(input.clientEntityId);
      if (!clientCheck.isValid) {
        errors.push(clientCheck.error!);
      }
    }

    // 5. Depth limit validation
    if (input.parentId) {
      const depthCheck = await this.validateDepthLimit(input.parentId);
      if (!depthCheck.isValid) {
        errors.push(depthCheck.error!);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * 1. Name validation
   */
  private validateName(name: string): ValidationError[] {
    const errors: ValidationError[] = [];

    if (name.length < this.MIN_NAME_LENGTH) {
      errors.push({
        field: 'name',
        code: 'NAME_TOO_SHORT',
        message: `Name must be at least ${this.MIN_NAME_LENGTH} characters`,
      });
    }

    if (name.length > this.MAX_NAME_LENGTH) {
      errors.push({
        field: 'name',
        code: 'NAME_TOO_LONG',
        message: `Name must not exceed ${this.MAX_NAME_LENGTH} characters`,
      });
    }

    if (this.FORBIDDEN_CHARS.test(name)) {
      errors.push({
        field: 'name',
        code: 'NAME_INVALID_CHARS',
        message: 'Name contains forbidden characters',
      });
    }

    return errors;
  }

  /**
   * 2. Uniqueness check
   */
  private async checkUniqueName(
    name: string,
    ownerEntityId: string,
    activityType: ActivityType,
    excludeId?: string,
  ): Promise<{ isUnique: boolean; error?: ValidationError }> {
    const qb = this.activityRepo
      .createQueryBuilder('a')
      .where('a.name = :name', { name })
      .andWhere('a.owner_entity_id = :ownerEntityId', { ownerEntityId })
      .andWhere('a.activity_type = :activityType', { activityType })
      .andWhere('a.status != :deletedStatus', { deletedStatus: ActivityStatus.DELETED });

    if (excludeId) {
      qb.andWhere('a.id != :excludeId', { excludeId });
    }

    const existing = await qb.getOne();

    if (existing) {
      return {
        isUnique: false,
        error: {
          field: 'name',
          code: 'NAME_NOT_UNIQUE',
          message: `${activityType} with name "${name}" already exists (id=${existing.id})`,
          metadata: { existingId: existing.id },
        },
      };
    }

    return { isUnique: true };
  }

  /**
   * 3. Parent validation
   */
  private async validateParent(
    parentId: string,
    childType: ActivityType,
    ownerEntityId: string,
  ): Promise<{ isValid: boolean; errors: ValidationError[] }> {
    const errors: ValidationError[] = [];

    // Fetch parent
    const parent = await this.activityRepo.findOne({
      where: { id: parentId },
    });

    if (!parent) {
      errors.push({
        field: 'parentId',
        code: 'PARENT_NOT_FOUND',
        message: `Parent activity ${parentId} not found`,
      });
      return { isValid: false, errors };
    }

    // Check ownership
    if (parent.ownerEntityId !== ownerEntityId) {
      errors.push({
        field: 'parentId',
        code: 'PARENT_NOT_OWNED',
        message: 'Parent activity is not owned by you',
      });
    }

    // Check type hierarchy rules
    const hierarchyError = this.validateTypeHierarchy(parent.activityType, childType);
    if (hierarchyError) {
      errors.push(hierarchyError);
    }

    return { isValid: errors.length === 0, errors };
  }

  /**
   * Hierarchy rules for all 10 ActivityTypes:
   * AREA → BUSINESS → DIRECTION → PROJECT → TASK
   * Standalone types: MILESTONE, HABIT, LEARNING, EVENT_SERIES, INITIATIVE
   *
   * Note: KNOWLEDGE_GRAPH.md определяет 10 типов, но extraction пока создаёт
   * только PROJECT и TASK. Правила подготовлены для всех типов на будущее.
   */
  private validateTypeHierarchy(
    parentType: ActivityType,
    childType: ActivityType,
  ): ValidationError | null {
    const rules: Record<ActivityType, ActivityType[]> = {
      // Основная иерархия: AREA → BUSINESS → DIRECTION → PROJECT → TASK
      [ActivityType.AREA]: [ActivityType.BUSINESS, ActivityType.DIRECTION, ActivityType.PROJECT],
      [ActivityType.BUSINESS]: [ActivityType.DIRECTION, ActivityType.PROJECT],
      [ActivityType.DIRECTION]: [ActivityType.PROJECT, ActivityType.INITIATIVE],
      [ActivityType.PROJECT]: [ActivityType.TASK, ActivityType.PROJECT, ActivityType.MILESTONE],
      [ActivityType.TASK]: [], // Листовой элемент — не может иметь детей

      // Дополнительные типы
      [ActivityType.INITIATIVE]: [ActivityType.PROJECT, ActivityType.TASK],
      [ActivityType.MILESTONE]: [], // Маркер прогресса, не контейнер
      [ActivityType.HABIT]: [ActivityType.TASK], // Повторяющиеся задачи
      [ActivityType.LEARNING]: [ActivityType.TASK], // Учебные задачи
      [ActivityType.EVENT_SERIES]: [ActivityType.TASK], // Серия событий → задачи подготовки
    };

    const allowedChildren = rules[parentType] || [];

    if (!allowedChildren.includes(childType)) {
      return {
        field: 'parentId',
        code: 'INVALID_HIERARCHY',
        message: `Cannot create ${childType} under ${parentType}. ` +
                 `Allowed: ${allowedChildren.join(', ') || 'none'}`,
      };
    }

    return null;
  }

  /**
   * 4. Client entity validation
   */
  private async validateClientEntity(
    clientEntityId: string,
  ): Promise<{ isValid: boolean; error?: ValidationError }> {
    const client = await this.entityRepo.findOne({
      where: { id: clientEntityId },
    });

    if (!client) {
      return {
        isValid: false,
        error: {
          field: 'clientEntityId',
          code: 'CLIENT_NOT_FOUND',
          message: `Client entity ${clientEntityId} not found`,
        },
      };
    }

    if (client.type !== EntityType.ORGANIZATION) {
      return {
        isValid: false,
        error: {
          field: 'clientEntityId',
          code: 'CLIENT_INVALID_TYPE',
          message: `Client must be ORGANIZATION, got ${client.type}`,
          metadata: { clientName: client.name, clientType: client.type },
        },
      };
    }

    return { isValid: true };
  }

  /**
   * 5. Depth limit validation
   */
  private async validateDepthLimit(
    parentId: string,
  ): Promise<{ isValid: boolean; error?: ValidationError }> {
    const parent = await this.activityRepo.findOne({
      where: { id: parentId },
      select: ['id', 'depth'],
    });

    if (!parent) {
      return { isValid: true }; // Parent validation will catch this
    }

    const newDepth = parent.depth + 1;

    if (newDepth > this.MAX_DEPTH) {
      return {
        isValid: false,
        error: {
          field: 'parentId',
          code: 'MAX_DEPTH_EXCEEDED',
          message: `Maximum depth ${this.MAX_DEPTH} exceeded (would be ${newDepth})`,
          metadata: { parentDepth: parent.depth, maxDepth: this.MAX_DEPTH },
        },
      };
    }

    return { isValid: true };
  }

  /**
   * Detect circular dependencies.
   * Called when changing parent of existing activity.
   */
  async detectCircularDependency(
    activityId: string,
    newParentId: string,
  ): Promise<{ isCircular: boolean; error?: ValidationError }> {
    // Traverse up from newParent, check if we encounter activityId
    let currentId: string | null = newParentId;
    const visited = new Set<string>();

    while (currentId) {
      if (currentId === activityId) {
        return {
          isCircular: true,
          error: {
            field: 'parentId',
            code: 'CIRCULAR_DEPENDENCY',
            message: 'Cannot set parent: would create circular dependency',
          },
        };
      }

      if (visited.has(currentId)) {
        // Already visited - existing circular dependency in data
        this.logger.error(`Circular dependency detected in activity tree at ${currentId}`);
        break;
      }

      visited.add(currentId);

      const parent = await this.activityRepo.findOne({
        where: { id: currentId },
        select: ['id', 'parentId'],
      });

      currentId = parent?.parentId || null;
    }

    return { isCircular: false };
  }
}

interface ValidateActivityInput {
  name: string;
  activityType: ActivityType;
  ownerEntityId: string;
  parentId?: string;
  clientEntityId?: string;
  checkUniqueness?: boolean;
  excludeId?: string; // For updates
}

interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
}

interface ValidationError {
  field: string;
  code: string;
  message: string;
  metadata?: Record<string, unknown>;
}
```

#### 6.2 Интеграция в ActivityService

```typescript
// activity.service.ts
constructor(
  @InjectRepository(Activity)
  private readonly activityRepo: Repository<Activity>,
  private readonly validationService: ActivityValidationService, // ← ADD
) {}

async create(input: CreateActivityInput): Promise<Activity> {
  // Validate before creation
  const validation = await this.validationService.validateActivity({
    name: input.name,
    activityType: input.activityType,
    ownerEntityId: input.ownerEntityId,
    parentId: input.parentId,
    clientEntityId: input.clientEntityId,
    checkUniqueness: true,
  });

  if (!validation.isValid) {
    throw new BadRequestException({
      message: 'Validation failed',
      errors: validation.errors,
    });
  }

  // Proceed with creation
  // ...
}

async update(id: string, input: UpdateActivityInput): Promise<Activity> {
  const existing = await this.findOne(id);
  if (!existing) {
    throw new NotFoundException('Activity not found');
  }

  // Validate updates
  const validation = await this.validationService.validateActivity({
    name: input.name || existing.name,
    activityType: existing.activityType,
    ownerEntityId: existing.ownerEntityId,
    parentId: input.parentId !== undefined ? input.parentId : existing.parentId,
    clientEntityId: input.clientEntityId !== undefined ? input.clientEntityId : existing.clientEntityId,
    checkUniqueness: input.name !== undefined,
    excludeId: id, // Exclude self from uniqueness check
  });

  if (!validation.isValid) {
    throw new BadRequestException({
      message: 'Validation failed',
      errors: validation.errors,
    });
  }

  // Check circular dependency if parent is changing
  if (input.parentId && input.parentId !== existing.parentId) {
    const circularCheck = await this.validationService.detectCircularDependency(
      id,
      input.parentId,
    );

    if (circularCheck.isCircular) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: [circularCheck.error],
      });
    }
  }

  // Proceed with update
  // ...
}
```

#### 6.3 Custom Validation Rules (extensible)

```typescript
// Пример дополнительного правила
export interface CustomValidationRule {
  name: string;
  validate: (activity: Activity) => Promise<ValidationError | null>;
}

// Регистрация правил
const CUSTOM_RULES: CustomValidationRule[] = [
  {
    name: 'no_duplicate_subprojects',
    validate: async (activity) => {
      // Проверка что нет subprojects с одинаковыми именами
      // ...
    },
  },
  {
    name: 'max_active_projects_limit',
    validate: async (activity) => {
      // Проверка что у owner не больше 100 активных проектов
      // ...
    },
  },
];
```

#### 6.4 Тесты

```typescript
describe('ActivityValidationService', () => {
  describe('validateName', () => {
    it('should reject too short name', async () => {
      const result = await service.validateActivity({
        name: 'ab',
        activityType: ActivityType.PROJECT,
        ownerEntityId: 'uuid',
      });

      expect(result.isValid).toBe(false);
      expect(result.errors[0].code).toBe('NAME_TOO_SHORT');
    });

    it('should reject forbidden characters', async () => {
      const result = await service.validateActivity({
        name: 'Project <script>alert(1)</script>',
        activityType: ActivityType.PROJECT,
        ownerEntityId: 'uuid',
      });

      expect(result.isValid).toBe(false);
      expect(result.errors[0].code).toBe('NAME_INVALID_CHARS');
    });
  });

  describe('checkUniqueName', () => {
    it('should reject duplicate name', async () => {
      // Create project
      await factory.createProject({ name: 'Existing Project', ownerEntityId: 'uuid-1' });

      // Try to create another with same name
      const result = await service.validateActivity({
        name: 'Existing Project',
        activityType: ActivityType.PROJECT,
        ownerEntityId: 'uuid-1',
        checkUniqueness: true,
      });

      expect(result.isValid).toBe(false);
      expect(result.errors[0].code).toBe('NAME_NOT_UNIQUE');
    });
  });

  describe('validateParent', () => {
    it('should reject invalid parent type', async () => {
      const task = await factory.createTask({ name: 'Task', ownerEntityId: 'uuid-1' });

      // Try to create PROJECT under TASK (invalid)
      const result = await service.validateActivity({
        name: 'Subproject',
        activityType: ActivityType.PROJECT,
        ownerEntityId: 'uuid-1',
        parentId: task.id,
      });

      expect(result.isValid).toBe(false);
      expect(result.errors[0].code).toBe('INVALID_HIERARCHY');
    });
  });

  describe('validateClientEntity', () => {
    it('should reject PERSON as client', async () => {
      const person = await factory.createEntity({ type: EntityType.PERSON, name: 'Иван' });

      const result = await service.validateActivity({
        name: 'Project',
        activityType: ActivityType.PROJECT,
        ownerEntityId: 'uuid-1',
        clientEntityId: person.id,
      });

      expect(result.isValid).toBe(false);
      expect(result.errors[0].code).toBe('CLIENT_INVALID_TYPE');
    });
  });

  describe('detectCircularDependency', () => {
    it('should detect circular dependency', async () => {
      const p1 = await factory.createProject({ name: 'P1', ownerEntityId: 'uuid-1' });
      const p2 = await factory.createProject({ name: 'P2', parentId: p1.id, ownerEntityId: 'uuid-1' });

      // Try to set p1.parentId = p2.id (circular)
      const result = await service.detectCircularDependency(p1.id, p2.id);

      expect(result.isCircular).toBe(true);
      expect(result.error?.code).toBe('CIRCULAR_DEPENDENCY');
    });
  });
});
```

#### 6.5 Метрики успеха

**Target:**
- Validation error rate: >0 (проверки работают)
- False rejections: <2% (не блокируем валидные кейсы)
- Circular dependency bugs: 0

---

## Проблема 7: Отсутствие системы контроля качества данных

### Текущая ситуация

**Проблемы:**
- Нет автоматизированных проверок качества данных после extraction
- Нет способа обнаружить дубликаты проектов, созданные ошибочно
- Нет валидации целостности данных (orphaned entities, broken relationships)
- Нет механизма для выявления аномалий (проекты без задач, некорректные клиенты)
- Отсутствует возможность запустить проверку качества вручную перед важными операциями

**Последствия:**
- Накапливаются некачественные данные
- Нет visibility в состояние системы
- Проблемы обнаруживаются только когда пользователь жалуется
- Нет инструментов для диагностики и cleanup

### Решение

#### 7.1 Agent-based Data Quality Verification System

Система использует Claude Agent SDK для проведения интеллектуальных проверок качества данных.

**Архитектура:**
```
Mini App Button → POST /data-quality/run → DataQualityService
                                                ↓
                                    Claude Agent с tools:
                                    - list_projects
                                    - check_duplicates
                                    - validate_relationships
                                    - analyze_anomalies
                                                ↓
                                    Report (JSON) → Frontend Display
```

#### 7.2 Backend API Implementation

```typescript
// apps/pkg-core/src/modules/data-quality/data-quality.controller.ts
@Controller('data-quality')
@UseGuards(JwtAuthGuard)
export class DataQualityController {
  private readonly logger = new Logger(DataQualityController.name);

  constructor(
    private readonly dataQualityService: DataQualityService,
  ) {}

  /**
   * POST /api/v1/data-quality/run
   * Запускает полную проверку качества данных для текущего пользователя.
   * Возвращает report ID для дальнейшего мониторинга.
   */
  @Post('run')
  async runQualityCheck(
    @CurrentUser() user: User,
    @Body() dto: RunQualityCheckDto,
  ) {
    const ownerEntityId = await this.getUserEntityId(user);

    this.logger.log(`Starting data quality check for entity ${ownerEntityId}`);

    // Запускаем проверку асинхронно
    const report = await this.dataQualityService.runQualityCheck({
      ownerEntityId,
      checkTypes: dto.checkTypes || ['all'],
      scope: dto.scope || 'full', // 'full' | 'recent' | 'projects_only'
    });

    return {
      reportId: report.id,
      status: report.status,
      createdAt: report.createdAt,
    };
  }

  /**
   * GET /api/v1/data-quality/reports/:id
   * Получить результаты проверки качества.
   */
  @Get('reports/:id')
  async getReport(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    const ownerEntityId = await this.getUserEntityId(user);
    const report = await this.dataQualityService.getReport(id);

    if (!report) {
      throw new NotFoundException('Report not found');
    }

    // Check ownership
    if (report.ownerEntityId !== ownerEntityId) {
      throw new ForbiddenException('Not your report');
    }

    return this.mapToReportDto(report);
  }

  /**
   * GET /api/v1/data-quality/reports
   * Список всех проверок для пользователя.
   */
  @Get('reports')
  async listReports(
    @CurrentUser() user: User,
    @Query() query: ListReportsDto,
  ) {
    const ownerEntityId = await this.getUserEntityId(user);

    const { items, total } = await this.dataQualityService.listReports({
      ownerEntityId,
      limit: query.limit || 20,
      offset: query.offset || 0,
    });

    return {
      items: items.map(r => this.mapToReportDto(r)),
      total,
    };
  }

  private async getUserEntityId(user: User): Promise<string> {
    return user.metadata?.ownerEntityId || user.id;
  }

  private mapToReportDto(report: DataQualityReport): DataQualityReportDto {
    return {
      id: report.id,
      status: report.status,
      createdAt: report.createdAt.toISOString(),
      completedAt: report.completedAt?.toISOString(),
      summary: report.summary,
      issues: report.issues,
      stats: report.stats,
    };
  }
}
```

#### 7.3 Data Quality Service

```typescript
// apps/pkg-core/src/modules/data-quality/data-quality.service.ts
@Injectable()
export class DataQualityService {
  private readonly logger = new Logger(DataQualityService.name);

  constructor(
    @InjectRepository(DataQualityReport)
    private readonly reportRepo: Repository<DataQualityReport>,
    private readonly claudeAgentService: ClaudeAgentService,
    private readonly toolsRegistryService: ToolsRegistryService,
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
    @InjectRepository(Entity)
    private readonly entityRepo: Repository<Entity>,
  ) {}

  async runQualityCheck(input: RunQualityCheckInput): Promise<DataQualityReport> {
    // Create report record
    const report = this.reportRepo.create({
      ownerEntityId: input.ownerEntityId,
      status: DataQualityStatus.RUNNING,
      checkTypes: input.checkTypes,
      scope: input.scope,
    });
    await this.reportRepo.save(report);

    // Run checks asynchronously
    this.executeChecks(report.id, input).catch(error => {
      this.logger.error(`Quality check failed for report ${report.id}: ${error.message}`);
      this.markReportFailed(report.id, error.message);
    });

    return report;
  }

  private async executeChecks(
    reportId: string,
    input: RunQualityCheckInput,
  ): Promise<void> {
    const issues: DataQualityIssue[] = [];
    const stats: Record<string, number> = {};

    try {
      // 1. Fetch data statistics
      const dataStats = await this.gatherDataStats(input.ownerEntityId);
      stats.totalProjects = dataStats.totalProjects;
      stats.totalTasks = dataStats.totalTasks;
      stats.totalEntities = dataStats.totalEntities;

      // 2. Run agent-based checks
      const agentResult = await this.runAgentChecks(input);
      issues.push(...agentResult.issues);
      Object.assign(stats, agentResult.stats);

      // 3. Update report with results
      const report = await this.reportRepo.findOne({ where: { id: reportId } });
      if (report) {
        report.status = DataQualityStatus.COMPLETED;
        report.completedAt = new Date();
        report.issues = issues;
        report.stats = stats;
        report.summary = this.generateSummary(issues, stats);
        await this.reportRepo.save(report);
      }

      this.logger.log(`Quality check completed for report ${reportId}: ${issues.length} issues found`);
    } catch (error) {
      throw error;
    }
  }

  private async runAgentChecks(input: RunQualityCheckInput): Promise<{
    issues: DataQualityIssue[];
    stats: Record<string, number>;
  }> {
    const prompt = `
Проведи комплексную проверку качества данных для entity ${input.ownerEntityId}.

## Типы проверок

1. **Duplicate Projects** - найди проекты с похожими названиями или одинаковыми клиентами
2. **Invalid Relationships** - проверь связи между проектами, задачами и клиентами
3. **Data Integrity** - найди orphaned entities, проекты без задач, задачи без проектов
4. **Client Type Issues** - найди проекты с PERSON в качестве клиента (должны быть ORGANIZATION)
5. **Naming Issues** - слишком короткие названия, спецсимволы, подозрительные паттерны
6. **Circular Dependencies** - проверь иерархию activities на циклы

## Доступные tools

- list_projects - получи список всех проектов
- get_project_details - детали конкретного проекта
- check_duplicates - запусти проверку на дубликаты
- validate_relationships - проверь связи

## Output Format

Верни JSON с:
- issues: массив найденных проблем (каждая с severity, type, description, affectedIds)
- stats: статистика (duplicatesFound, orphanedEntities, invalidClients, etc.)
`;

    const tools = this.toolsRegistryService.getToolsByCategory(['all']);

    const { data } = await this.claudeAgentService.call<AgentQualityCheckOutput>({
      mode: 'agent',
      taskType: 'data_quality_check',
      prompt,
      toolCategories: ['all'],
      maxTurns: 10,
      outputFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            issues: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  severity: { type: 'string', enum: ['critical', 'warning', 'info'] },
                  type: { type: 'string' },
                  description: { type: 'string' },
                  affectedIds: { type: 'array', items: { type: 'string' } },
                },
                required: ['severity', 'type', 'description'],
              },
            },
            stats: {
              type: 'object',
              additionalProperties: { type: 'number' },
            },
          },
          required: ['issues', 'stats'],
        },
        strict: true,
      },
    });

    return {
      issues: data?.issues || [],
      stats: data?.stats || {},
    };
  }

  private async gatherDataStats(ownerEntityId: string): Promise<{
    totalProjects: number;
    totalTasks: number;
    totalEntities: number;
  }> {
    const [totalProjects, totalTasks, totalEntities] = await Promise.all([
      this.activityRepo.count({
        where: {
          ownerEntityId,
          activityType: ActivityType.PROJECT,
          status: In([ActivityStatus.ACTIVE, ActivityStatus.DRAFT]),
        },
      }),
      this.activityRepo.count({
        where: {
          ownerEntityId,
          activityType: ActivityType.TASK,
          status: In([ActivityStatus.ACTIVE, ActivityStatus.DRAFT]),
        },
      }),
      this.entityRepo.count({
        where: {
          // Предполагаем что есть связь с owner
        },
      }),
    ]);

    return { totalProjects, totalTasks, totalEntities };
  }

  private generateSummary(
    issues: DataQualityIssue[],
    stats: Record<string, number>,
  ): DataQualitySummary {
    const criticalCount = issues.filter(i => i.severity === 'critical').length;
    const warningCount = issues.filter(i => i.severity === 'warning').length;
    const infoCount = issues.filter(i => i.severity === 'info').length;

    return {
      totalIssues: issues.length,
      critical: criticalCount,
      warnings: warningCount,
      info: infoCount,
      overallHealth: this.calculateHealthScore(criticalCount, warningCount, infoCount),
    };
  }

  private calculateHealthScore(
    critical: number,
    warnings: number,
    info: number,
  ): 'excellent' | 'good' | 'fair' | 'poor' {
    const score = 100 - (critical * 10 + warnings * 3 + info * 1);

    if (score >= 90) return 'excellent';
    if (score >= 70) return 'good';
    if (score >= 50) return 'fair';
    return 'poor';
  }

  private async markReportFailed(reportId: string, errorMessage: string): Promise<void> {
    await this.reportRepo.update(reportId, {
      status: DataQualityStatus.FAILED,
      completedAt: new Date(),
      summary: { error: errorMessage } as any,
    });
  }

  async getReport(id: string): Promise<DataQualityReport | null> {
    return this.reportRepo.findOne({ where: { id } });
  }

  async listReports(options: {
    ownerEntityId: string;
    limit: number;
    offset: number;
  }): Promise<{ items: DataQualityReport[]; total: number }> {
    const [items, total] = await this.reportRepo.findAndCount({
      where: { ownerEntityId: options.ownerEntityId },
      order: { createdAt: 'DESC' },
      take: options.limit,
      skip: options.offset,
    });

    return { items, total };
  }
}
```

#### 7.4 Entity для отчётов

```typescript
// packages/entities/src/data-quality-report.entity.ts
@Entity('data_quality_reports')
export class DataQualityReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'owner_entity_id', type: 'uuid' })
  ownerEntityId: string;

  @Column({
    type: 'enum',
    enum: DataQualityStatus,
    default: DataQualityStatus.PENDING,
  })
  status: DataQualityStatus;

  @Column({ type: 'jsonb', name: 'check_types', nullable: true })
  checkTypes: string[];

  @Column({ type: 'varchar', length: 50, default: 'full' })
  scope: string;

  @Column({ type: 'jsonb', nullable: true })
  issues: DataQualityIssue[];

  @Column({ type: 'jsonb', nullable: true })
  stats: Record<string, number>;

  @Column({ type: 'jsonb', nullable: true })
  summary: DataQualitySummary;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ name: 'completed_at', type: 'timestamp', nullable: true })
  completedAt: Date | null;
}

export enum DataQualityStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export interface DataQualityIssue {
  severity: 'critical' | 'warning' | 'info';
  type: string;
  description: string;
  affectedIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface DataQualitySummary {
  totalIssues: number;
  critical: number;
  warnings: number;
  info: number;
  overallHealth: 'excellent' | 'good' | 'fair' | 'poor';
}
```

#### 7.5 Frontend Integration (Mini App)

```typescript
// apps/mini-app/src/views/DataQuality.vue
<template>
  <div class="data-quality-page">
    <div class="header">
      <h1>Контроль качества данных</h1>
      <p class="subtitle">
        Проверьте целостность и корректность данных в системе
      </p>
    </div>

    <div class="actions">
      <button
        @click="runQualityCheck"
        :disabled="isRunning"
        class="btn-primary"
      >
        <span v-if="isRunning">Проверка...</span>
        <span v-else>🔍 Запустить проверку</span>
      </button>
    </div>

    <!-- Recent Reports -->
    <div v-if="reports.length > 0" class="reports-list">
      <h2>Последние проверки</h2>
      <div
        v-for="report in reports"
        :key="report.id"
        class="report-card"
        @click="viewReport(report.id)"
      >
        <div class="report-header">
          <div class="report-status" :class="`status-${report.status}`">
            {{ statusLabels[report.status] }}
          </div>
          <div class="report-date">
            {{ formatDate(report.createdAt) }}
          </div>
        </div>

        <div v-if="report.summary" class="report-summary">
          <div class="health-badge" :class="`health-${report.summary.overallHealth}`">
            {{ healthLabels[report.summary.overallHealth] }}
          </div>

          <div class="issue-counts">
            <span v-if="report.summary.critical > 0" class="critical">
              🔴 {{ report.summary.critical }} критических
            </span>
            <span v-if="report.summary.warnings > 0" class="warning">
              🟡 {{ report.summary.warnings }} предупреждений
            </span>
            <span v-if="report.summary.info > 0" class="info">
              ℹ️ {{ report.summary.info }} информационных
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Report Details Modal -->
    <div v-if="selectedReport" class="modal-overlay" @click="closeReport">
      <div class="modal-content" @click.stop>
        <button @click="closeReport" class="close-btn">✕</button>

        <h2>Отчёт о проверке</h2>

        <div class="report-stats">
          <div class="stat">
            <div class="stat-label">Проекты</div>
            <div class="stat-value">{{ selectedReport.stats.totalProjects }}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Задачи</div>
            <div class="stat-value">{{ selectedReport.stats.totalTasks }}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Проблемы</div>
            <div class="stat-value">{{ selectedReport.summary.totalIssues }}</div>
          </div>
        </div>

        <div class="issues-list">
          <h3>Найденные проблемы</h3>
          <div
            v-for="(issue, idx) in selectedReport.issues"
            :key="idx"
            class="issue-item"
            :class="`severity-${issue.severity}`"
          >
            <div class="issue-header">
              <span class="issue-badge">{{ severityLabels[issue.severity] }}</span>
              <span class="issue-type">{{ issue.type }}</span>
            </div>
            <div class="issue-description">{{ issue.description }}</div>
            <div v-if="issue.affectedIds" class="affected-ids">
              Затронуто объектов: {{ issue.affectedIds.length }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from '@/api/client';

const reports = ref<DataQualityReportDto[]>([]);
const isRunning = ref(false);
const selectedReport = ref<DataQualityReportDto | null>(null);

const statusLabels = {
  pending: 'Ожидает',
  running: 'Выполняется',
  completed: 'Завершено',
  failed: 'Ошибка',
};

const healthLabels = {
  excellent: '🟢 Отлично',
  good: '🟢 Хорошо',
  fair: '🟡 Удовлетворительно',
  poor: '🔴 Плохо',
};

const severityLabels = {
  critical: '🔴 Критично',
  warning: '🟡 Предупреждение',
  info: 'ℹ️ Информация',
};

async function runQualityCheck() {
  isRunning.value = true;

  try {
    const result = await api.request<{ reportId: string }>('/data-quality/run', {
      method: 'POST',
      body: {
        checkTypes: ['all'],
        scope: 'full',
      },
    });

    // Poll for completion
    await pollReportCompletion(result.reportId);

    // Reload reports
    await loadReports();
  } catch (error) {
    console.error('Quality check failed:', error);
    alert('Не удалось запустить проверку качества');
  } finally {
    isRunning.value = false;
  }
}

async function pollReportCompletion(reportId: string) {
  const maxAttempts = 60; // 1 минута
  for (let i = 0; i < maxAttempts; i++) {
    const report = await api.request<DataQualityReportDto>(`/data-quality/reports/${reportId}`);

    if (report.status === 'completed' || report.status === 'failed') {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

async function loadReports() {
  const result = await api.request<{ items: DataQualityReportDto[] }>('/data-quality/reports');
  reports.value = result.items;
}

async function viewReport(reportId: string) {
  const report = await api.request<DataQualityReportDto>(`/data-quality/reports/${reportId}`);
  selectedReport.value = report;
}

function closeReport() {
  selectedReport.value = null;
}

function formatDate(isoDate: string): string {
  const date = new Date(isoDate);
  return date.toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

onMounted(() => {
  loadReports();
});
</script>
```

#### 7.6 Agent Tools для Data Quality

Добавляем специализированные tools для data quality checks:

```typescript
// apps/pkg-core/src/modules/data-quality/tools/data-quality-tools.provider.ts
@Injectable()
export class DataQualityToolsProvider {
  constructor(
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
    private readonly projectMatchingService: ProjectMatchingService,
  ) {}

  getTools(): ToolDefinition[] {
    return [
      tool(
        'check_duplicates',
        'Find potential duplicate projects based on name and client similarity',
        {
          ownerEntityId: z.string().uuid().describe('Owner entity UUID'),
          threshold: z.number().min(0.6).max(1.0).default(0.75).describe('Similarity threshold (0.6-1.0)'),
        },
        async (args) => {
          const projects = await this.activityRepo.find({
            where: {
              ownerEntityId: args.ownerEntityId,
              activityType: ActivityType.PROJECT,
              status: In([ActivityStatus.ACTIVE, ActivityStatus.DRAFT]),
            },
            relations: ['clientEntity'],
          });

          const duplicates: Array<{ project1: string; project2: string; score: number }> = [];

          // Compare all pairs
          for (let i = 0; i < projects.length; i++) {
            for (let j = i + 1; j < projects.length; j++) {
              const match = await this.projectMatchingService.calculateMatchScore(
                { name: projects[i].name } as any,
                projects[j],
              );

              if (match.score >= args.threshold * 100) {
                duplicates.push({
                  project1: projects[i].name,
                  project2: projects[j].name,
                  score: match.score,
                });
              }
            }
          }

          return toolSuccess({
            duplicatesFound: duplicates.length,
            duplicates,
          });
        }
      ),

      tool(
        'validate_relationships',
        'Check for invalid relationships (orphaned tasks, wrong client types, circular deps)',
        {
          ownerEntityId: z.string().uuid().describe('Owner entity UUID'),
        },
        async (args) => {
          const issues: string[] = [];

          // Check for orphaned tasks
          const orphanedTasks = await this.activityRepo
            .createQueryBuilder('a')
            .leftJoin('a.parent', 'parent')
            .where('a.activity_type = :type', { type: ActivityType.TASK })
            .andWhere('a.owner_entity_id = :ownerEntityId', { ownerEntityId: args.ownerEntityId })
            .andWhere('a.parent_id IS NOT NULL')
            .andWhere('parent.id IS NULL')
            .getMany();

          if (orphanedTasks.length > 0) {
            issues.push(`Found ${orphanedTasks.length} orphaned tasks with non-existent parent`);
          }

          // Check for projects with PERSON as client
          const invalidClients = await this.activityRepo
            .createQueryBuilder('a')
            .innerJoin('a.clientEntity', 'client')
            .where('a.activity_type = :type', { type: ActivityType.PROJECT })
            .andWhere('client.type = :personType', { personType: EntityType.PERSON })
            .getMany();

          if (invalidClients.length > 0) {
            issues.push(`Found ${invalidClients.length} projects with PERSON as client (should be ORGANIZATION)`);
          }

          return toolSuccess({
            issuesFound: issues.length,
            issues,
          });
        }
      ),
    ];
  }
}
```

#### 7.7 Метрики успеха

**Target:**
- Quality check completion time: <30s (p95)
- Issues detection accuracy: >90%
- False positive rate: <10%
- User adoption: >30% of users run checks monthly

**Monitoring:**
```sql
-- Частота запуска проверок
SELECT
  DATE_TRUNC('day', created_at) as day,
  COUNT(*) as checks_run,
  AVG(EXTRACT(EPOCH FROM (completed_at - created_at))) as avg_duration_seconds
FROM data_quality_reports
WHERE status = 'completed'
GROUP BY day
ORDER BY day DESC;

-- Типы найденных проблем
SELECT
  issue->>'type' as issue_type,
  issue->>'severity' as severity,
  COUNT(*) as count
FROM data_quality_reports,
     jsonb_array_elements(issues) as issue
WHERE status = 'completed'
GROUP BY issue_type, severity
ORDER BY count DESC;
```

---

## Проблема 8: Разрыв между моделью данных и её использованием

> **Severity:** High
> **Impact:** Данные теряются при извлечении — entity существуют в БД, но код extraction их не использует. Knowledge Graph документирует идеальную картину, которая не соответствует реальности.

### Текущая ситуация

Аудит кода выявил 4 критических разрыва между определёнными entity и их фактическим использованием:

#### 8.1. ActivityMember — DORMANT entity

**Entity:** `packages/entities/src/activity-member.entity.ts`
**Статус в KG:** Полностью документирована с 7 ролями (OWNER, MEMBER, OBSERVER, ASSIGNEE, REVIEWER, CLIENT, CONSULTANT)
**Реальность:**

```
Entity файл:     ✅ Создан, миграция выполнена
activity.service: ✅ Репозиторий инжектирован
Использование:    ❌ НИГДЕ — ни один сервис не создаёт записи
```

Вместо структурированных ActivityMember, участники проектов хранятся как строковый массив в metadata:

```typescript
// extraction-persistence.service.ts — что происходит сейчас
metadata: {
  participants: ['Иванов', 'Петров', 'Сидоров'], // string[] !
  extractedFrom: 'daily_synthesis',
}
```

**Последствия:**
- Невозможно найти "все проекты, в которых участвует Иванов" (нет JOIN по ActivityMember)
- Нет ролевой модели — непонятно кто owner, кто исполнитель, кто наблюдатель
- Metadata.participants — нерезолвленные строки (не привязаны к Entity)

#### 8.2. Commitment.activityId — никогда не заполняется

**Entity:** `packages/entities/src/commitment.entity.ts`
**Поле:** `activityId: string | null` (FK на Activity)
**Статус в KG:** Документировано как связь обязательства с проектом/задачей
**Реальность:**

```typescript
// При extraction обязательства создаются так:
{
  description: commitment.description,
  fromEntityId: fromEntity?.id,
  toEntityId: toEntity?.id,
  dueDate: commitment.dueDate,
  // activityId: ???  — НЕ устанавливается!
}
```

**Последствия:**
- Невозможно показать "все обязательства по проекту X"
- Commitment висит "в воздухе" без привязки к контексту
- При подготовке к встрече невозможно автоматически подтянуть обязательства по проекту

#### 8.3. InferredRelations — извлекаются и выбрасываются

**Тип:** `InferredRelation` в `daily-synthesis-extraction.types.ts`
**Entity для хранения:** `EntityRelation` + `EntityRelationMember` (полностью реализованы, N-ary поддержка)
**Реальность:**

```typescript
// daily-synthesis-extraction.service.ts — LLM извлекает:
interface InferredRelation {
  entities: string[];
  relationType: string;
  description: string;
  confidence: number;
}

// Но результат НИГДЕ НЕ ПЕРСИСТИТСЯ
// extraction-persistence.service.ts не содержит кода для сохранения relations
```

**Последствия:**
- LLM каждый раз заново "угадывает" что "Иванов работает в Компании Х"
- Потеря контекста — связи между людьми и организациями не накапливаются
- Не используется уже реализованная EntityRelation инфраструктура

#### 8.4. Activity поля — определены, но не заполняются

**Entity:** `packages/entities/src/activity.entity.ts`
**Реальность:** При создании PROJECT заполняются только базовые поля:

| Поле | Заполняется? | Значение |
|------|-------------|----------|
| name | ✅ | Из extraction |
| activityType | ✅ | Hardcoded PROJECT |
| status | ✅ | Hardcoded DRAFT |
| ownerEntityId | ✅ | Из extraction |
| clientEntityId | ✅ | Из extraction (если resolved) |
| depth | ✅ | Hardcoded 0 |
| **description** | ❌ | NULL |
| **priority** | ❌ | NULL |
| **context** | ❌ | NULL |
| **deadline** | ❌ | NULL |
| **startDate** | ❌ | NULL |
| **endDate** | ❌ | NULL |
| **tags** | ❌ | NULL |
| **progress** | ❌ | NULL |
| **lastActivityAt** | ❌ | NULL |

**Последствия:**
- Проекты создаются как "пустышки" — только имя и owner
- Невозможна фильтрация по приоритету, дедлайну, тегам
- Контекст проекта (description) не сохраняется из обсуждения

### Решение

#### 8.1. Подключение ActivityMember

**Шаг 1: Создание ActivityMemberService**

```typescript
// apps/pkg-core/src/modules/activity/activity-member.service.ts
@Injectable()
export class ActivityMemberService {
  constructor(
    @InjectRepository(ActivityMember)
    private readonly memberRepo: Repository<ActivityMember>,
    @InjectRepository(Entity)
    private readonly entityRepo: Repository<Entity>,
  ) {}

  /**
   * Резолвит строковых участников в ActivityMember записи.
   * Связывает имена с Entity через fuzzy matching.
   */
  async resolveAndCreateMembers(
    activityId: string,
    participants: string[],
    ownerEntityId: string,
    clientEntityId?: string,
  ): Promise<ActivityMember[]> {
    const members: ActivityMember[] = [];

    // Owner — всегда первый member
    members.push(this.memberRepo.create({
      activityId,
      entityId: ownerEntityId,
      role: ActivityMemberRole.OWNER,
      joinedAt: new Date(),
    }));

    // Client — если есть
    if (clientEntityId) {
      members.push(this.memberRepo.create({
        activityId,
        entityId: clientEntityId,
        role: ActivityMemberRole.CLIENT,
        joinedAt: new Date(),
      }));
    }

    // Остальные участники — резолвим по имени
    for (const name of participants) {
      const entity = await this.resolveParticipant(name);
      if (entity) {
        // Проверяем, не добавлен ли уже (owner/client)
        if (!members.some(m => m.entityId === entity.id)) {
          members.push(this.memberRepo.create({
            activityId,
            entityId: entity.id,
            role: ActivityMemberRole.MEMBER,
            joinedAt: new Date(),
          }));
        }
      }
      // Если не резолвлен — логируем, но не теряем
    }

    return this.memberRepo.save(members);
  }

  private async resolveParticipant(name: string): Promise<Entity | null> {
    // Используем тот же подход, что и для ownerEntity
    return this.entityRepo
      .createQueryBuilder('e')
      .where('e.name ILIKE :name', { name: `%${name}%` })
      .andWhere('e.type = :type', { type: 'person' })
      .orderBy('e."updatedAt"', 'DESC')
      .getOne();
  }
}
```

**Шаг 2: Интеграция в extraction-persistence.service.ts**

```typescript
// После создания Activity (project или task):
const activity = await this.activityRepo.save(activityData);

// Вместо metadata.participants — создаём структурированные записи
if (project.participants?.length) {
  await this.activityMemberService.resolveAndCreateMembers(
    activity.id,
    project.participants,
    activity.ownerEntityId,
    activity.clientEntityId,
  );
}
```

**Шаг 3: Миграция существующих данных**

```sql
-- Извлечь participants из metadata и создать ActivityMember записи
-- (выполнять после deploy нового кода)
INSERT INTO activity_member (id, activity_id, entity_id, role, joined_at)
SELECT
  gen_random_uuid(),
  a.id,
  e.id,
  'member',
  a.created_at
FROM activity a,
     jsonb_array_elements_text(a.metadata->'participants') AS participant_name
JOIN entity e ON e.name ILIKE '%' || participant_name || '%'
  AND e.type = 'person'
WHERE a.metadata ? 'participants'
  AND a.activity_type IN ('project', 'task')
ON CONFLICT DO NOTHING;
```

#### 8.2. Привязка Commitment к Activity

**Шаг 1: Обогащение extraction prompt**

В промпте для LLM при извлечении commitments добавить:

```
For each commitment, if it clearly relates to a specific project being discussed,
include the projectName field matching one of the extracted projects.
```

**Шаг 2: Линковка в extraction-persistence.service.ts**

```typescript
// После создания всех activities, перед созданием commitments:
for (const commitment of extractedCommitments) {
  const commitmentData: Partial<Commitment> = {
    description: commitment.description,
    fromEntityId: resolvedFrom?.id,
    toEntityId: resolvedTo?.id,
    dueDate: commitment.dueDate,
  };

  // Привязка к Activity по имени проекта
  if (commitment.projectName) {
    const relatedActivity = createdActivities.find(
      a => a.name.toLowerCase().includes(commitment.projectName.toLowerCase())
    );
    if (relatedActivity) {
      commitmentData.activityId = relatedActivity.id;
    }
  }

  await this.commitmentRepo.save(commitmentData);
}
```

#### 8.3. Персистенция InferredRelations

**Шаг 1: Добавить сохранение в extraction-persistence.service.ts**

```typescript
async persistInferredRelations(
  relations: InferredRelation[],
  draftBatchId: string,
): Promise<void> {
  for (const rel of relations) {
    if (rel.confidence < 0.6) continue; // Только уверенные связи

    // Резолвим entity по именам
    const resolvedEntities = await Promise.all(
      rel.entities.map(name => this.resolveEntityByName(name))
    );
    const validEntities = resolvedEntities.filter(Boolean);

    if (validEntities.length < 2) continue; // Нужно минимум 2 участника

    // Проверяем, нет ли уже такой связи
    const existing = await this.findExistingRelation(
      validEntities.map(e => e.id),
      rel.relationType,
    );
    if (existing) continue;

    // Создаём EntityRelation + EntityRelationMembers
    const relation = await this.entityRelationRepo.save({
      type: rel.relationType,
      description: rel.description,
      confidence: rel.confidence,
      source: 'extraction',
      status: 'draft', // Требует подтверждения
      metadata: { draftBatchId },
    });

    const members = validEntities.map((entity, idx) => ({
      relationId: relation.id,
      entityId: entity.id,
      role: idx === 0 ? 'subject' : 'object',
    }));

    await this.entityRelationMemberRepo.save(members);
  }
}
```

**Шаг 2: Вызов из extraction pipeline**

```typescript
// В daily-synthesis-extraction.service.ts, после persistProjects/persistTasks:
if (extractionResult.inferredRelations?.length) {
  await this.persistenceService.persistInferredRelations(
    extractionResult.inferredRelations,
    draftBatchId,
  );
}
```

#### 8.4. Заполнение Activity полей из extraction

**Шаг 1: Обогатить ExtractedProject тип**

```typescript
interface ExtractedProject {
  name: string;
  participants: string[];
  ownerName?: string;
  clientName?: string;
  // Новые поля:
  description?: string;     // Краткое описание из контекста обсуждения
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  deadline?: string;        // ISO date если упоминается
  tags?: string[];           // Ключевые теги/категории
  sourceQuote?: string;
}
```

**Шаг 2: Обновить extraction prompt**

```
For each project, also extract if available:
- description: 1-2 sentence description based on discussion context
- priority: low/medium/high/urgent (if discussed or implied)
- deadline: ISO date if a specific deadline is mentioned
- tags: relevant category tags (e.g., ["marketing", "website"])
```

**Шаг 3: Маппинг в extraction-persistence.service.ts**

```typescript
const activityData: Partial<Activity> = {
  name: project.name,
  activityType: ActivityType.PROJECT,
  status: ActivityStatus.DRAFT,
  ownerEntityId: ownerEntity?.id,
  clientEntityId: clientEntity?.id,
  depth: 0,
  // Новые поля:
  description: project.description || null,
  priority: project.priority || null,
  deadline: project.deadline ? new Date(project.deadline) : null,
  tags: project.tags || [],
  lastActivityAt: new Date(), // Время последнего обсуждения
  metadata: {
    extractedFrom: 'daily_synthesis',
    synthesisDate,
    confidence: project.confidence,
    draftBatchId,
  },
  // Убираем participants из metadata — теперь через ActivityMember
};
```

### Acceptance Criteria

```gherkin
# 8.1 ActivityMember
Scenario: Project participants saved as ActivityMember
  Given extraction finds project "Website Redesign" with participants ["Иванов", "Петров"]
  When project is created
  Then ActivityMember records exist:
    | entityId       | role    |
    | owner-entity   | OWNER   |
    | client-entity  | CLIENT  |
    | ivanov-entity  | MEMBER  |
    | petrov-entity  | MEMBER  |
  And metadata.participants is NOT used

# 8.2 Commitment.activityId
Scenario: Commitment linked to Activity
  Given extraction finds commitment "Подготовить макеты к 15.02"
  And it relates to project "Website Redesign"
  When commitment is created
  Then commitment.activityId = activity.id of "Website Redesign"

# 8.3 InferredRelations persistence
Scenario: Inferred relations saved to EntityRelation
  Given extraction infers "Иванов works_at КомпанияХ" with confidence 0.8
  When extraction completes
  Then EntityRelation exists with type="works_at"
  And EntityRelationMember records link Иванов and КомпанияХ

# 8.4 Activity fields populated
Scenario: Activity created with enriched fields
  Given extraction finds project with description and deadline
  When project is created
  Then activity.description IS NOT NULL
  And activity.deadline IS NOT NULL
  And activity.lastActivityAt = current timestamp
```

### Связь с другими проблемами

| Проблема | Связь |
|----------|-------|
| Проблема 1 (Критерии) | Улучшенный LLM prompt извлекает больше полей |
| Проблема 2 (Matching) | ActivityMember позволяет matching по участникам |
| Проблема 3 (Client) | Client автоматически получает роль CLIENT в ActivityMember |
| Проблема 4 (Dedup) | Обогащённые поля улучшают точность dedup matching |
| Проблема 6 (Validation) | Новые поля дают больше данных для валидации |
| Проблема 7 (Quality) | DataQualityAgent проверяет наличие ActivityMember и заполненность полей |

---

## Migration Strategy

### Phase 1: Preparation (Week 1)

1. **Code Review текущей системы**
   - Audit всех мест создания проектов
   - Документировать текущие edge cases

2. **Создание новых сервисов (без breaking changes)**
   - ProjectMatchingService
   - ClientResolutionService
   - ActivityValidationService

3. **Добавление новых полей в entities**
   ```sql
   ALTER TABLE activity
   ADD COLUMN short_name VARCHAR(100),
   ADD COLUMN metadata JSONB DEFAULT '{}';
   ```

4. **Unit тесты для новых сервисов**

### Phase 2: Incremental Rollout (Week 2-3)

1. **Enable improved project matching** (за feature flag)
   ```typescript
   const USE_NEW_MATCHING = process.env.ENABLE_IMPROVED_MATCHING === 'true';
   ```

2. **A/B тестирование на production**
   - 10% запросов через новый алгоритм
   - Логировать differences между old/new
   - Постепенно увеличивать до 100%

3. **Enable improved client resolution** (feature flag)

4. **Enable improved deduplication**

### Phase 3: Entity Wiring — подключение "спящих" entity (Week 4)

> Эта фаза закрывает разрыв между моделью данных и её использованием (Проблема 8).

1. **ActivityMember wiring**
   - Создать ActivityMemberService
   - Интегрировать в extraction-persistence.service.ts
   - Миграция: извлечь metadata.participants → ActivityMember записи
   - Тесты: создание, резолвинг участников, дубли

2. **Commitment → Activity линковка**
   - Обогатить extraction prompt (projectName в commitments)
   - Добавить activityId маппинг в extraction-persistence.service.ts
   - Миграция: попытка привязать existing commitments к activities по контексту

3. **InferredRelations persistence**
   - Добавить persistInferredRelations в extraction-persistence.service.ts
   - Создать draft EntityRelation + EntityRelationMembers с approval flow
   - Тесты: дедупликация, confidence threshold, N-ary relations

4. **Activity fields enrichment**
   - Обогатить ExtractedProject тип (description, priority, deadline, tags)
   - Обновить extraction prompt для извлечения дополнительных полей
   - Обновить маппинг в extraction-persistence.service.ts
   - Тесты: заполненность полей, парсинг дат

### Phase 4: REST API (Week 5)

1. **Deploy ProjectController**
2. **Update Mini App** для использования API
3. **Documentation** для API endpoints

### Phase 5: Cleanup (Week 6)

1. **Remove feature flags**
2. **Delete old code**
3. **Performance optimization**
4. **Monitoring dashboards**

### Phase 6: Data Quality System (Week 7)

1. **Create DataQualityReport entity** и миграция
2. **Implement DataQualityService** с agent integration
3. **Add DataQualityController** endpoints
4. **Create data quality tools** (check_duplicates, validate_relationships, check_orphaned_members)
5. **Build Mini App UI** с кнопкой запуска и отображением отчётов
6. **Documentation** для system administrators

### Phase 7: KNOWLEDGE_GRAPH.md Reconciliation (Week 8)

1. **Обновить KNOWLEDGE_GRAPH.md** — добавить статус реализации к каждой entity
2. **Добавить секцию "Implementation Status"** с матрицей готовности
3. **Убрать phantom entities** (DataQualityReport как часть KG — только после реализации)
4. **Выровнять** дерево Activity с тем, что реально создаёт extraction

---

## Rollback Plan

### If extraction quality degrades:

1. **Immediate: Feature flag OFF**
   ```bash
   # На сервере
   export ENABLE_IMPROVED_MATCHING=false
   docker compose restart pkg-core
   ```

2. **Database rollback (if needed)**
   ```sql
   -- Restore from backup
   pg_restore -d pkg_db /backups/pre-migration.dump
   ```

3. **Revert code** (git revert)

### Monitoring thresholds for rollback:

- False positive rate >30% → rollback
- API error rate >5% → rollback
- User complaints spike → investigate → rollback if confirmed

---

## Success Metrics

### Extraction Quality

| Metric | Baseline | Target | Critical |
|--------|----------|--------|----------|
| False positive rate | 40% | <15% | >50% |
| Precision | 60% | >85% | <50% |
| Recall | ~70% | >80% | <60% |

### Matching Accuracy

| Metric | Baseline | Target | Critical |
|--------|----------|--------|----------|
| False match rate | 30% | <10% | >40% |
| True negative rate | 70% | >90% | <60% |

### Client Resolution

| Metric | Baseline | Target | Critical |
|--------|----------|--------|----------|
| False client assignment | 25% | <5% | >30% |
| Ambiguous cases handled | ~10% | >95% | <50% |

### Deduplication

| Metric | Baseline | Target | Critical |
|--------|----------|--------|----------|
| Active duplicates created | ~20% | <5% | >25% |
| Pending duplicates caught | ~60% | >95% | <70% |

### API Performance

| Metric | Target |
|--------|--------|
| Response time (p95) | <200ms |
| Error rate | <1% |
| Throughput | >100 req/s |

### Entity Wiring (Проблема 8)

| Metric | Baseline | Target | Critical |
|--------|----------|--------|----------|
| Activities с ActivityMember записями | 0% | >90% | <50% |
| Commitments с activityId | 0% | >70% | <30% |
| InferredRelations persisted per extraction | 0 | >3 avg | 0 (не работает) |
| Activity fields filled (description/priority) | 0% | >60% | <20% |
| Participant resolve rate (name → Entity) | 0% | >75% | <40% |

### Data Quality System

| Metric | Target |
|--------|--------|
| Quality check completion time (p95) | <30s |
| Issues detection accuracy | >90% |
| False positive rate | <10% |
| User adoption (monthly active) | >30% |

---

## Monitoring & Alerting

### Dashboards

**Extraction Quality Dashboard:**
- Projects created per day
- Confidence score distribution
- False positive rate (manual reviews)
- Filtering rate (low quality projects)

**Matching Dashboard:**
- Match type distribution (exact/high/medium/low/no_match)
- Average match score
- False matches per week

**Client Resolution Dashboard:**
- Resolution method distribution (exact/identifier/fuzzy/ambiguous)
- Average confidence score
- Ambiguous cases requiring manual resolution

**API Dashboard:**
- Request rate per endpoint
- Response time percentiles
- Error rate
- Top error messages

**Entity Wiring Dashboard:**
- ActivityMember coverage (% activities с member записями)
- Participant resolve rate (resolved / total names)
- Commitment → Activity linkage rate
- InferredRelations created per extraction run
- Activity field fill rate (non-null description, priority, deadline)

### Alerts

```yaml
alerts:
  - name: high_false_positive_rate
    condition: false_positive_rate > 0.30
    severity: critical
    action: rollback_feature

  - name: api_error_rate_spike
    condition: error_rate_5m > 0.05
    severity: critical
    action: page_oncall

  - name: ambiguous_client_backlog
    condition: pending_resolutions > 50
    severity: warning
    action: notify_team
```

---

## Timeline

| Week | Phase | Tasks |
|------|-------|-------|
| 1 | Preparation | Code audit, новые сервисы, unit tests |
| 2 | Rollout P1 | Project matching + client resolution (A/B) |
| 3 | Rollout P2 | Deduplication + validation (A/B) |
| 4 | Entity Wiring | ActivityMember, Commitment→Activity, InferredRelations, Activity fields |
| 5 | REST API | ProjectController + Mini App integration |
| 6 | Cleanup | Remove flags, delete old code, optimization |
| 7 | Data Quality | DataQualityService + agent tools + Mini App UI |
| 8 | KG Reconciliation | Обновить KNOWLEDGE_GRAPH.md, выровнять документацию с реальностью |

**Total: ~8 weeks**

> **Примечание:** Week 4 (Entity Wiring) — критически важная фаза, которая "подключает" уже реализованные, но неиспользуемые entity. Это инвестиция, которая многократно окупается: ActivityMember улучшает matching (Проблема 2), InferredRelations обогащают context, а заполненные поля Activity повышают точность dedup (Проблема 4).

---

## Next Steps

1. **Review этого плана** с командой — особенно Проблему 8 (Entity Wiring)
2. **Prioritize** проблемы (рекомендация: начать с 1+8 параллельно — критерии + entity wiring)
3. **Create GitHub issues** для каждой фазы (8 issues по одной на Phase)
4. **Обновить KNOWLEDGE_GRAPH.md** — добавить столбец "Implementation Status" к каждой entity
5. **Assign owners** для каждого компонента
6. **Schedule kickoff meeting**

---

## Appendix: Code Samples

### A. Full Levenshtein Implementation

```typescript
function levenshteinDistance(str1: string, str2: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      const cost = str1[j - 1] === str2[i - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,        // deletion
        matrix[i][j - 1] + 1,        // insertion
        matrix[i - 1][j - 1] + cost, // substitution
      );
    }
  }

  return matrix[str2.length][str1.length];
}
```

### B. SQL Query Examples

```sql
-- Find projects with low task count (potential false positives)
SELECT
  a.id,
  a.name,
  a.created_at,
  COUNT(child.id) as task_count
FROM activity a
LEFT JOIN activity child ON child.parent_id = a.id AND child.activity_type = 'task'
WHERE a.activity_type = 'project'
  AND a.status = 'active'
  AND a.created_at > NOW() - INTERVAL '30 days'
GROUP BY a.id
HAVING COUNT(child.id) < 2
ORDER BY a.created_at DESC;

-- Find duplicate projects
SELECT
  name,
  owner_entity_id,
  COUNT(*) as count,
  ARRAY_AGG(id) as ids
FROM activity
WHERE activity_type = 'project'
  AND status IN ('active', 'draft')
GROUP BY name, owner_entity_id
HAVING COUNT(*) > 1;

-- Find projects with PERSON as client (invalid)
SELECT
  a.id,
  a.name,
  e.name as client_name,
  e.type as client_type
FROM activity a
INNER JOIN entity e ON a.client_entity_id = e.id
WHERE a.activity_type = 'project'
  AND e.type = 'person';
```

---

## References

- [PKG ARCHITECTURE.md](/Users/mityayka/work/projects/PKG/docs/ARCHITECTURE.md)
- [PKG DATA_MODEL.md](/Users/mityayka/work/projects/PKG/docs/DATA_MODEL.md)
- [Second Brain INDEX](/Users/mityayka/work/projects/PKG/docs/second-brain/INDEX.md)
- TypeORM Closure Table: https://typeorm.io/tree-entities#closure-table
- Levenshtein Distance: https://en.wikipedia.org/wiki/Levenshtein_distance

---

**Конец документа.**
