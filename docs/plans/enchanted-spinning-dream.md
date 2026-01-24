# Context-Aware Extraction — Implementation Plan

> **Статус:** В разработке
> **Дизайн:** [2025-01-24-context-aware-extraction-design.md](./2025-01-24-context-aware-extraction-design.md)
> **Дата:** 2025-01-24

---

## Обзор

Реализация контекстно-зависимого извлечения фактов с поддержкой:
- **Memory Loop** — факты как выводы на основе существующей памяти
- **EntityRelation** — N-арные связи между сущностями (Вариант 4)
- **Extraction Agent** — агентный подход с tools для lazy loading контекста
- **Cross-entity routing** — "Маша в Сбере" → факт для Маши, не текущего контакта

---

## Этап 1: Context for Extraction (Quick Win)

**Цель:** Передавать структурированный контекст (факты + история) в extraction

### Задачи

#### 1.1 EntityFactService.findHistory()
**Файл:** `apps/pkg-core/src/modules/entity/entity-fact/entity-fact.service.ts`

```typescript
async findHistory(entityId: string, options?: { limit?: number }): Promise<EntityFact[]> {
  return this.factRepository.find({
    where: {
      entityId,
      validUntil: Not(IsNull()),  // Только исторические
    },
    order: { validUntil: 'DESC' },
    take: options?.limit ?? 10,
  });
}
```

#### 1.2 EntityFactService.getContextForExtraction()
**Файл:** `apps/pkg-core/src/modules/entity/entity-fact/entity-fact.service.ts`

```typescript
async getContextForExtraction(entityId: string): Promise<string> {
  const entity = await this.entityService.findById(entityId);
  const currentFacts = await this.findByEntityWithRanking(entityId);
  const historyFacts = await this.findHistory(entityId, { limit: 10 });

  return this.formatStructuredContext(entity, currentFacts, historyFacts);
}

private formatStructuredContext(
  entity: EntityRecord,
  current: EntityFact[],
  history: EntityFact[]
): string {
  const lines: string[] = [
    `ПАМЯТЬ О ${entity.displayName}:`,
    '━━━━━━━━━━━━━━━━━━━━━━',
    '',
    'ФАКТЫ (текущие):',
  ];

  for (const fact of current.filter(f => f.ranking === 'preferred')) {
    const since = fact.validFrom ? ` (с ${this.formatDate(fact.validFrom)})` : '';
    lines.push(`• ${fact.factType}: ${fact.value}${since}`);
  }

  if (history.length > 0) {
    lines.push('', 'ИСТОРИЯ:');
    for (const fact of history) {
      const period = `(${this.formatDate(fact.validFrom)} — ${this.formatDate(fact.validUntil)})`;
      lines.push(`• ${fact.factType}: ${fact.value} ${period}`);
    }
  }

  return lines.join('\n');
}
```

#### 1.3 Интеграция в FactExtractionService
**Файл:** `apps/pkg-core/src/modules/extraction/fact-extraction.service.ts`

Добавить контекст в prompt:

```typescript
async extractFacts(messageId: string): Promise<ExtractedFact[]> {
  const message = await this.messageService.findById(messageId);
  const context = await this.entityFactService.getContextForExtraction(message.entityId);

  const prompt = `
${context}

═══════════════════════════════════════════════════════════
НОВОЕ СООБЩЕНИЕ:
${message.content}
═══════════════════════════════════════════════════════════

Извлеки факты из сообщения с учётом существующей памяти.
`;

  // ... остальная логика
}
```

### Критерии приёмки (Этап 1)
- [ ] `findHistory()` возвращает факты с `validUntil IS NOT NULL`
- [ ] `getContextForExtraction()` формирует структурированный текст
- [ ] Контекст передаётся в prompt при extraction
- [ ] Unit-тесты для новых методов

---

## Этап 2: EntityRelation

**Цель:** Создать инфраструктуру для хранения связей между сущностями

### Задачи

#### 2.1 Entities
**Создать файлы:**
- `packages/entities/src/entity-relation.entity.ts`
- `packages/entities/src/entity-relation-member.entity.ts`
- `packages/entities/src/relation-type.enum.ts`

**entity-relation.entity.ts:**
```typescript
@Entity('entity_relations')
export class EntityRelation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'relation_type', length: 50 })
  relationType: RelationType;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown>;

  @Column({ length: 20, default: 'extracted' })
  source: 'manual' | 'extracted' | 'imported';

  @Column({ type: 'decimal', precision: 3, scale: 2, nullable: true })
  confidence: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => EntityRelationMember, m => m.relation, { cascade: true, eager: true })
  members: EntityRelationMember[];
}
```

