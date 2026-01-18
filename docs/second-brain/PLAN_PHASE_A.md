# Phase A Implementation Plan: Act Capabilities

## Обзор

Phase A добавляет возможность выполнять действия — отправлять сообщения от имени пользователя с обязательным подтверждением.

**Ключевые принципы:**
- Бот показывает UI, юзербот отправляет сообщения
- Никогда не отправлять без явного подтверждения
- Пользователь видит точный текст до отправки
- Возможность редактирования (AI-генерация или verbatim)
- Проактивные действия из Morning Brief

**Оценка времени:** 7-8 дней

---

## Архитектура

### Bot vs Userbot

```
┌─────────────────────────────────────────────────────────────────────┐
│                      TELEGRAM ADAPTER                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────────────┐          ┌──────────────────────┐         │
│  │         BOT          │          │       USERBOT        │         │
│  │    (@pkg_bot)        │          │      (GramJS)        │         │
│  ├──────────────────────┤          ├──────────────────────┤         │
│  │ • Уведомления        │          │ • Чтение чатов       │         │
│  │ • Inline кнопки      │          │ • Отправка сообщений │         │
│  │ • Approval flow      │          │   ОТ ИМЕНИ USER      │         │
│  │ • Morning brief      │          │ • History sync       │         │
│  │ • Callback queries   │          │                      │         │
│  └──────────┬───────────┘          └──────────▲───────────┘         │
│             │                                  │                     │
│             │   POST /telegram/send-as-user    │                     │
│             └──────────────────────────────────┘                     │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Approval Flow State Machine

```
                    ┌─────────────┐
                    │   START     │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
            ┌───────│   DRAFT     │───────┐
            │       └──────┬──────┘       │
            │              │              │
     [Отправить]      [Изменить]      [Отмена]
            │              │              │
            │              ▼              │
            │       ┌─────────────┐       │
            │       │ EDIT_MODE   │       │
            │       └──────┬──────┘       │
            │              │              │
            │    ┌─────────┴─────────┐    │
            │    │                   │    │
            │ [Задать]          [Как есть]│
            │    │                   │    │
            │    ▼                   ▼    │
            │ ┌───────┐        ┌───────┐  │
            │ │DESCRIBE│        │VERBATIM│ │
            │ └───┬───┘        └───┬───┘  │
            │     │                │      │
            │     └────────┬───────┘      │
            │              │              │
            │              ▼              │
            │       ┌─────────────┐       │
            │       │   DRAFT     │───────┤
            │       └──────┬──────┘       │
            │              │              │
            ▼              │              ▼
     ┌─────────────┐       │       ┌─────────────┐
     │    SEND     │       │       │  CANCELLED  │
     └──────┬──────┘       │       └─────────────┘
            │              │
            ▼              │
     ┌─────────────┐       │
     │  FOLLOWUP   │◄──────┘
     │  SUGGEST    │
     └──────┬──────┘
            │
     ┌──────┴──────┬──────────────┐
     │             │              │
  [2 часа]    [Завтра]      [Не нужно]
     │             │              │
     ▼             ▼              ▼
┌─────────┐  ┌─────────┐   ┌─────────┐
│CREATE   │  │CREATE   │   │  DONE   │
│FOLLOWUP │  │FOLLOWUP │   │         │
└─────────┘  └─────────┘   └─────────┘
```

---

## Задачи

### A1.1 ActionToolsProvider (Day 1-2)

**Файл:** `apps/pkg-core/src/modules/claude-agent/tools/action-tools.provider.ts`

**Tools:**

| Tool | Описание |
|------|----------|
| `draft_message` | Генерация черновика сообщения |
| `send_telegram` | Отправка сообщения (требует approval) |
| `schedule_followup` | Создание напоминания проверить ответ |

```typescript
@Injectable()
export class ActionToolsProvider {
  private cachedTools: ToolDefinition[] | null = null;

  constructor(
    private readonly claudeAgentService: ClaudeAgentService,
    private readonly entityService: EntityService,
    private readonly contextService: ContextService,
  ) {}

  getTools(): ToolDefinition[] {
    if (!this.cachedTools) {
      this.cachedTools = this.createTools();
    }
    return this.cachedTools;
  }

