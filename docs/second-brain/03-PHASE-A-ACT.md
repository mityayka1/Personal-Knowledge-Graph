# Фаза A: Act Capabilities

**Цель:** Система может выполнять действия (отправка сообщений) с подтверждением пользователя.

**Продолжительность:** 1-2 недели

**Бизнес-ценность:** Пользователь может попросить "напиши Сергею что встреча переносится" и система подготовит и отправит сообщение.

---

## Архитектура

### Bot + Userbot разделение

```
┌─────────────────────────────────────────────────────────────┐
│                    TELEGRAM ADAPTER                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────┐              ┌─────────────────┐       │
│  │      BOT        │              │    USERBOT      │       │
│  │  (@pkg_bot)     │              │    (GramJS)     │       │
│  ├─────────────────┤              ├─────────────────┤       │
│  │ • Уведомления   │              │ • Чтение чатов  │       │
│  │ • Кнопки UI     │              │ • Отправка      │       │
│  │ • Approval flow │              │   сообщений     │       │
│  │ • Morning brief │              │   ОТ ИМЕНИ      │       │
│  │                 │              │   ПОЛЬЗОВАТЕЛЯ  │       │
│  └────────┬────────┘              └────────▲────────┘       │
│           │                                │                 │
│           │    [✅ Отправить]              │                 │
│           └────────────────────────────────┘                 │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Задачи

### A1.1: ActionToolsProvider

```typescript
@Injectable()
export class ActionToolsProvider {
  private cachedTools: ToolDefinition[] | null = null;

  getTools(): ToolDefinition[] {
    if (!this.cachedTools) {
      this.cachedTools = this.createTools();
    }
    return this.cachedTools;
  }

  private createTools() {
    return [
      tool(
        'draft_message',
        `Create a draft message for a contact WITHOUT sending it.
Use this to show the user what message will be sent before getting approval.`,
        {
          entityId: z.string().uuid().describe('ID of the recipient'),
          intent: z.string().describe('What the message should communicate'),
          tone: z.enum(['formal', 'casual', 'friendly']).default('friendly'),
        },
        async (args) => {
          const entity = await this.entityService.findOne(args.entityId);
          if (!entity) return toolError(`Entity not found`);

          const draft = await this.generateDraft(entity.name, args.intent, args.tone);
          return toolSuccess({ draft, recipient: entity.name });
        }
      ),

      tool(
        'send_telegram',
        `Send a Telegram message. ⚠️ REQUIRES USER APPROVAL.
Always use draft_message first.`,
        {
          entityId: z.string().uuid().describe('ID of the recipient'),
          text: z.string().min(1).max(4096).describe('Message text'),
        },
        async (args) => {
          await this.telegramService.sendToEntity(args.entityId, args.text);
          return toolSuccess({ sent: true });
        }
      ),

      tool(
        'schedule_followup',
        `Schedule a follow-up reminder for a contact.`,
        {
          entityId: z.string().uuid().describe('ID of the contact'),
          reason: z.string().describe('What to follow up about'),
          checkAfter: z.string().describe('When to check (ISO or relative)'),
        },
        async (args) => {
          const event = await this.entityEventService.create({
            entityId: args.entityId,
            eventType: EventType.FOLLOW_UP,
            title: `Follow up: ${args.reason}`,
            eventDate: parseDate(args.checkAfter),
          });
          return toolSuccess({ created: true, id: event.id });
        }
      ),
    ];
  }
}
```

---

### A1.2: Approval Hook

```typescript
@Injectable()
export class ApprovalHookService {
  private readonly pendingApprovals = new Map<string, {
    resolve: (result: ApprovalResult) => void;
    timeout: NodeJS.Timeout;
  }>();

  createHook(): AgentHooks {
    return {
      onToolUse: async (toolName: string, input: unknown) => {
        if (toolName === 'send_telegram') {
          return this.requestApproval(toolName, input);
        }
        return { approve: true };
      },
    };
  }

  async requestApproval(action: string, input: { entityId: string; text: string }) {
    const entity = await this.entityService.findOne(input.entityId);
    const eventId = randomUUID();

    const message = `📤 **Отправить сообщение?**

**Кому:** ${entity?.name}

**Текст:**
${input.text}`;

    const buttons = [
      [
        { text: '✅ Отправить', callback_data: `approve:${eventId}` },
        { text: '❌ Отмена', callback_data: `reject:${eventId}` },
      ],
      [
        { text: '✏️ Редактировать', callback_data: `edit:${eventId}` },
      ],
    ];

    await this.telegramNotifier.sendWithButtons(message, buttons);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingApprovals.delete(eventId);
        resolve({ approve: false, reason: 'Timeout' });
      }, 120000);

      this.pendingApprovals.set(eventId, { resolve, timeout });
    });
  }
}
```

---

### A1.4: Act API Endpoint

```typescript
@Post('act')
async act(@Body() dto: ActRequestDto): Promise<ActResponseDto> {
  const approvalHook = this.approvalHookService.createHook();

  const { data, usage, toolsUsed } = await this.agentService.call<ActResult>({
    mode: 'agent',
    taskType: 'action',
    prompt: this.buildActPrompt(dto.instruction),
    toolCategories: ['entities', 'events', 'actions'],
    hooks: approvalHook,
    maxTurns: 10,
  });

  return { result: data, actions: this.extractActions(toolsUsed), usage };
}

private buildActPrompt(instruction: string): string {
  return `Выполни действие: "${instruction}"

Порядок:
1. Найди контакта (list_entities)
2. Создай черновик (draft_message)
3. Дождись подтверждения и отправь (send_telegram)
4. Создай follow-up если нужно (schedule_followup)

ВАЖНО: Всегда показывай пользователю что будет отправлено ПЕРЕД отправкой.`;
}
```

---

## UX Улучшения

### Approval Flow

```
📤 Отправить сообщение?

Кому: Мария Иванова

Текст:
Привет, Маша! Напоминаю про документы.

[✅ Отправить] [✏️ Изменить] [❌ Отмена]
```

### Двухрежимное редактирование

При нажатии "Изменить":

```
Как хочешь изменить сообщение?

[💡 Задать] — опиши что написать, AI сформулирует
[📝 Как есть] — напиши точный текст
```

### Proactive Action Buttons

Morning Brief с кнопками действий:

```
🌅 Доброе утро! Вот твой день:

📅 Встречи:
• 15:00 — Созвон с Петром
  [📋 Подготовить brief]

📋 Задачи:
• Спросить у Маши про документы
  [💬 Написать Маше]

👀 Ждёшь ответа:
• Сергей — встреча (ждёшь 3 дня)
  [💬 Напомнить Сергею]
```

### Follow-up после отправки

```
✅ Сообщение отправлено Маше

💡 Создать напоминание проверить ответ?

[⏰ Через 2 часа] [📅 Завтра] [🚫 Не нужно]
```

---

## Deliverables

1. **Tools:**
   - ActionToolsProvider (draft_message, send_telegram, schedule_followup)

2. **Hooks:**
   - ApprovalHookService — запрос подтверждения через Telegram

3. **Services:**
   - TelegramSendService — отправка через юзербот

4. **API:**
   - POST /agent/act
   - POST /telegram/send-as-user

5. **Telegram Bot:**
   - /act команда
   - Approval callbacks
   - Edit mode selection
   - Proactive action buttons
   - Follow-up suggestion
