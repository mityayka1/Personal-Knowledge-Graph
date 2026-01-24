# Текущее состояние (Baseline)

> Готовая инфраструктура перед началом работы над Second Brain

## Готовая инфраструктура

| Компонент | Статус | Описание |
|-----------|--------|----------|
| ClaudeAgentService | ✅ Ready | Поддержка oneshot и agent modes |
| ToolsRegistryService | ✅ Ready | Категории: search, entities, events, context |
| SearchToolsProvider | ✅ Ready | `search_messages`, hybrid search |
| EntityToolsProvider | ✅ Ready | `list_entities`, `get_entity_details` |
| EventToolsProvider | ✅ Ready | `create_reminder`, `get_upcoming_events` |
| ContextToolsProvider | ✅ Ready | `get_entity_context` для meeting prep |
| EntityEventService | ✅ Ready | CRUD для событий/напоминаний |
| Hybrid Search | ✅ Ready | FTS + Vector + RRF |

## Чеклист верификации

Перед началом работы над новыми фичами необходимо убедиться, что миграция на Agent SDK полностью завершена:

### Проверки

```bash
# Проверки
ls -la apps/pkg-core/src/modules/claude-cli/  # Должна быть ошибка "No such file"
grep -r "ClaudeCliService" apps/pkg-core/src/  # 0 результатов
grep -r "claudeCliService" apps/pkg-core/src/  # 0 результатов
grep -r "claude-cli" apps/pkg-core/src/modules/ --include="*.ts"  # 0 результатов

# Запуск тестов
cd apps/pkg-core && pnpm test
```

### Acceptance Criteria

- [x] Директория `claude-cli/` не существует
- [x] Нет импортов ClaudeCliService в коде
- [x] Все unit тесты проходят
- [x] Приложение запускается без ошибок

## Мигрированные сервисы

Все 4 сервиса используют ClaudeAgentService:

1. **SummarizationService** — суммаризация взаимодействий
2. **EntityProfileService** — генерация профилей контактов
3. **ContextService** — синтез контекста для встреч
4. **FactExtractionService** — извлечение фактов из сообщений