  private createTools(): ToolDefinition[] {
    return [
      tool(
        'draft_message',
        `Generate a draft message for a contact based on intent and conversation history.
Uses recent chat context to match the communication style and tone.
Returns draft text for user review before sending.`,
        {
          entityId: z.string().uuid().describe('UUID of the recipient entity'),
          intent: z.string().describe('What to communicate (e.g., "remind about documents", "reschedule meeting")'),
          tone: z.enum(['formal', 'casual', 'friendly']).default('friendly').describe('Desired message tone'),
        },
        async (args) => this.handleDraftMessage(args),
      ),

      tool(
        'send_telegram',
        `Send a Telegram message to a contact.
IMPORTANT: This tool triggers an approval flow - the message is NOT sent immediately.
User must approve the message before it's actually sent.`,
        {
          entityId: z.string().uuid().describe('UUID of the recipient entity'),
          text: z.string().min(1).max(4096).describe('Message text to send'),
        },
        async (args) => this.handleSendTelegram(args),
      ),

      tool(
        'schedule_followup',
        `Create a follow-up reminder to check for response from a contact.
Use after sending a message to track if they respond.`,
        {
          entityId: z.string().uuid().describe('UUID of the contact'),
          reason: z.string().describe('What to follow up about'),
          checkAfter: z.string().describe('When to check: ISO datetime or "2h", "1d", "3d"'),
        },
        async (args) => this.handleScheduleFollowup(args),
      ),
    ];
  }

  private async handleDraftMessage(args: {
    entityId: string;
    intent: string;
    tone: 'formal' | 'casual' | 'friendly';
  }): Promise<CallToolResult> {
    const entity = await this.entityService.findOne(args.entityId);
    if (!entity) {
      return toolError(`Entity not found. Search for contact first using list_entities.`);
    }

    // Get recent context for style matching
    const recentMessages = await this.contextService.getRecentMessages(args.entityId, 10);

    // Generate draft using LLM
    const draft = await this.generateDraft(entity.name, args.intent, args.tone, recentMessages);

    return toolSuccess({
      draft,
      recipient: entity.name,
      entityId: args.entityId,
      note: 'Show this draft to user. Use send_telegram to send after approval.',
    });
  }

  private async generateDraft(
    name: string,
    intent: string,
    tone: string,
    recentMessages: string[],
  ): Promise<string> {
    const prompt = `Сгенерируй короткое сообщение для ${name}.

Задача: ${intent}
Тон: ${tone}

Недавние сообщения (для понимания стиля общения):
${recentMessages.slice(0, 5).join('\n')}

Требования:
- Краткое (1-3 предложения)
- Естественное, как будто пишет реальный человек
- Соответствует тону общения из истории
- Без формальностей если casual/friendly`;

    const { data } = await this.claudeAgentService.call<{ message: string }>({
      mode: 'oneshot',
      taskType: 'draft_generation',
      prompt,
      model: 'haiku',
      schema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Generated message text' },
        },
        required: ['message'],
      },
    });

    return data.message;
  }
}
```

**Acceptance Criteria:**
- [ ] draft_message генерирует текст на основе intent и контекста
- [ ] send_telegram возвращает pending status (не отправляет напрямую)
- [ ] schedule_followup создаёт EntityEvent типа FOLLOW_UP

---

### A1.2 ApprovalHookService (Day 2-3)

**Файл:** `apps/pkg-core/src/modules/claude-agent/hooks/approval-hook.service.ts`

```typescript
interface PendingApproval {
  id: string;
  entityId: string;
  entityName: string;
  text: string;
  createdAt: Date;
  status: 'pending' | 'approved' | 'rejected' | 'editing';
  editMode?: 'describe' | 'verbatim';
}

