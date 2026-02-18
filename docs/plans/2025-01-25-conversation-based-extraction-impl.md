# Conversation-Based Extraction — Implementation Plan

> **Статус:** ✅ Completed
> **Дизайн:** [2025-01-25-conversation-based-extraction-design.md](./2025-01-25-conversation-based-extraction-design.md)
> **Ветка:** `feat/conversation-based-extraction`
> **Дата:** 2025-01-25

---

## Обзор

Реализация извлечения фактов из **бесед** (групп сообщений) вместо одиночных сообщений:
- **Conversation Grouping** — группировка по 30-мин gaps
- **Cross-Chat Context** — контекст из связанных чатов
- **Subject Resolution** — определение субъекта факта
- **Unified Confirmations** — единый флоу подтверждений

---

## Фаза 1: Conversation Grouping

### 1.1 Settings для conversation gap

**Файл:** `apps/pkg-core/src/modules/settings/settings.service.ts`

```typescript
// Добавить константу
const DEFAULT_CONVERSATION_GAP_MINUTES = 30;

// Добавить метод
async getConversationGapMs(): Promise<number> {
  const now = Date.now();
  if (this.conversationGapCache && this.conversationGapCache.expiresAt > now) {
    return this.conversationGapCache.value;
  }
  const minutes = await this.getValue<number>('extraction.conversationGapMinutes');
  const value = (minutes ?? DEFAULT_CONVERSATION_GAP_MINUTES) * 60 * 1000;
  this.conversationGapCache = { value, expiresAt: now + this.CACHE_TTL_MS };
  return value;
}
```

**Seed setting:**
```typescript
{
  key: 'extraction.conversationGapMinutes',
  value: 30,
  description: 'Порог разделения бесед в минутах для extraction',
  category: 'extraction',
}
```

### 1.2 ConversationGrouperService

**Создать:** `apps/pkg-core/src/modules/extraction/services/conversation-grouper.service.ts`

```typescript
@Injectable()
export class ConversationGrouperService {
  constructor(private readonly settingsService: SettingsService) {}

  async groupMessages(messages: MessageData[]): Promise<ConversationGroup[]> {
    if (messages.length === 0) return [];

    const gapMs = await this.settingsService.getConversationGapMs();
    const sorted = [...messages].sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const groups: ConversationGroup[] = [];
    let currentGroup: MessageData[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const prevTime = new Date(sorted[i - 1].timestamp).getTime();
      const currTime = new Date(sorted[i].timestamp).getTime();

      if (currTime - prevTime > gapMs) {
        // New conversation
        groups.push(this.createGroup(currentGroup));
        currentGroup = [sorted[i]];
      } else {
        currentGroup.push(sorted[i]);
      }
    }

    // Last group
    if (currentGroup.length > 0) {
      groups.push(this.createGroup(currentGroup));
    }

    return groups;
  }

  private createGroup(messages: MessageData[]): ConversationGroup {
    const participantIds = new Set<string>();
    messages.forEach(m => {
      if (m.senderEntityId) participantIds.add(m.senderEntityId);
    });

    return {
      messages,
      startedAt: new Date(messages[0].timestamp),
      endedAt: new Date(messages[messages.length - 1].timestamp),
      participantEntityIds: Array.from(participantIds),
    };
  }
}
```

### 1.3 Types

**Файл:** `apps/pkg-core/src/modules/extraction/extraction.types.ts`

```typescript
export interface ConversationGroup {
  messages: MessageData[];
  startedAt: Date;
  endedAt: Date;
  participantEntityIds: string[];
}

export interface MessageData {
  id: string;
  content: string;
  timestamp: string;
  isOutgoing: boolean;
  replyToSourceMessageId?: string;
  topicName?: string;
  senderEntityId?: string;
  senderEntityName?: string;
  isBotSender?: boolean;
}
```

### Критерии приёмки (Фаза 1)
- [ ] `getConversationGapMs()` с кэшированием
- [ ] Setting `extraction.conversationGapMinutes` в БД
- [ ] `ConversationGrouperService.groupMessages()` группирует по gaps
- [ ] Unit-тесты для grouper