**entity-relation-member.entity.ts:**
```typescript
@Entity('entity_relation_members')
export class EntityRelationMember {
  @PrimaryColumn({ name: 'relation_id', type: 'uuid' })
  relationId: string;

  @PrimaryColumn({ name: 'entity_id', type: 'uuid' })
  entityId: string;

  @PrimaryColumn({ length: 50 })
  role: string;

  @Column({ length: 100, nullable: true })
  label: string;

  @Column({ type: 'jsonb', nullable: true })
  properties: Record<string, unknown>;

  @Column({ name: 'valid_until', type: 'timestamp', nullable: true })
  validUntil: Date | null;

  @ManyToOne(() => EntityRelation, r => r.members, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'relation_id' })
  relation: EntityRelation;

  @ManyToOne(() => EntityRecord, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'entity_id' })
  entity: EntityRecord;
}
```

#### 2.2 Миграция
**Создать:** `apps/pkg-core/src/migrations/XXXXXX-CreateEntityRelations.ts`

```sql
-- Таблица связей
CREATE TABLE entity_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relation_type VARCHAR(50) NOT NULL,
  metadata JSONB,
  source VARCHAR(20) DEFAULT 'extracted',
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
CREATE INDEX idx_relation_members_valid ON entity_relation_members(entity_id)
  WHERE valid_until IS NULL;
CREATE INDEX idx_relations_type ON entity_relations(relation_type);

-- Триггер очистки пустых связей
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

#### 2.3 EntityRelationService
**Создать:** `apps/pkg-core/src/modules/entity/entity-relation/`
- `entity-relation.service.ts`
- `entity-relation.module.ts`
- `dto/create-relation.dto.ts`

**Основные методы:**
```typescript
@Injectable()
export class EntityRelationService {
  // CRUD
  async create(dto: CreateRelationDto): Promise<EntityRelation>;
  async findById(id: string): Promise<EntityRelation | null>;

  // Поиск
  async findByEntity(entityId: string): Promise<EntityRelation[]>;
  async findByType(entityId: string, type: RelationType): Promise<EntityRelation[]>;

  // Модификация
  async addMember(relationId: string, member: AddMemberDto): Promise<void>;
  async removeMember(relationId: string, entityId: string, role: string): Promise<void>;

  // Дедупликация
  async findDuplicate(dto: CreateRelationDto): Promise<EntityRelation | null>;

  // Валидация
  validateRoles(type: RelationType, members: MemberInput[]): void;
}
```

#### 2.4 Интеграция в контекст
**Обновить:** `EntityFactService.getContextForExtraction()`

```typescript
async getContextForExtraction(entityId: string): Promise<string> {
  const entity = await this.entityService.findById(entityId);
  const currentFacts = await this.findByEntityWithRanking(entityId);
  const historyFacts = await this.findHistory(entityId, { limit: 10 });
  const relations = await this.relationService.findByEntity(entityId);

  return this.formatStructuredContext(entity, currentFacts, historyFacts, relations);
}
```

**Формат связей:**
```
СВЯЗИ:
• spouse: Мария (entityId: xxx) — "жена", "Маша"
• colleague: Петя (entityId: yyy)
• works_at: ИИ-сервисы (entityId: zzz) — "работодатель"
```

### Критерии приёмки (Этап 2)
- [ ] Миграция создаёт таблицы `entity_relations` и `entity_relation_members`
- [ ] `EntityRelationService` поддерживает CRUD операции
- [ ] Связи отображаются в контексте extraction
- [ ] Soft delete через `validUntil` работает
- [ ] Триггер очищает пустые связи
- [ ] Unit-тесты для EntityRelationService

---

## Этап 3: Extraction Agent

**Цель:** Перевести extraction на агентный режим с tools

### Задачи

#### 3.1 ExtractionToolsProvider
**Создать:** `apps/pkg-core/src/modules/extraction/tools/extraction-tools.provider.ts`

```typescript
@Injectable()
export class ExtractionToolsProvider {
  private cachedTools: ToolDefinition[] | null = null;

  constructor(
    private readonly entityFactService: EntityFactService,
    private readonly entityService: EntityService,
    private readonly relationService: EntityRelationService,
  ) {}

  getTools(): ToolDefinition[] {
    if (!this.cachedTools) {
      this.cachedTools = this.createTools();
    }
    return this.cachedTools;
  }