@Injectable()
export class ApprovalHookService {
  private readonly logger = new Logger(ApprovalHookService.name);
  private readonly APPROVAL_TTL = 120; // 2 minutes

  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
    private readonly telegramNotifier: TelegramNotifierService,
    private readonly entityService: EntityService,
  ) {}

  /**
   * Request approval for sending a message
   * Returns a Promise that resolves when user responds
   */
  async requestApproval(input: {
    entityId: string;
    text: string;
  }): Promise<ApprovalResult> {
    const entity = await this.entityService.findOne(input.entityId);
    const approvalId = randomUUID();

    // Store pending approval in Redis
    const approval: PendingApproval = {
      id: approvalId,
      entityId: input.entityId,
      entityName: entity?.name || 'Unknown',
      text: input.text,
      createdAt: new Date(),
      status: 'pending',
    };

    await this.redis.setex(
      `approval:${approvalId}`,
      this.APPROVAL_TTL,
      JSON.stringify(approval),
    );

    // Send approval request to user via bot
    await this.sendApprovalMessage(approval);

    // Wait for response (polling Redis)
    return this.waitForResponse(approvalId);
  }

  private async sendApprovalMessage(approval: PendingApproval): Promise<void> {
    const message = `📤 <b>Отправить сообщение?</b>

<b>Кому:</b> ${this.escapeHtml(approval.entityName)}

<b>Текст:</b>
${this.escapeHtml(approval.text)}`;

    const buttons = [
      [
        { text: '✅ Отправить', callback_data: `act_approve:${approval.id}` },
        { text: '✏️ Изменить', callback_data: `act_edit:${approval.id}` },
        { text: '❌ Отмена', callback_data: `act_cancel:${approval.id}` },
      ],
    ];

    await this.telegramNotifier.sendWithButtons(message, buttons, 'HTML');
  }

  /**
   * Handle edit mode selection
   */
  async sendEditModeSelection(approvalId: string): Promise<void> {
    const message = `Как хочешь изменить сообщение?`;

    const buttons = [
      [
        { text: '💡 Задать', callback_data: `edit_describe:${approvalId}` },
        { text: '📝 Как есть', callback_data: `edit_verbatim:${approvalId}` },
      ],
      [
        { text: '◀️ Назад', callback_data: `edit_back:${approvalId}` },
      ],
    ];

    await this.telegramNotifier.editMessage(/* messageId */, message, buttons);
  }

  /**
   * Handle user response from callback
   */
  async handleCallback(
    approvalId: string,
    action: 'approve' | 'edit' | 'cancel' | 'describe' | 'verbatim',
    newText?: string,
  ): Promise<void> {
    const key = `approval:${approvalId}`;
    const data = await this.redis.get(key);

    if (!data) {
      this.logger.warn(`Approval ${approvalId} not found or expired`);
      return;
    }

    const approval: PendingApproval = JSON.parse(data);

    switch (action) {
      case 'approve':
        approval.status = 'approved';
        break;
      case 'cancel':
        approval.status = 'rejected';
        break;
      case 'edit':
        approval.status = 'editing';
        await this.sendEditModeSelection(approvalId);
        break;
      case 'describe':
        approval.editMode = 'describe';
        // Will wait for user text input
        break;
      case 'verbatim':
        approval.editMode = 'verbatim';
        // Will wait for user text input
        break;
    }

    if (newText) {
      approval.text = newText;
      approval.status = 'pending'; // Back to approval
      await this.sendApprovalMessage(approval);
    }

    await this.redis.setex(key, this.APPROVAL_TTL, JSON.stringify(approval));
  }

  private async waitForResponse(approvalId: string): Promise<ApprovalResult> {
    const key = `approval:${approvalId}`;
    const startTime = Date.now();
    const timeout = this.APPROVAL_TTL * 1000;

    while (Date.now() - startTime < timeout) {
      const data = await this.redis.get(key);

      if (!data) {
        return { approved: false, reason: 'Expired' };
      }

      const approval: PendingApproval = JSON.parse(data);

      if (approval.status === 'approved') {
        return { approved: true, text: approval.text };
      }

      if (approval.status === 'rejected') {
        return { approved: false, reason: 'Cancelled by user' };
      }

      // Still pending, wait and poll again
      await sleep(500);
    }

    return { approved: false, reason: 'Timeout' };
  }
}
```

**Acceptance Criteria:**
- [ ] Approval request сохраняется в Redis с TTL
- [ ] Три кнопки: Отправить / Изменить / Отмена
- [ ] Timeout 2 минуты
- [ ] Callback handlers обновляют состояние

---

### A1.3 TelegramSendService (Day 3)

**Файл:** `apps/pkg-core/src/modules/telegram/telegram-send.service.ts`

```typescript
@Injectable()
export class TelegramSendService {
  private readonly logger = new Logger(TelegramSendService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly entityService: EntityService,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
  ) {}

  /**
   * Send message to entity via userbot
   */
  async sendToEntity(entityId: string, text: string): Promise<SendResult> {
    // 1. Find Telegram identifier
    const entity = await this.entityService.findOneWithIdentifiers(entityId);
    const telegramId = entity?.identifiers?.find(
      i => i.identifierType === 'telegram_user_id',
    );

    if (!telegramId) {
      throw new Error(`Entity ${entityId} has no Telegram identifier`);
    }

    // 2. Call telegram-adapter to send via userbot
    const response = await firstValueFrom(
      this.httpService.post<SendAsUserResponse>(
        `${this.telegramAdapterUrl}/telegram/send-as-user`,
        {
          chatId: telegramId.identifierValue,
          text,
        },
      ),
    );

    // 3. Log sent message
    this.logger.log(`Sent message to ${entity.name} (${telegramId.identifierValue})`);

    return {
      success: true,
      messageId: response.data.messageId,
      chatId: telegramId.identifierValue,
    };
  }
}
```

---

### A1.4 Send-as-User Endpoint (Day 3)

**Файл:** `apps/telegram-adapter/src/controllers/telegram.controller.ts`

```typescript
@Controller('telegram')
export class TelegramController {
  constructor(
    private readonly userbotService: UserbotService,
  ) {}

