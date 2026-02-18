# Context-Aware Extraction — Design Document

> **Статус:** ✅ Completed — реализовано в SecondBrainExtractionService
> **Дата:** 2025-01-24
> **Авторы:** Human + Claude

---

## 1. Концепция "Память сущности"

### Философия

**Память** — не просто список актуальных фактов, а полная история знаний о сущности:
- Текущие факты
- История изменений (с временными метками)
- Связи с другими сущностями

**Факт** — вывод, сделанный на основе сообщения И существующей памяти.

### Memory Loop

```
┌─────────────────────────────────────────────────────────┐
│                    MEMORY LOOP                           │
├─────────────────────────────────────────────────────────┤
│                                                          │
│   Память сущности ──────────────────────┐               │
│   (факты + история + связи)             │               │
│                                         ▼               │
│                                 ┌───────────────┐       │
│                                 │ Новое         │       │
│                                 │ сообщение     │       │
│                                 └───────┬───────┘       │
│                                         ▼               │
│                                 ┌───────────────┐       │
│                                 │ Extraction    │       │
│                                 │ Agent + Tools │       │
│                                 └───────┬───────┘       │
│                                         │               │
│         ┌───────────────────────────────┤               │
│         ▼                               ▼               │
│   ┌───────────┐                 ┌───────────────┐       │
│   │ Новый факт│                 │ Новая связь   │       │
│   └─────┬─────┘                 └───────┬───────┘       │
│         │                               │               │
│         └───────────────┬───────────────┘               │
│                         ▼                               │
│                 Память обогащается                      │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### Ключевые принципы

| Принцип | Описание |
|---------|----------|
| **Границы знаний** | Каждый факт принадлежит конкретной сущности |
| **Маршрутизация** | "Маша в Сбере" → факт для entityId Марии, не текущего контакта |
| **Темпоральность** | История сохраняется через `validFrom`/`validUntil` |
| **Связи = мосты** | Через связи получаем контекст связанных сущностей |

---

## 2. Структурированный контекст для Extraction

### Решение

Передаём LLM структурированный список фактов (не синтезированный текст). LLM сам понимает структуру.

### Формат контекста

```
ПАМЯТЬ О [ИМЯ]:
━━━━━━━━━━━━━━━━━━━━━━

ФАКТЫ (текущие):
• company: Тинькофф (с 2025-03)
• position: CMO (с 2025-03)
• birthday: 15 марта 1985

ИСТОРИЯ:
• company: Сбербанк (2020 — 2025-03)
• position: VP Engineering (2020 — 2025-03)

СВЯЗИ:
• spouse: Мария (entityId: xxx) — "жена", "Маша"
• colleague: Петя (entityId: yyy)
• works_at: ИИ-сервисы (entityId: zzz)
```

### API

```typescript
// EntityFactService
async getContextForExtraction(entityId: string): Promise<string> {
  const currentFacts = await this.findByEntityWithRanking(entityId);
  const historyFacts = await this.findHistory(entityId, { limit: 10 });
  const relations = await this.relationService.findByEntity(entityId);

  return this.formatStructuredContext(currentFacts, historyFacts, relations);
}
```

### Smart Fusion

При совпадении фактов `FactFusionService` принимает решение:
- `CONFIRM` — подтвердить существующий (увеличить confidence)
- `SUPERSEDE` — заменить старый новым (старый получает validUntil)
- `ENRICH` — объединить информацию
- `CONFLICT` — требует ручного решения

Значение `value` остаётся **атомарным** для поиска. История доступна через `validFrom`/`validUntil`.

---

## 3. EntityRelation — Модель связей (Вариант 4)

### Обоснование выбора

Выбран **Вариант 4 (связь как пара с ролями)** потому что:
- Поддержка N-арных связей (команды, семьи)
- Нет дублирования типа связи
- Роли явные и валидируемые
- Гибкость для будущего развития

### Модель данных

```typescript
// ═══════════════════════════════════════════════════════════
// ENTITY RELATION — контейнер связи
// ═══════════════════════════════════════════════════════════

@Entity('entity_relations')
export class EntityRelation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'relation_type', length: 50 })
  relationType: RelationType;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown>;  // { since: '2020', note: '...' }

  @Column({ length: 20, default: 'extracted' })
  source: 'manual' | 'extracted' | 'imported';

  @Column({ type: 'decimal', precision: 3, scale: 2, nullable: true })
  confidence: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => EntityRelationMember, member => member.relation, {
    cascade: true,
    eager: true
  })
  members: EntityRelationMember[];
}

// ═══════════════════════════════════════════════════════════
// ENTITY RELATION MEMBER — участник связи с ролью
// ═══════════════════════════════════════════════════════════