  private createTools(): ToolDefinition[] {
    return [
      // Read tools
      this.createGetEntityContextTool(),
      this.createFindEntityByNameTool(),

      // Write tools
      this.createFactTool(),
      this.createRelationTool(),
      this.createPendingEntityTool(),
    ];
  }
}
```

#### 3.2 Read Tools

**get_entity_context:**
```typescript
tool('get_entity_context',
  'Получить память о сущности: факты, историю, связи',
  {
    entityId: z.string().uuid().describe('ID сущности'),
  },
  async ({ entityId }) => {
    const context = await this.entityFactService.getContextForExtraction(entityId);
    return toolSuccess(context);
  }
)
```

**find_entity_by_name:**
```typescript
tool('find_entity_by_name',
  'Найти сущность по имени или alias. Возвращает ID если найдена.',
  {
    name: z.string().min(2).describe('Имя для поиска (минимум 2 символа)'),
  },
  async ({ name }) => {
    const entities = await this.entityService.searchByName(name);
    if (entities.length === 0) {
      return toolEmptyResult('entities matching name');
    }
    return toolSuccess(entities.map(e => ({
      id: e.id,
      name: e.displayName,
      type: e.type,
    })));
  }
)
```

#### 3.3 Write Tools

**create_fact:**
```typescript
tool('create_fact',
  `Создать факт для сущности. Пройдёт через Smart Fusion.

   Типы: position, company, birthday, phone, email, location, education`,
  {
    entityId: z.string().uuid().describe('ID сущности-владельца факта'),
    factType: z.string().describe('Тип факта'),
    value: z.string().describe('Значение факта'),
    confidence: z.number().min(0).max(1).describe('Уверенность 0-1'),
    sourceQuote: z.string().describe('Цитата из сообщения'),
  },
  async (args) => {
    const fact = await this.entityFactService.createWithDedup({
      entityId: args.entityId,
      factType: args.factType,
      value: args.value,
      confidence: args.confidence,
      source: 'extracted',
      sourceMessageId: this.currentMessageId,
    });
    return toolSuccess({ factId: fact.id, action: fact.fusionAction });
  }
)
```

**create_relation:**
```typescript
tool('create_relation',
  `Создать связь между сущностями.

   Типы: employment, reporting, team, marriage, parenthood, friendship, acquaintance

   Примеры:
   - "работает в Сбере" → employment, [person/employee, org/employer]
   - "мой начальник" → reporting, [me/subordinate, boss/manager]
   - "жена" → marriage, [person1/spouse, person2/spouse]`,
  {
    relationType: z.enum([
      'employment', 'reporting', 'team',
      'marriage', 'parenthood', 'siblinghood',
      'friendship', 'acquaintance',
      'partnership', 'client_vendor'
    ]).describe('Тип связи'),
    members: z.array(z.object({
      entityId: z.string().uuid().describe('ID участника'),
      role: z.string().describe('Роль в связи'),
      label: z.string().optional().describe('Метка (имя, должность)'),
    })).min(2).describe('Участники связи'),
    confidence: z.number().min(0).max(1).optional().describe('Уверенность'),
  },
  async (args) => {
    const relation = await this.relationService.create({
      relationType: args.relationType,
      members: args.members,
      confidence: args.confidence,
      source: 'extracted',
    });
    return toolSuccess({ relationId: relation.id });
  }
)
```

**create_pending_entity:**
```typescript
tool('create_pending_entity',
  'Создать ожидающую сущность для упомянутого человека, которого нет в системе',
  {
    suggestedName: z.string().describe('Предполагаемое имя'),
    mentionedAs: z.string().describe('Контекст упоминания: "жена Ивана"'),
    relatedToEntityId: z.string().uuid().optional().describe('ID связанной сущности'),
  },
  async (args) => {
    const pending = await this.entityService.createPending({
      suggestedName: args.suggestedName,
      mentionedAs: args.mentionedAs,
      relatedToEntityId: args.relatedToEntityId,
    });
    return toolSuccess({ pendingId: pending.id });
  }
)
```

#### 3.4 Агентный режим в FactExtractionService
**Обновить:** `apps/pkg-core/src/modules/extraction/fact-extraction.service.ts`

```typescript
async extractFactsAgent(messageId: string): Promise<ExtractionResult> {
  const message = await this.messageService.findById(messageId);
  const baseContext = await this.entityFactService.getContextForExtraction(message.entityId);

  const tools = this.extractionToolsProvider.getTools();
  const mcpServer = createSdkMcpServer({
    name: 'extraction-tools',
    version: '1.0.0',
    tools,
  });

  const systemPrompt = `
Ты — агент для извлечения фактов из сообщений.

ПРАВИЛА:
1. Факты принадлежат КОНКРЕТНЫМ сущностям
2. "Маша в Сбере" → создай факт для Маши, НЕ для текущего контакта
3. Если упомянут человек из связей — получи его контекст через get_entity_context
4. Если упомянут новый человек — создай pending entity
5. При создании факта используй Smart Fusion (дубликаты обрабатываются автоматически)

БАЗОВЫЙ КОНТЕКСТ:
${baseContext}
`;

  const result = await this.claudeAgentService.call({
    mode: 'agent',
    systemPrompt,
    prompt: `Сообщение: "${message.content}"\n\nИзвлеки факты и связи.`,
    mcpServers: { 'extraction-tools': mcpServer },
    maxTurns: 10,
  });

  return this.parseAgentResult(result);
}
```

#### 3.5 Регистрация в ToolsRegistry
**Обновить:** `apps/pkg-core/src/modules/claude-agent/tools-registry.service.ts`

```typescript
// Добавить категорию 'extraction'
getToolsByCategory(categories: ToolCategory[]): ToolDefinition[] {
  // ...existing code...
  case 'extraction':
    if (this.extractionToolsProvider) {
      tools.push(...this.extractionToolsProvider.getTools());
    }
    break;
}
```

### Критерии приёмки (Этап 3)
- [ ] ExtractionToolsProvider создаёт 5 tools
- [ ] get_entity_context возвращает структурированный контекст
- [ ] create_fact проходит через Smart Fusion
- [ ] create_relation валидирует роли
- [ ] Агентный режим работает для extraction
- [ ] Факты маршрутизируются правильным сущностям
- [ ] Integration тесты для агентного flow

---

## Этап 4: Subject Resolution (Post-MVP)

**Цель:** Определение субъекта факта в групповых чатах

### Задачи (будущее)
- [ ] Алгоритм определения субъекта по reply context
- [ ] Поддержка @mentions
- [ ] Heuristics для распределения фактов по участникам

---

## Файлы для модификации

### Новые файлы
```
packages/entities/src/
├── entity-relation.entity.ts
├── entity-relation-member.entity.ts
└── relation-type.enum.ts