---

## Фаза 2: Cross-Chat Context

### 2.1 CrossChatContextService

**Создать:** `apps/pkg-core/src/modules/extraction/services/cross-chat-context.service.ts`

```typescript
@Injectable()
export class CrossChatContextService {
  constructor(
    private readonly messageService: MessageService,
    private readonly settingsService: SettingsService,
  ) {}

  async getContext(
    currentInteractionId: string,
    participantEntityIds: string[],
    referenceTime: Date,
  ): Promise<string | null> {
    const windowMs = await this.settingsService.getCrossChatContextMs();
    const fromTime = new Date(referenceTime.getTime() - windowMs);

    // Найти сообщения из других чатов с теми же участниками
    const messages = await this.messageService.findByEntitiesInTimeWindow({
      entityIds: participantEntityIds,
      from: fromTime,
      to: referenceTime,
      excludeInteractionId: currentInteractionId,
      limit: 20,
    });

    if (messages.length === 0) return null;

    return this.formatContext(messages);
  }

  private formatContext(messages: Message[]): string {
    const lines = messages.map(m => {
      const time = format(m.createdAt, 'HH:mm');
      const sender = m.isOutgoing ? 'Я' : (m.senderEntityName || 'Собеседник');
      const chat = m.interaction?.chatName || 'Чат';
      return `[${time}] ${chat} | ${sender}: ${m.content}`;
    });

    return lines.join('\n');
  }
}
```

### 2.2 Settings для cross-chat window

```typescript
{
  key: 'extraction.crossChatContextMinutes',
  value: 30,
  description: 'Окно для поиска кросс-чат контекста',
  category: 'extraction',
}
```

### 2.3 MessageService.findByEntitiesInTimeWindow()

**Файл:** `apps/pkg-core/src/modules/message/message.service.ts`

```typescript
async findByEntitiesInTimeWindow(params: {
  entityIds: string[];
  from: Date;
  to: Date;
  excludeInteractionId?: string;
  limit?: number;
}): Promise<Message[]> {
  const qb = this.messageRepo.createQueryBuilder('m')
    .innerJoin('m.interaction', 'i')
    .innerJoin('i.participants', 'p')
    .where('p.entityId IN (:...entityIds)', { entityIds: params.entityIds })
    .andWhere('m.createdAt BETWEEN :from AND :to', {
      from: params.from,
      to: params.to
    });

  if (params.excludeInteractionId) {
    qb.andWhere('m.interactionId != :excludeId', {
      excludeId: params.excludeInteractionId
    });
  }

  return qb
    .orderBy('m.createdAt', 'DESC')
    .take(params.limit ?? 20)
    .getMany();
}
```

### Критерии приёмки (Фаза 2)
- [ ] `getCrossChatContextMs()` с кэшированием
- [ ] `CrossChatContextService.getContext()` возвращает форматированный контекст
- [ ] `MessageService.findByEntitiesInTimeWindow()` находит сообщения
- [ ] Unit-тесты

---

## Фаза 3: extractFromConversation()

### 3.1 Новый метод в SecondBrainExtractionService

**Файл:** `apps/pkg-core/src/modules/extraction/second-brain-extraction.service.ts`

```typescript
async extractFromConversation(
  conversation: ConversationGroup,
  entityId: string,
  interactionId: string,
): Promise<SecondBrainExtractionResult> {
  // 1. Получить контекст сущности
  const entityContext = await this.entityFactService.getContextForExtraction(entityId);

  // 2. Получить кросс-чат контекст
  const crossChatContext = await this.crossChatContextService.getContext(
    interactionId,
    conversation.participantEntityIds,
    conversation.endedAt,
  );

  // 3. Форматировать беседу
  const formattedConversation = this.formatConversation(conversation.messages);

  // 4. Вызвать агент
  const result = await this.claudeAgentService.call({
    mode: 'agent',
    systemPrompt: this.buildConversationSystemPrompt(entityContext, crossChatContext),
    prompt: formattedConversation,
    toolCategories: ['extraction'],
    maxTurns: 15,
    outputFormat: this.getExtractionOutputFormat(),
  });

  return this.parseExtractionResult(result);
}

private buildConversationSystemPrompt(
  entityContext: string,
  crossChatContext: string | null,
): string {
  return `
