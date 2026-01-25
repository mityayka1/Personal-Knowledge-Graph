# Relation Inference — Implementation Plan

> **Статус:** 🔄 In Progress
> **Дата:** 2025-01-26
> **Ветка:** `feat/relation-inference`

---

## Проблема

Entity Relations не создаются автоматически при extraction:
- Tool `create_relation` существует и работает
- Prompt упоминает его использование
- Но LLM не вызывает tool → 0 записей в `entity_relations`

**Данные на момент анализа:**
- `entity_facts`: 32 записи ✅
- `extracted_events`: 721 запись ✅
- `entity_relations`: 0 записей ❌

---

## Решение: Два этапа

### Этап 1: Улучшение Tool Description (Вариант B)

**Цель:** Побудить LLM чаще вызывать `create_relation`

**Изменения:**
- Улучшить description в `extraction-tools.provider.ts`
- Добавить явные триггеры (какие фразы → какой relation type)
- Добавить пошаговый алгоритм
- Добавить полный пример flow

**Файл:** `apps/pkg-core/src/modules/extraction/tools/extraction-tools.provider.ts`

### Этап 2: Post-processing сервис (Вариант C)

**Цель:** Создавать relations из существующих фактов

**Новые файлы:**
- `apps/pkg-core/src/modules/extraction/relation-inference.service.ts`
- `apps/pkg-core/src/modules/extraction/relation-inference.service.spec.ts`

**Изменения:**
- Добавить `INFERRED` в `RelationSource` enum
- Добавить метод `findByPair()` в `EntityRelationService`
- Интегрировать вызов после extraction
- Добавить API endpoint для ручного запуска

---

## Этап 1: Tool Description

### Текущий description (строки 269-287)

```typescript
`Создать связь между сущностями.

Типы связей и роли:
- employment: employee (работник), employer (работодатель)
...`
```

### Новый description

```typescript
`ОБЯЗАТЕЛЬНО создавай связь при любом упоминании отношений между людьми/организациями!

ТРИГГЕРЫ — вызывай create_relation когда видишь:
• Рабочие: "работает в", "устроился в", "уволился из", "коллега", "начальник", "подчинённый"
• Семейные: "жена", "муж", "сын", "дочь", "брат", "сестра", "родители"
• Социальные: "друг", "знакомый", "партнёр"

АЛГОРИТМ:
1. Найди обе сущности через find_entity_by_name
2. Если не найдена — создай через create_pending_entity
3. Затем вызови create_relation с ID обеих сущностей

Типы связей и роли:
• employment: employee ↔ employer — "работает в X", "сотрудник Y"
• reporting: subordinate ↔ manager — "начальник", "руководитель"
• team: member ↔ lead — "в команде", "тимлид"
• marriage: spouse ↔ spouse — "жена", "муж"
• parenthood: parent ↔ child — "отец", "мать", "сын", "дочь"
• siblinghood: sibling ↔ sibling — "брат", "сестра"
• friendship: friend ↔ friend — "друг", "подруга"
• acquaintance: acquaintance — "знакомый"

ПРИМЕР ПОЛНОГО FLOW:
Сообщение: "Маша работает в Сбере"
1. find_entity_by_name("Маша") → entityId: "abc-123"
2. find_entity_by_name("Сбер") → entityId: "xyz-789"
3. create_relation(employment, [{entityId: "abc-123", role: "employee"}, {entityId: "xyz-789", role: "employer"}])

Если сущность не найдена:
1. find_entity_by_name("Сбер") → пусто
2. create_pending_entity(suggestedName: "Сбер", mentionedAs: "место работы Маши")
3. Связь создаём позже, когда pending entity будет resolved`
```

### Критерии приёмки (Этап 1)
- [ ] Description обновлён в `extraction-tools.provider.ts`
- [ ] Добавлены триггерные фразы
- [ ] Добавлен алгоритм действий
- [ ] Добавлен полный пример flow
- [ ] Unit тест не сломан