  @Post('send-as-user')
  @ApiOperation({ summary: 'Send message as user via userbot' })
  async sendAsUser(@Body() dto: SendAsUserDto): Promise<SendAsUserResponse> {
    return this.userbotService.sendMessage(dto.chatId, dto.text, dto.replyToMsgId);
  }
}
```

**Файл:** `apps/telegram-adapter/src/services/userbot.service.ts`

```typescript
@Injectable()
export class UserbotService {
  async sendMessage(
    chatId: string,
    text: string,
    replyToMsgId?: number,
  ): Promise<SendAsUserResponse> {
    const peer = await this.client.getInputEntity(chatId);

    const result = await this.client.sendMessage(peer, {
      message: text,
      replyTo: replyToMsgId,
    });

    return {
      success: true,
      messageId: result.id,
      date: result.date,
    };
  }
}
```

**Acceptance Criteria:**
- [ ] POST /telegram/send-as-user работает
- [ ] Сообщение отправляется через GramJS (юзербот)
- [ ] Возвращается messageId для tracking

---

### A2.1 Approval Callback Handlers (Day 4)

**Файл:** `apps/telegram-adapter/src/bot/handlers/approval-callback.handler.ts`

```typescript
@Injectable()
export class ApprovalCallbackHandler {
  constructor(
    private readonly httpService: HttpService,
    private readonly conversationState: ConversationStateService,
  ) {}

  canHandle(data: string): boolean {
    return data.startsWith('act_') || data.startsWith('edit_');
  }

  async handle(ctx: Context, data: string): Promise<void> {
    const [action, approvalId] = data.split(':');

    switch (action) {
      case 'act_approve':
        await this.handleApprove(ctx, approvalId);
        break;

      case 'act_edit':
        await this.handleEdit(ctx, approvalId);
        break;

      case 'act_cancel':
        await this.handleCancel(ctx, approvalId);
        break;

      case 'edit_describe':
        await this.handleDescribeMode(ctx, approvalId);
        break;

      case 'edit_verbatim':
        await this.handleVerbatimMode(ctx, approvalId);
        break;

      case 'edit_back':
        await this.handleBack(ctx, approvalId);
        break;
    }
  }

  private async handleApprove(ctx: Context, approvalId: string): Promise<void> {
    await this.httpService.post(`/approvals/${approvalId}/approve`).toPromise();
    await ctx.editMessageText('✅ Сообщение отправлено!');

    // Show follow-up suggestion
    await this.showFollowupSuggestion(ctx, approvalId);
  }

  private async handleEdit(ctx: Context, approvalId: string): Promise<void> {
    const buttons = [
      [
        { text: '💡 Задать', callback_data: `edit_describe:${approvalId}` },
        { text: '📝 Как есть', callback_data: `edit_verbatim:${approvalId}` },
      ],
      [
        { text: '◀️ Назад', callback_data: `edit_back:${approvalId}` },
      ],
    ];

    await ctx.editMessageText(
      'Как хочешь изменить сообщение?',
      { reply_markup: { inline_keyboard: buttons } },
    );
  }

  private async handleDescribeMode(ctx: Context, approvalId: string): Promise<void> {
    // Set conversation state to wait for description
    await this.conversationState.set(ctx.chat.id, {
      state: 'awaiting_description',
      approvalId,
    });

    await ctx.editMessageText(
      'Опиши, что хочешь написать:',
      { reply_markup: { inline_keyboard: [] } },
    );
  }

  private async handleVerbatimMode(ctx: Context, approvalId: string): Promise<void> {
    // Set conversation state to wait for exact text
    await this.conversationState.set(ctx.chat.id, {
      state: 'awaiting_verbatim',
      approvalId,
    });

    await ctx.editMessageText(
      'Напиши сообщение для отправки:',
      { reply_markup: { inline_keyboard: [] } },
    );
  }

  private async showFollowupSuggestion(ctx: Context, approvalId: string): Promise<void> {
    const buttons = [
      [
        { text: '⏰ Через 2 часа', callback_data: `followup_2h:${approvalId}` },
        { text: '📅 Завтра', callback_data: `followup_1d:${approvalId}` },
      ],
      [
        { text: '🚫 Не нужно', callback_data: `followup_skip:${approvalId}` },
      ],
    ];

    await ctx.reply(
      '💡 Создать напоминание проверить ответ?',
      { reply_markup: { inline_keyboard: buttons } },
    );
  }
}
```

**Acceptance Criteria:**
- [ ] Все callbacks обрабатываются
- [ ] Edit mode selection работает
- [ ] Conversation state сохраняется в Redis

---

### A2.2 Text Input Handler (Day 4)

**Файл:** `apps/telegram-adapter/src/bot/handlers/text-input.handler.ts`

```typescript
@Injectable()
export class TextInputHandler {
  constructor(
    private readonly conversationState: ConversationStateService,
    private readonly httpService: HttpService,
  ) {}