@Entity('entity_relation_members')
export class EntityRelationMember {
  @PrimaryColumn({ name: 'relation_id', type: 'uuid' })
  relationId: string;

  @PrimaryColumn({ name: 'entity_id', type: 'uuid' })
  entityId: string;

  @PrimaryColumn({ length: 50 })
  role: string;

  @Column({ length: 100, nullable: true })
  label: string;  // "Маша", "директор"

  @Column({ type: 'jsonb', nullable: true })
  properties: Record<string, unknown>;

  @Column({ name: 'valid_until', type: 'timestamp', nullable: true })
  validUntil: Date | null;  // Для soft delete

  @ManyToOne(() => EntityRelation, rel => rel.members, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'relation_id' })
  relation: EntityRelation;

  @ManyToOne(() => EntityRecord, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'entity_id' })
  entity: EntityRecord;
}
```

### Типы связей и роли

```typescript
enum RelationType {
  // Работа
  EMPLOYMENT = 'employment',      // roles: employee, employer
  REPORTING = 'reporting',        // roles: subordinate, manager
  TEAM = 'team',                  // roles: member, lead

  // Семья
  MARRIAGE = 'marriage',          // roles: spouse
  PARENTHOOD = 'parenthood',      // roles: parent, child
  SIBLINGHOOD = 'siblinghood',    // roles: sibling

  // Социальные
  FRIENDSHIP = 'friendship',      // roles: friend
  ACQUAINTANCE = 'acquaintance',  // roles: acquaintance

  // Бизнес
  PARTNERSHIP = 'partnership',    // roles: partner
  CLIENT_VENDOR = 'client_vendor', // roles: client, vendor
}

const RELATION_ROLES: Record<RelationType, string[]> = {
  employment: ['employee', 'employer'],
  reporting: ['subordinate', 'manager'],
  team: ['member', 'lead'],
  marriage: ['spouse'],
  parenthood: ['parent', 'child'],
  siblinghood: ['sibling'],
  friendship: ['friend'],
  acquaintance: ['acquaintance'],
  partnership: ['partner'],
  client_vendor: ['client', 'vendor'],
};

const RELATION_CARDINALITY: Record<RelationType, { min: number; max: number }> = {
  employment: { min: 2, max: 2 },
  reporting: { min: 2, max: 2 },
  team: { min: 2, max: 100 },
  marriage: { min: 2, max: 2 },
  parenthood: { min: 2, max: 2 },
  siblinghood: { min: 2, max: 20 },
  friendship: { min: 2, max: 2 },
  acquaintance: { min: 2, max: 2 },
  partnership: { min: 2, max: 10 },
  client_vendor: { min: 2, max: 2 },
};
```

### Миграция

```sql
-- Типы
CREATE TYPE relation_type AS ENUM (
  'employment', 'reporting', 'team',
  'marriage', 'parenthood', 'siblinghood',
  'friendship', 'acquaintance',
  'partnership', 'client_vendor'
);

CREATE TYPE relation_source AS ENUM ('manual', 'extracted', 'imported');

-- Таблица связей
CREATE TABLE entity_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relation_type relation_type NOT NULL,
  metadata JSONB,
  source relation_source DEFAULT 'extracted',
  confidence DECIMAL(3,2),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Таблица участников