Ты — агент для извлечения фактов из БЕСЕД (не отдельных сообщений).

═══════════════════════════════════════════════════════════════
ИЗВЕСТНЫЕ ФАКТЫ О СОБЕСЕДНИКЕ:
${entityContext || 'Нет сохранённых фактов'}
═══════════════════════════════════════════════════════════════

${crossChatContext ? `
СВЯЗАННЫЙ КОНТЕКСТ (другие чаты за последние 30 мин):
${crossChatContext}
═══════════════════════════════════════════════════════════════
` : ''}

ПРАВИЛА:
1. Анализируй БЕСЕДУ ЦЕЛИКОМ, не отдельные сообщения
2. Факт принадлежит СУБЪЕКТУ, не автору сообщения
   - "У Игоря день рождения 10 августа" → факт для Игоря
3. Если субъект неясен — укажи subjectMention для последующего разрешения
4. Используй связанный контекст для понимания отсылок
5. Не создавай факты из вопросов (только из утверждений)
`.trim();
}

private formatConversation(messages: MessageData[]): string {
  return messages.map(m => {
    const time = format(new Date(m.timestamp), 'HH:mm');
    const sender = m.isOutgoing ? 'Я' : (m.senderEntityName || 'Собеседник');
    return `[${time}] ${sender}: ${m.content}`;
  }).join('\n');
}
```

### 3.2 Обновить FactExtractionProcessor

**Файл:** `apps/pkg-core/src/modules/job/processors/fact-extraction.processor.ts`

```typescript
async processExtractionJob(job: Job<ExtractionJobData>): Promise<void> {
  const { interactionId, entityId, messages } = job.data;

  // Группируем сообщения в беседы
  const conversations = await this.conversationGrouper.groupMessages(messages);

  // Обрабатываем каждую беседу
  for (const conversation of conversations) {
    const result = await this.secondBrainExtractionService.extractFromConversation(
      conversation,
      entityId,
      interactionId,
    );

    // Сохраняем результаты
    await this.saveExtractionResult(result);
  }
}
```

### Критерии приёмки (Фаза 3)
- [ ] `extractFromConversation()` принимает ConversationGroup
- [ ] Prompt включает entity context и cross-chat context
- [ ] Processor группирует сообщения перед extraction
- [ ] Integration тесты

---

## Фаза 4: Unified Confirmations

### 4.1 Entity: PendingConfirmation

**Создать:** `packages/entities/src/pending-confirmation.entity.ts`

```typescript
@Entity('pending_confirmations')
export class PendingConfirmation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 50 })
  type: 'identifier_attribution' | 'entity_merge' | 'fact_subject' | 'fact_value';

  @Column({ type: 'jsonb' })
  context: {
    title: string;
    description: string;
    sourceQuote?: string;
  };

  @Column({ type: 'jsonb' })
  options: Array<{
    id: string;
    label: string;
    sublabel?: string;
    entityId?: string;
    isCreateNew?: boolean;
    isDecline?: boolean;
    isOther?: boolean;
  }>;

  @Column({ type: 'decimal', precision: 3, scale: 2, nullable: true })
  confidence: number | null;

  @Column({ length: 20, default: 'pending' })
  status: 'pending' | 'confirmed' | 'declined' | 'expired';

  @Column({ type: 'uuid', nullable: true })
  sourceMessageId: string | null;

  @Column({ type: 'uuid', nullable: true })
  sourceEntityId: string | null;

  @Column({ type: 'uuid', nullable: true })
  sourcePendingFactId: string | null;

  @Column({ type: 'uuid', nullable: true })
  selectedOptionId: string | null;

  @Column({ type: 'jsonb', nullable: true })
  resolution: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ type: 'timestamp', nullable: true, name: 'expires_at' })
  expiresAt: Date | null;

  @Column({ type: 'timestamp', nullable: true, name: 'resolved_at' })
  resolvedAt: Date | null;

  @Column({ length: 20, nullable: true, name: 'resolved_by' })
  resolvedBy: 'user' | 'auto' | 'expired' | null;
}
```