  async handle(ctx: Context): Promise<boolean> {
    const state = await this.conversationState.get(ctx.chat.id);
    if (!state) return false;

    const text = ctx.message.text;

    switch (state.state) {
      case 'awaiting_description':
        await this.handleDescription(ctx, state.approvalId, text);
        return true;

      case 'awaiting_verbatim':
        await this.handleVerbatim(ctx, state.approvalId, text);
        return true;

      default:
        return false;
    }
  }

  private async handleDescription(
    ctx: Context,
    approvalId: string,
    description: string,
  ): Promise<void> {
    await ctx.reply('🤖 Генерирую сообщение...');

    // Call API to regenerate with description
    const response = await this.httpService.post(
      `/approvals/${approvalId}/regenerate`,
      { description },
    ).toPromise();

    // Clear state
    await this.conversationState.clear(ctx.chat.id);

    // Show new draft for approval
    // (API will send new approval message)
  }

  private async handleVerbatim(
    ctx: Context,
    approvalId: string,
    text: string,
  ): Promise<void> {
    // Update approval with exact text
    await this.httpService.post(
      `/approvals/${approvalId}/update-text`,
      { text },
    ).toPromise();

    // Clear state
    await this.conversationState.clear(ctx.chat.id);

    // Show updated draft for approval
  }
}
```

---

### A2.3 Proactive Action Buttons (Day 5)

**Файл:** `apps/pkg-core/src/modules/notification/digest.service.ts`

Обновить `sendMorningBrief()`:

```typescript
private formatMorningBrief(data: MorningBriefData): { text: string; buttons: InlineButton[][] } {
  let msg = '🌅 <b>Доброе утро! Вот твой день:</b>\n\n';
  const buttons: InlineButton[][] = [];

  // Meetings with prepare brief button
  if (data.meetings.length > 0) {
    msg += '📅 <b>Встречи:</b>\n';
    data.meetings.forEach((m, i) => {
      const time = m.eventDate?.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      msg += `• ${time} — ${m.title}\n`;

      if (m.entityId) {
        buttons.push([{
          text: `📋 Brief: ${m.entity?.name || m.title}`,
          callback_data: `act_prepare:${m.entityId}`,
        }]);
      }
    });
    msg += '\n';
  }

  // Tasks with write button
  if (data.tasks.length > 0) {
    msg += '📋 <b>Задачи:</b>\n';
    data.tasks.forEach((t, i) => {
      msg += `• ${t.title}\n`;

      if (t.entityId) {
        buttons.push([{
          text: `💬 Написать ${t.entity?.name || 'контакту'}`,
          callback_data: `act_write:${t.entityId}:${t.id}`,
        }]);
      }
    });
    msg += '\n';
  }

  // Pending follow-ups with remind button
  if (data.pendingFollowups.length > 0) {
    msg += '👀 <b>Ждёшь ответа:</b>\n';
    data.pendingFollowups.forEach((f, i) => {
      const days = this.daysAgo(f.eventDate);
      msg += `• ${f.entity?.name} — ${f.title} (${days} дн.)\n`;

      if (f.entityId) {
        buttons.push([{
          text: `💬 Напомнить ${f.entity?.name || 'контакту'}`,
          callback_data: `act_remind:${f.entityId}:${f.id}`,
        }]);
      }
    });
    msg += '\n';
  }

  // Overdue with write button
  if (data.overduePromises.length > 0) {
    msg += '⚠️ <b>Просроченные:</b>\n';
    data.overduePromises.forEach((p, i) => {
      const days = this.daysOverdue(p.eventDate);
      msg += `• ${p.title} (просрочено ${days} дн.)\n`;

      if (p.entityId) {
        buttons.push([{
          text: `💬 Написать ${p.entity?.name || 'контакту'}`,
          callback_data: `act_write:${p.entityId}:${p.id}`,
        }]);
      }
    });
  }

  return { text: msg, buttons };
}
```

**Callback format:**
```
act_write:{entityId}:{eventId}   — Написать контакту по событию
act_prepare:{entityId}           — Подготовить brief
act_remind:{entityId}:{eventId}  — Напомнить (follow-up)
```

---

### A2.4 Proactive Message Generation Flow

При нажатии на проактивную кнопку система генерирует черновик на основе контекста.

#### Flow генерации

```
┌─────────────────────────────────────────────────────────────────────┐
│  Morning Brief:                                                      │
│  📋 Задачи:                                                          │
│  • Спросить у Маши про документы                                     │
│    [💬 Написать Маше]  ◄─── User clicks                             │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  1. ПОЛУЧИТЬ КОНТЕКСТ СОБЫТИЯ                                        │
│     EntityEvent {                                                    │
│       id: "event-123",                                               │
│       entityId: "maria-456",                                         │
│       title: "Спросить у Маши про документы",                        │
│       eventType: "task",                                             │
│       description: "Документы по проекту Альфа"                      │
│     }                                                                │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  2. ПОЛУЧИТЬ КОНТЕКСТ ПЕРЕПИСКИ                                      │
│     Последние 10 сообщений с Машей:                                  │
│     - "Привет! Как дела?"                                            │
│     - "Маш, скинь пожалуйста документы"                              │
│     - "Ок, сделаю на этой неделе"                                    │
│     - "Спасибо!"                                                     │
│                                                                      │
│     Определяем:                                                      │
│     - Тон: casual/friendly (обращение "Маш")                         │
│     - Стиль: короткие сообщения, эмодзи редко                        │
│     - Контекст: уже обсуждали документы, она обещала                 │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  3. LLM ГЕНЕРАЦИЯ ЧЕРНОВИКА                                          │
│                                                                      │
│  Prompt:                                                             │
│  """                                                                 │
│  Сгенерируй сообщение для Маша.                                      │
│                                                                      │
│  Контекст задачи: Спросить про документы по проекту Альфа            │
│                                                                      │
│  История переписки (для стиля):                                      │
│  - "Маш, скинь пожалуйста документы"                                 │
│  - "Ок, сделаю на этой неделе"                                       │
│                                                                      │
│  Требования:                                                         │
│  - Вежливое напоминание (не давить)                                  │
│  - Соответствует тону из истории                                     │
│  - Краткое (1-2 предложения)                                         │
│  - Естественное, как от реального человека                           │
│  """                                                                 │
│                                                                      │
│  Результат:                                                          │
│  "Маш, привет! Как там с документами по Альфе? 🙂"                   │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  4. ПОКАЗАТЬ APPROVAL                                                │
│                                                                      │
│  📤 Отправить сообщение?                                             │
│                                                                      │
│  Кому: Мария Иванова                                                 │
│                                                                      │
│  Текст:                                                              │
│  Маш, привет! Как там с документами по Альфе? 🙂                     │
│                                                                      │
│  [✅ Отправить] [✏️ Изменить] [❌ Отмена]                            │
└─────────────────────────────────────────────────────────────────────┘
```

#### Типы проактивных действий

| Кнопка | Callback | Контекст для генерации |
|--------|----------|------------------------|
| `[💬 Написать X]` | `act_write:{entityId}:{eventId}` | EventEvent.title + description |
| `[💬 Напомнить X]` | `act_remind:{entityId}:{eventId}` | Follow-up reason + время ожидания |
| `[📋 Brief: X]` | `act_prepare:{entityId}` | Не генерирует сообщение, показывает brief |

#### Примеры генерации по типу события

**TASK (Задача):**
```
EventEvent: "Спросить у Маши про документы"
→ "Маш, привет! Как там с документами?"
```

**FOLLOW_UP (Ожидание ответа, 3 дня):**
```
EventEvent: "Ждём ответ от Сергея по встрече"
→ "Сергей, привет! Вернусь к вопросу о встрече — получилось определиться со временем?"
```

**COMMITMENT (Просроченное обещание):**
```
EventEvent: "Отправить отчёт Ивану" (просрочено 2 дня)
→ "Иван, привет! Извини за задержку с отчётом — отправлю сегодня до конца дня."
```

**FOLLOW_UP с контекстом задолженности:**
```
EventEvent: "Маша обещала документы" (ждём 5 дней)
→ "Маш, как там документы? Если что-то задерживает, дай знать — может, чем-то помочь?"
```

#### ProactiveMessageService

```typescript
@Injectable()
export class ProactiveMessageService {
  constructor(
    private readonly claudeAgentService: ClaudeAgentService,
    private readonly entityEventService: EntityEventService,
    private readonly contextService: ContextService,
    private readonly entityService: EntityService,
  ) {}