---

## Этап 2: Relation Inference Service

### Архитектура

```
entity_facts                    RelationInferenceService
┌─────────────┐                ┌───────────────────────┐
│ company:    │                │                       │
│ "Сбер"      │ ──────────────►│ findUnlinkedFacts()   │
│ entityId: X │                │         │             │
└─────────────┘                │         ▼             │
                               │ matchOrganization()   │
entities                       │         │             │
┌─────────────┐                │         ▼             │
│ name: Сбер  │ ◄──────────────│ createRelation()      │
│ type: org   │                │                       │
│ id: Y       │                └───────────────────────┘
└─────────────┘                          │
                                         ▼
                               entity_relations
                               ┌─────────────────┐
                               │ employment      │
                               │ X ↔ Y           │
                               │ source: INFERRED│
                               └─────────────────┘
```

### Новые файлы

**1. RelationInferenceService**
```typescript
// apps/pkg-core/src/modules/extraction/relation-inference.service.ts

@Injectable()
export class RelationInferenceService {
  async inferRelations(options?: InferenceOptions): Promise<InferenceResult>;
  private findUnlinkedCompanyFacts(sinceDate?: Date): Promise<EntityFact[]>;
  private findOrganizationByName(name: string): Promise<EntityRecord | null>;
  private normalizeCompanyName(name: string): string;
  private similarity(a: string, b: string): number;
}
```

**2. Новый source type**
```typescript
// packages/entities/src/relation-source.enum.ts
export enum RelationSource {
  MANUAL = 'manual',
  EXTRACTED = 'extracted',
  IMPORTED = 'imported',
  INFERRED = 'inferred',  // NEW
}
```

**3. Метод findByPair в EntityRelationService**
```typescript
async findByPair(
  entityId1: string,
  entityId2: string,
  relationType?: RelationType,
): Promise<EntityRelation | null>;
```

**4. API endpoint**
```typescript
// В extraction.controller.ts
@Post('relations/infer')
async inferRelations(@Query('dryRun') dryRun?: boolean): Promise<InferenceResult>;
```

### Критерии приёмки (Этап 2)
- [ ] `RelationInferenceService` создан и работает
- [ ] `INFERRED` добавлен в `RelationSource`
- [ ] `findByPair()` добавлен в `EntityRelationService`
- [ ] API endpoint `/extraction/relations/infer` работает
- [ ] Unit тесты для inference logic
- [ ] Dry-run режим работает
- [ ] Логирование результатов

---

## Порядок реализации

```
1. Создать feature branch
2. Этап 1: Tool Description
   └── Изменить extraction-tools.provider.ts
3. Этап 2: Inference Service
   ├── Добавить INFERRED в RelationSource
   ├── Добавить findByPair() в EntityRelationService
   ├── Создать RelationInferenceService
   ├── Добавить API endpoint
   └── Написать тесты
4. Создать PR
```

---

## Тестирование

### Manual Testing

```bash
# 1. После Этапа 1: проверить через agent endpoint
curl -X POST http://localhost:3000/extraction/facts/agent \
  -H "Content-Type: application/json" \
  -d '{"entityId":"...", "entityName":"Тест", "messageContent":"Маша работает в Сбере"}'

# 2. После Этапа 2: запустить inference
curl -X POST "http://localhost:3000/extraction/relations/infer?dryRun=true"

# 3. Проверить созданные relations
psql -c "SELECT * FROM entity_relations"
```

### Unit Tests

```bash
pnpm test -- relation-inference.service.spec.ts
pnpm test -- extraction-tools.provider.spec.ts
```

---

## Риски и митигация

| Риск | Митигация |
|------|-----------|
| LLM всё равно не вызывает tool | Этап 2 (inference) как backup |
| Fuzzy matching ошибается | Порог similarity 0.8, dry-run режим |
| Дубликаты relations | Проверка findByPair() перед созданием |
| Нет организаций в БД | Логирование skipped, возможность создать pending |