### 4.2 Migration

**Создать:** `apps/pkg-core/src/migrations/XXXXXX-CreatePendingConfirmations.ts`

```sql
CREATE TABLE pending_confirmations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(50) NOT NULL,
  context JSONB NOT NULL,
  options JSONB NOT NULL,
  confidence DECIMAL(3,2),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  source_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  source_entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
  source_pending_fact_id UUID REFERENCES pending_facts(id) ON DELETE SET NULL,
  selected_option_id UUID,
  resolution JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  resolved_at TIMESTAMP,
  resolved_by VARCHAR(20)
);

CREATE INDEX idx_pending_confirmations_status ON pending_confirmations(status);
CREATE INDEX idx_pending_confirmations_type ON pending_confirmations(type);
```

### 4.3 ConfirmationService

**Создать:** `apps/pkg-core/src/modules/confirmation/confirmation.service.ts`

```typescript
@Injectable()
export class ConfirmationService {
  constructor(
    @InjectRepository(PendingConfirmation)
    private readonly repo: Repository<PendingConfirmation>,
    private readonly telegramNotifier: TelegramConfirmationNotifier,
  ) {}

  async create(dto: CreateConfirmationDto): Promise<PendingConfirmation> {
    // Дедупликация
    const existing = await this.findSimilar(dto);
    if (existing) return existing;

    const confirmation = this.repo.create({
      ...dto,
      status: 'pending',
      expiresAt: this.calculateExpiry(dto.type),
    });

    await this.repo.save(confirmation);
    await this.telegramNotifier.send(confirmation);

    return confirmation;
  }

  async resolve(id: string, optionId: string): Promise<void> {
    const confirmation = await this.repo.findOneOrFail({ where: { id } });

    confirmation.status = optionId === 'decline' ? 'declined' : 'confirmed';
    confirmation.selectedOptionId = optionId;
    confirmation.resolvedAt = new Date();
    confirmation.resolvedBy = 'user';

    await this.repo.save(confirmation);
    await this.dispatchResolution(confirmation);
  }

  async getPending(limit = 10): Promise<PendingConfirmation[]> {
    return this.repo.find({
      where: { status: 'pending' },
      order: { confidence: 'ASC', createdAt: 'ASC' },
      take: limit,
    });
  }

  private async dispatchResolution(confirmation: PendingConfirmation): Promise<void> {
    // Будет реализовано в Фазе 5 с type-specific handlers
  }
}
```

### Критерии приёмки (Фаза 4)
- [ ] Entity `PendingConfirmation` создана
- [ ] Миграция выполнена
- [ ] `ConfirmationService` CRUD операции
- [ ] Unit-тесты

---

## Фаза 5: Subject Resolution

### 5.1 SubjectResolver

**Создать:** `apps/pkg-core/src/modules/extraction/services/subject-resolver.service.ts`

```typescript
@Injectable()
export class SubjectResolverService {
  constructor(
    private readonly entityService: EntityService,
    private readonly confirmationService: ConfirmationService,
  ) {}

  async resolve(
    subjectMention: string,
    conversationParticipants: string[],
    confidence: number,
  ): Promise<SubjectResolution> {
    // 1. Поиск по имени
    const candidates = await this.entityService.searchByName(subjectMention);

    // 2. Фильтруем по участникам беседы (приоритет)
    const participantMatches = candidates.filter(c =>
      conversationParticipants.includes(c.id)
    );

    // 3. Матрица решений
    if (participantMatches.length === 1 && confidence >= 0.8) {
      return { entityId: participantMatches[0].id, status: 'resolved' };
    }

    if (participantMatches.length > 1 || (candidates.length > 0 && confidence < 0.8)) {
      // Создать confirmation
      const confirmation = await this.confirmationService.create({
        type: 'fact_subject',
        context: {
          title: 'О ком факт?',
          description: `Упоминание: "${subjectMention}"`,
        },
        options: this.buildOptions(candidates, participantMatches),
        confidence,
      });
      return { confirmationId: confirmation.id, status: 'pending' };
    }

    if (candidates.length === 0) {
      return { status: 'unknown', suggestedName: subjectMention };
    }

    return { entityId: candidates[0].id, status: 'resolved' };
  }
}
```