  /**
   * Generate draft message based on event context
   */
  async generateFromEvent(
    entityId: string,
    eventId: string,
  ): Promise<{ draft: string; context: MessageContext }> {
    // 1. Get event details
    const event = await this.entityEventService.findOne(eventId);
    const entity = await this.entityService.findOne(entityId);

    // 2. Get conversation history for tone matching
    const recentMessages = await this.contextService.getRecentMessages(entityId, 10);
    const tone = this.detectTone(recentMessages);

    // 3. Build context-aware prompt
    const prompt = this.buildPrompt(event, entity.name, recentMessages, tone);

    // 4. Generate draft
    const { data } = await this.claudeAgentService.call<{ message: string }>({
      mode: 'oneshot',
      taskType: 'proactive_draft',
      prompt,
      model: 'haiku',
      schema: DRAFT_SCHEMA,
    });

    return {
      draft: data.message,
      context: {
        eventTitle: event.title,
        entityName: entity.name,
        tone,
        eventType: event.eventType,
      },
    };
  }

  private buildPrompt(
    event: EntityEvent,
    entityName: string,
    recentMessages: string[],
    tone: 'formal' | 'casual' | 'friendly',
  ): string {
    const firstName = entityName.split(' ')[0];

    let taskDescription = event.title;
    if (event.description) {
      taskDescription += `. Детали: ${event.description}`;
    }

    // Add urgency context
    let urgencyContext = '';
    if (event.eventType === 'follow_up') {
      const daysWaiting = this.daysAgo(event.eventDate);
      if (daysWaiting > 3) {
        urgencyContext = `\nУже ждём ответа ${daysWaiting} дней — мягко напомнить.`;
      }
    } else if (event.eventType === 'commitment') {
      const daysOverdue = this.daysOverdue(event.eventDate);
      if (daysOverdue > 0) {
        urgencyContext = `\nЗадача просрочена на ${daysOverdue} дней — извиниться за задержку.`;
      }
    }

    return `Сгенерируй короткое сообщение для ${firstName}.

Задача: ${taskDescription}${urgencyContext}

История переписки (для понимания стиля):
${recentMessages.slice(0, 5).map(m => `- "${m}"`).join('\n')}

Тон общения: ${tone}

Требования:
- 1-2 предложения максимум
- Естественно, как реальный человек
- Соответствует тону из истории (обращение, стиль)
- Вежливо, но не формально${tone === 'casual' ? '\n- Можно использовать эмодзи если они есть в истории' : ''}`;
  }

