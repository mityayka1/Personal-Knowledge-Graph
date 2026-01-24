# Timeline, Metrics & Risk Mitigation

## Timeline Summary

```
Week 1: Phase B - API и базовая интеграция
  Day 1: Верификация миграции
  Day 2-3: Recall endpoint
  Day 4-5: Prepare endpoint

Week 2: Phase B - Telegram интеграция
  Day 6-7: Telegram bot handlers
  Day 8-10: Testing и polish

Week 3: Phase C - Сущности и extraction
  Day 11-12: ExtractedEvent entity
  Day 13-15: EventExtractionService

Week 4: Phase C - Notifications
  Day 16-17: Message processing pipeline
  Day 18-19: NotificationService
  Day 20-21: Callback handlers

Week 5: Phase C - Scheduled jobs
  Day 22-24: Cron jobs и DigestService

Week 6-7: Phase A - Act capabilities
  Day 25-26: ActionToolsProvider
  Day 27-28: Approval hooks
  Day 29-30: Act endpoint и integration
```

---

## Success Metrics

### Phase B (Recall/Prepare)

| Метрика | Target |
|---------|--------|
| Recall отвечает на запросы с релевантными источниками | 80%+ |
| Prepare генерирует полезный brief | < 30 сек |
| Использование /recall в неделю | ≥ 5 раз |

### Phase C (Extract & React)

| Метрика | Target |
|---------|--------|
| Корректность извлечённых событий | 85%+ |
| False positives (лишние уведомления) | < 5% |
| Morning brief отправляется | Ежедневно 08:00 |

### Phase A (Act)

| Метрика | Target |
|---------|--------|
| Сообщения проходят через approval | 100% |
| Отправка без подтверждения | 0 случаев |
| Время от запроса до отправки | < 60 сек |

---

## Risk Mitigation

| Риск | Вероятность | Митигация |
|------|-------------|-----------|
| LLM rate limits | Средняя | Batch processing, caching, fallback на haiku |
| Некорректное извлечение | Средняя | Confidence thresholds, user confirmation |
| Spam уведомлениями | Средняя | Digests, quiet hours, priority filtering |
| Неавторизованная отправка | Низкая | Mandatory approval hook, audit log |
| Telegram API limits | Низкая | Rate limiting, queue |

---

## Next Steps After Completion

После завершения всех трёх фаз:

1. **Web Dashboard** — управление напоминаниями, просмотр извлечённых событий
2. **Voice Interface** — голосовые команды через Telegram voice messages
3. **Calendar Integration** — синхронизация с Google Calendar
4. **Multi-user** — поддержка нескольких пользователей
5. **Analytics** — статистика общения, паттерны коммуникации
