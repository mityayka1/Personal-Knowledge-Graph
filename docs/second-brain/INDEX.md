# PKG Second Brain — Implementation Roadmap

> Пошаговый план развития Personal Knowledge Graph от текущего состояния до полноценной "второй памяти"

## Executive Summary

Этот документ описывает трёхфазный план развития PKG, который превратит систему из инструмента хранения данных в проактивного персонального ассистента. План построен по принципу "от быстрых побед к сложным фичам": сначала получаем работающий продукт, затем добавляем интеллект.

**Общая продолжительность:** 6-8 недель
**Результат:** Работающая "вторая память" с Recall, Prepare, Extract & React, и Act capabilities

---

## Содержание

| Документ | Описание | Статус |
|----------|----------|--------|
| [00-BASELINE.md](./00-BASELINE.md) | Текущее состояние, готовая инфраструктура | ✅ Verified |
| [01-PHASE-B-RECALL-PREPARE.md](./01-PHASE-B-RECALL-PREPARE.md) | Фаза B: Recall/Prepare API + Telegram | ✅ Completed |
| [02-PHASE-C-EXTRACT-REACT.md](./02-PHASE-C-EXTRACT-REACT.md) | Фаза C: Extract & React (события, уведомления) | ✅ Completed |
| [03-PHASE-A-ACT.md](./03-PHASE-A-ACT.md) | Фаза A: Act Capabilities (отправка сообщений) | 🔄 In Progress |
| [04-TIMELINE-METRICS.md](./04-TIMELINE-METRICS.md) | Timeline, Success Metrics, Risk Mitigation | Reference |

---

## Фазы проекта

### Phase B: Recall/Prepare ✅
**Цель:** Поиск информации и подготовка к встречам

- POST /agent/recall — поиск в естественном языке
- POST /agent/prepare/:entityId — meeting brief
- Telegram команды /recall и /prepare

### Phase C: Extract & React ✅
**Цель:** Проактивное извлечение событий из переписки

- ExtractedEvent entity
- SecondBrainExtractionService
- Carousel UX для событий
- Context-Aware Extraction
- Morning brief, digests

### Phase A: Act 🔄
**Цель:** Отправка сообщений с подтверждением

- ActionToolsProvider (draft_message, send_telegram)
- Approval Flow через Telegram
- Proactive action buttons

---

## Quick Links

- [CLAUDE.md](../../CLAUDE.md) — основные инструкции проекта
- [ARCHITECTURE.md](../ARCHITECTURE.md) — архитектура системы
- [API_CONTRACTS.md](../API_CONTRACTS.md) — API контракты