  private detectTone(messages: string[]): 'formal' | 'casual' | 'friendly' {
    const text = messages.join(' ').toLowerCase();

    // Formal indicators
    if (text.includes('добрый день') || text.includes('уважаем') || text.includes('с уважением')) {
      return 'formal';
    }

    // Casual indicators
    if (text.includes('привет') || text.includes('ок') || /\b(маш|саш|серёг|петь)\b/.test(text)) {
      return 'casual';
    }

    return 'friendly';
  }
}
```

### A2.5 Proactive Action Handler (Day 5)

**Файл:** `apps/telegram-adapter/src/bot/handlers/proactive-action.handler.ts`

```typescript
@Injectable()
export class ProactiveActionHandler {
  canHandle(data: string): boolean {
    return data.startsWith('act_write:') ||
           data.startsWith('act_prepare:') ||
           data.startsWith('act_remind:');
  }

  async handle(ctx: Context, data: string): Promise<void> {
    const parts = data.split(':');
    const action = parts[0];
    const entityId = parts[1];
    const eventId = parts[2];

    switch (action) {
      case 'act_write':
        await this.initiateWrite(ctx, entityId, eventId);
        break;
      case 'act_prepare':
        await this.prepareBrief(ctx, entityId);
        break;
      case 'act_remind':
        await this.initiateRemind(ctx, entityId, eventId);
        break;
    }
  }

  private async initiateWrite(ctx: Context, entityId: string, eventId?: string): Promise<void> {
    await ctx.answerCbQuery('Готовлю сообщение...');

    // Get event context if provided
    let intent = 'напомнить о задаче';
    if (eventId) {
      const event = await this.getEvent(eventId);
      intent = `напомнить о: ${event.title}`;
    }

    // Call /agent/act to generate draft
    const response = await this.httpService.post('/agent/act', {
      instruction: `напиши ${await this.getEntityName(entityId)}: ${intent}`,
      entityId,
    }).toPromise();

    // Approval message will be sent by ApprovalHookService
  }

  private async prepareBrief(ctx: Context, entityId: string): Promise<void> {
    await ctx.answerCbQuery('Готовлю brief...');

    const response = await this.httpService.post(`/agent/prepare/${entityId}`).toPromise();
    const { brief, entityName } = response.data;

    await ctx.reply(this.formatBrief(entityName, brief), { parse_mode: 'HTML' });
  }
}
```

---

### A2.5 Follow-up Handler (Day 6)

**Файл:** `apps/telegram-adapter/src/bot/handlers/followup.handler.ts`

```typescript
@Injectable()
export class FollowupHandler {
  canHandle(data: string): boolean {
    return data.startsWith('followup_');
  }