### 5.2 FactSubjectHandler

**Создать:** `apps/pkg-core/src/modules/confirmation/handlers/fact-subject.handler.ts`

```typescript
@Injectable()
export class FactSubjectHandler {
  constructor(
    private readonly pendingFactService: PendingFactService,
    private readonly entityFactService: EntityFactService,
  ) {}

  async handle(confirmation: PendingConfirmation): Promise<void> {
    if (confirmation.status !== 'confirmed') return;

    const selectedOption = confirmation.options.find(
      o => o.id === confirmation.selectedOptionId
    );

    if (!selectedOption?.entityId) return;

    // Обновить pending fact с правильным entityId
    if (confirmation.sourcePendingFactId) {
      await this.pendingFactService.updateSubject(
        confirmation.sourcePendingFactId,
        selectedOption.entityId,
      );

      // Auto-approve если confidence был высокий
      if ((confirmation.confidence ?? 0) >= 0.8) {
        await this.pendingFactService.approve(confirmation.sourcePendingFactId);
      }
    }
  }
}
```

### Критерии приёмки (Фаза 5)
- [ ] `SubjectResolverService` реализует матрицу решений
- [ ] `FactSubjectHandler` обрабатывает подтверждения
- [ ] Integration с extraction flow
- [ ] E2E тесты

---

## Файлы для создания

```
apps/pkg-core/src/modules/extraction/
├── services/
│   ├── conversation-grouper.service.ts      # Фаза 1
│   ├── cross-chat-context.service.ts        # Фаза 2
│   └── subject-resolver.service.ts          # Фаза 5
└── extraction.types.ts                      # Фаза 1

apps/pkg-core/src/modules/confirmation/
├── confirmation.module.ts                   # Фаза 4
├── confirmation.service.ts                  # Фаза 4
├── dto/
│   └── create-confirmation.dto.ts           # Фаза 4
└── handlers/
    ├── fact-subject.handler.ts              # Фаза 5
    └── identifier-attribution.handler.ts   # Фаза 5

packages/entities/src/
└── pending-confirmation.entity.ts           # Фаза 4

apps/pkg-core/src/migrations/
└── XXXXXX-CreatePendingConfirmations.ts     # Фаза 4
```

## Файлы для модификации

```
apps/pkg-core/src/modules/settings/settings.service.ts           # Фаза 1, 2
apps/pkg-core/src/modules/message/message.service.ts             # Фаза 2
apps/pkg-core/src/modules/extraction/second-brain-extraction.service.ts  # Фаза 3
apps/pkg-core/src/modules/job/processors/fact-extraction.processor.ts    # Фаза 3
packages/entities/src/index.ts                                   # Фаза 4
```

---

## Порядок выполнения

```
Фаза 1 ──► Фаза 2 ──► Фаза 3 ──► Фаза 4 ──► Фаза 5
  │           │           │           │           │
  ▼           ▼           ▼           ▼           ▼
Grouper   CrossChat   Extract    Confirm    Subject
                      Convo      Service    Resolver
```

**Зависимости:**
- Фаза 2 зависит от Фаза 1 (нужны ConversationGroup)
- Фаза 3 зависит от Фаза 1 и 2
- Фаза 5 зависит от Фаза 4

---

## Verification

```bash
# Unit тесты
pnpm test -- conversation-grouper
pnpm test -- cross-chat-context
pnpm test -- confirmation.service
pnpm test -- subject-resolver

# E2E
pnpm test:e2e -- extraction

# Миграции
pnpm migration:run
```