CREATE TABLE entity_relation_members (
  relation_id UUID NOT NULL REFERENCES entity_relations(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL,
  label VARCHAR(100),
  properties JSONB,
  valid_until TIMESTAMP,
  PRIMARY KEY (relation_id, entity_id, role)
);

-- Индексы
CREATE INDEX idx_relation_members_entity ON entity_relation_members(entity_id);
CREATE INDEX idx_relation_members_relation ON entity_relation_members(relation_id);
CREATE INDEX idx_relation_members_valid ON entity_relation_members(entity_id) WHERE valid_until IS NULL;
CREATE INDEX idx_relations_type ON entity_relations(relation_type);

-- Триггер для очистки пустых связей
CREATE OR REPLACE FUNCTION cleanup_empty_relations()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM entity_relations r
  WHERE NOT EXISTS (
    SELECT 1 FROM entity_relation_members m
    WHERE m.relation_id = r.id AND m.valid_until IS NULL
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cleanup_relations
AFTER UPDATE OR DELETE ON entity_relation_members
FOR EACH STATEMENT EXECUTE FUNCTION cleanup_empty_relations();
```

---

## 4. Extraction Agent

### Архитектура

Extraction становится **агентным** — LLM вызывает tools для получения контекста и записи результатов.

```
Сообщение: "Маша уже в Сбере, а Петька всё ещё у нас"
Контекст чата: диалог с Иваном

═══════════════════════════════════════════════════════════

LLM получает:
• Сообщение
• Базовый контекст Ивана (факты + связи с ID)

LLM анализирует:
• "Маша" — есть в связях (spouse, id: xxx)
• "Петька" — есть в связях (colleague, id: yyy)

→ tool_call: get_entity_context(xxx)  // Маша
→ tool_call: get_entity_context(yyy)  // Петя

LLM получает контексты, создаёт факты:

→ create_fact(entityId: xxx, type: 'company', value: 'Сбербанк')
→ create_fact(entityId: yyy, type: 'company', value: 'Тинькофф')

═══════════════════════════════════════════════════════════
```

### Tools

```typescript
const extractionTools = [
  // ═══════════════════════════════════════════
  // ЧТЕНИЕ
  // ═══════════════════════════════════════════

  tool('get_entity_context',
    'Получить память о сущности: факты, историю, связи',
    { entityId: z.string().uuid().describe('ID сущности') },
    handler
  ),

  tool('find_entity_by_name',
    'Найти сущность по имени/alias',
    { name: z.string().describe('Имя для поиска') },
    handler
  ),

  // ═══════════════════════════════════════════
  // ЗАПИСЬ
  // ═══════════════════════════════════════════

  tool('create_fact',
    'Создать факт (пройдёт через Smart Fusion)',
    {
      entityId: z.string().uuid().describe('ID сущности-владельца факта'),
      factType: z.string().describe('Тип: position, company, birthday, phone, email'),
      value: z.string().describe('Значение факта'),
      confidence: z.number().min(0).max(1).describe('Уверенность 0-1'),
      sourceQuote: z.string().describe('Цитата из сообщения')
    },
    handler
  ),

  tool('create_relation',
    `Создать связь между сущностями.

     Типы: employment, reporting, team, marriage, parenthood, friendship

     Примеры:
     - "работает в Сбере" → employment, [person/employee, org/employer]
     - "мой начальник" → reporting, [me/subordinate, boss/manager]`,
    {
      relationType: z.enum([...]),
      members: z.array(z.object({
        entityId: z.string().uuid(),
        role: z.string(),
        label: z.string().optional()
      })).min(2).describe('Участники с ролями')
    },
    handler
  ),

  tool('create_pending_entity',
    'Создать ожидающую сущность (упомянут человек, которого нет в системе)',
    {
      suggestedName: z.string(),
      mentionedAs: z.string().describe('Контекст упоминания: "жена Ивана"'),
      relatedToEntityId: z.string().uuid().optional()
    },
    handler
  )
];
```

---

## 5. Риски и митигация

| Риск | Уровень | Митигация |
|------|---------|-----------|
| Сложность запросов к связям | ⚠️ Средний | Абстракция в `EntityRelationService` |
| N-арные изменения (уход из команды) | ⚠️ Средний | Soft delete через `validUntil` |
| Дубликаты связей | ⚠️ Средний | Дедупликация при создании |
| Производительность на больших графах | 🟢 Низкий | Индексы + пагинация |
| Orphaned relations | 🟢 Низкий | CASCADE DELETE + триггер очистки |
| LLM ошибки в создании связей | ⚠️ Средний | Валидация ролей + примеры в tool description |

---

## 6. План реализации

### Этап 1: Контекст для Extraction (Quick Win)
- [ ] `EntityFactService.getContextForExtraction()`
- [ ] `EntityFactService.findHistory()`
- [ ] Интеграция контекста в `FactExtractionService`

### Этап 2: EntityRelation
- [ ] Entity `EntityRelation` + `EntityRelationMember`
- [ ] Миграция
- [ ] `EntityRelationService` (CRUD, findByEntity, дедупликация)
- [ ] Интеграция в контекст extraction

### Этап 3: Extraction Agent
- [ ] Tools: `get_entity_context`, `find_entity_by_name`
- [ ] Tools: `create_fact`, `create_relation`, `create_pending_entity`
- [ ] Агентный flow в `FactExtractionService`
- [ ] Extraction связей из сообщений

### Этап 4: Subject Resolution (групповые чаты)
- [ ] Алгоритм определения субъекта факта
- [ ] Поддержка reply context
- [ ] Поддержка @mentions

---

## 7. Acceptance Criteria

- [ ] При extraction передаётся структурированный контекст (факты + история + связи)
- [ ] "Маша (жена) передаёт привет" не создаёт факт для текущего контакта
- [ ] Связи извлекаются и сохраняются в `EntityRelation`
- [ ] LLM может запросить контекст связанной сущности через tool
- [ ] Факты маршрутизируются правильным сущностям
- [ ] В групповых чатах факты распределяются по участникам
- [ ] Семейные и рабочие связи отображаются вместе в профиле сущности