  async handle(ctx: Context, data: string): Promise<void> {
    const [action, approvalId] = data.split(':');

    switch (action) {
      case 'followup_2h':
        await this.createFollowup(ctx, approvalId, 2, 'hours');
        break;
      case 'followup_1d':
        await this.createFollowup(ctx, approvalId, 1, 'days');
        break;
      case 'followup_skip':
        await ctx.editMessageText('👍 Хорошо, напоминание не создано');
        break;
    }
  }

  private async createFollowup(
    ctx: Context,
    approvalId: string,
    amount: number,
    unit: 'hours' | 'days',
  ): Promise<void> {
    // Get approval data to know entityId and what was sent
    const approval = await this.getApproval(approvalId);

    const checkDate = new Date();
    if (unit === 'hours') {
      checkDate.setHours(checkDate.getHours() + amount);
    } else {
      checkDate.setDate(checkDate.getDate() + amount);
    }

    await this.httpService.post('/entity-events', {
      entityId: approval.entityId,
      eventType: 'follow_up',
      title: `Проверить ответ: ${approval.entityName}`,
      eventDate: checkDate.toISOString(),
    }).toPromise();

    const timeText = unit === 'hours' ? `${amount} часа` : 'завтра';
    await ctx.editMessageText(`✅ Напомню проверить ответ через ${timeText}`);
  }
}
```

---

### A2.6 /act Command (Day 6)

**Файл:** `apps/telegram-adapter/src/bot/handlers/act-command.handler.ts`

```typescript
@Injectable()
export class ActCommandHandler {
  async handle(ctx: Context): Promise<void> {
    const text = ctx.message.text;
    const instruction = text.replace(/^\/act\s*/i, '').trim();

    if (!instruction) {
      await ctx.reply(
        'Использование: /act <что сделать>\n\n' +
        'Примеры:\n' +
        '• /act напиши Сергею что встреча переносится\n' +
        '• /act напомни Маше про документы\n' +
        '• /act спроси у Пети когда будет готов отчёт',
      );
      return;
    }

    await ctx.reply('🤖 Обрабатываю...');

    try {
      await this.httpService.post('/agent/act', { instruction }).toPromise();
      // Approval message will be sent by ApprovalHookService
    } catch (error) {
      await ctx.reply('❌ Не удалось обработать запрос. Попробуй переформулировать.');
    }
  }
}
```

---

## Критические файлы

| Сервис | Файл | Описание |
|--------|------|----------|
| pkg-core | `tools/action-tools.provider.ts` | **Новый** — draft, send, followup tools |
| pkg-core | `hooks/approval-hook.service.ts` | **Новый** — approval state machine |
| pkg-core | `telegram/telegram-send.service.ts` | **Новый** — отправка через юзербот |
| pkg-core | `notification/digest.service.ts` | Добавить action buttons |
| telegram-adapter | `controllers/telegram.controller.ts` | Добавить send-as-user endpoint |
| telegram-adapter | `services/userbot.service.ts` | Добавить sendMessage |
| telegram-adapter | `handlers/approval-callback.handler.ts` | **Новый** |
| telegram-adapter | `handlers/text-input.handler.ts` | **Новый** |
| telegram-adapter | `handlers/proactive-action.handler.ts` | **Новый** |
| telegram-adapter | `handlers/followup.handler.ts` | **Новый** |
| telegram-adapter | `handlers/act-command.handler.ts` | **Новый** |
| telegram-adapter | `services/conversation-state.service.ts` | **Новый** — Redis state |

---

## Верификация

```bash
# Unit tests
cd apps/pkg-core && pnpm test -- action-tools
cd apps/pkg-core && pnpm test -- approval-hook
cd apps/telegram-adapter && pnpm test -- approval-callback

# Manual testing
# 1. /act напиши Сергею привет
#    → Должен показать черновик с 3 кнопками
# 2. Нажать "Изменить"
#    → Должен показать "Задать / Как есть"
# 3. Нажать "Задать", написать "спросить про работу"
#    → Должен сгенерировать новый текст
# 4. Нажать "Отправить"
#    → Сообщение должно отправиться через юзербот
# 5. Должен показать follow-up suggestion
# 6. Проверить Morning Brief с action buttons
```

---

## Риски

| Риск | Вероятность | Митигация |
|------|-------------|-----------|
| Timeout approval | Средняя | Сообщение "Время истекло" + возможность повторить |
| Юзербот rate limits | Низкая | Queue с rate limiting |
| Неправильный получатель | Низкая | Всегда показывать имя перед отправкой |
| Потеря conversation state | Низкая | Redis TTL 5 min, graceful recovery |
| LLM генерирует неуместный текст | Средняя | Всегда approval, кнопка "Как есть" |