apps/pkg-core/src/modules/entity/entity-relation/
├── entity-relation.module.ts
├── entity-relation.service.ts
└── dto/
    ├── create-relation.dto.ts
    └── add-member.dto.ts

apps/pkg-core/src/modules/extraction/tools/
└── extraction-tools.provider.ts

apps/pkg-core/src/migrations/
└── XXXXXX-CreateEntityRelations.ts
```

### Модифицируемые файлы
```
packages/entities/src/index.ts                    # Экспорт новых entities
apps/pkg-core/src/modules/entity/entity.module.ts # Импорт EntityRelationModule
apps/pkg-core/src/modules/entity/entity-fact/entity-fact.service.ts
apps/pkg-core/src/modules/extraction/fact-extraction.service.ts
apps/pkg-core/src/modules/extraction/extraction.module.ts
apps/pkg-core/src/modules/claude-agent/tools-registry.service.ts
```

---

## Verification

### Unit Tests
```bash
# Этап 1
pnpm test -- entity-fact.service.spec.ts

# Этап 2
pnpm test -- entity-relation.service.spec.ts

# Этап 3
pnpm test -- extraction-tools.provider.spec.ts
```

### Integration Tests
```bash
# Миграция
pnpm migration:run

# E2E тест extraction
pnpm test:e2e -- extraction.e2e-spec.ts
```

### Manual Testing
1. Создать связь `employment` между person и organization
2. Отправить сообщение "Маша перешла в Сбер"
3. Проверить что факт создан для Маши, не для текущего контакта
4. Проверить что контекст включает связи

---

## Риски и митигация

| Риск | Митигация |
|------|-----------|
| Сложность запросов к связям | Абстракция в EntityRelationService |
| N-арные изменения | Soft delete через validUntil |
| Дубликаты связей | Дедупликация при создании |
| LLM ошибки | Валидация ролей + примеры в tool descriptions |
| Circular dependencies | @Optional() + forwardRef() |

---

## Порядок реализации

```
Этап 1 (Quick Win) ─────► Этап 2 (EntityRelation) ─────► Этап 3 (Agent)
     │                          │                             │
     ▼                          ▼                             ▼
  Контекст                   Связи в БД               Агентный flow
  в extraction               + сервис                 + tools
```

**Зависимости:**
- Этап 2 зависит от Этап 1 (контекст нужен для связей)
- Этап 3 зависит от Этап 2 (tools работают с EntityRelationService)
