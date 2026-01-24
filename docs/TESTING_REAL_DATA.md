# Тестирование на реальных данных

> **Принцип:** E2E тесты с моками показывают, что код работает. Тесты на реальных данных показывают, что **система работает**.

## Зачем нужно тестирование на реальных данных

| E2E тесты (моки) | Реальные данные |
|------------------|-----------------|
| Проверяют контракты API | Проверяют реальную интеграцию |
| Изолированы от внешних сервисов | Используют Claude API, PostgreSQL, embeddings |
| Быстрые, детерминированные | Показывают реальное поведение |
| Обязательны для CI/CD | Обязательны перед релизом |

## Подготовка

### 1. Запуск сервера

```bash
cd apps/pkg-core
pnpm dev
```

Проверка здоровья:
```bash
curl -s http://localhost:3000/health | jq
# Ожидаемый результат:
# {"status":"ok","timestamp":"...","services":{"database":"connected"}}
```

### 2. API ключ

Получить из `.env`:
```bash
grep "^API_KEY=" .env
```

Использовать в запросах:
```bash
curl -H "X-API-Key: <ваш_ключ>" ...
```

### 3. Получение тестовых entity

```bash
API_KEY="ваш_ключ"

# Список entity с читаемыми именами
curl -s -H "X-API-Key: $API_KEY" \
  "http://localhost:3000/api/v1/entities?limit=20" | \
  jq '.items[] | select(.name | test("^[А-Яа-яA-Za-z]")) | {id, name, type}'
```

---

## Тесты по модулям

### Agent Module

#### 1. Agent Recall — поиск в естественном языке

**Endpoint:** `POST /api/v1/agent/recall`

```bash
curl -s -X POST \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "О чём договаривались с [Имя]?", "maxTurns": 10}' \
  "http://localhost:3000/api/v1/agent/recall" | jq
```

**Ожидаемый результат:**
```json
{
  "success": true,
  "data": {
    "answer": "...",           // Синтезированный ответ
    "sources": [...],          // Массив источников с preview
    "toolsUsed": [...]         // Использованные инструменты
  }
}
```

**Проверить:**
- [ ] `answer` содержит релевантную информацию
- [ ] `sources` содержит реальные message ID
- [ ] `toolsUsed` включает `search_messages`

#### 2. Agent Prepare — подготовка к встрече

**Endpoint:** `GET /api/v1/agent/prepare/:entityId`

```bash
ENTITY_ID="uuid-из-списка-выше"

curl -s -H "X-API-Key: $API_KEY" \
  "http://localhost:3000/api/v1/agent/prepare/$ENTITY_ID" | jq
```

**Ожидаемый результат:**
```json
{
  "success": true,
  "data": {
    "entityId": "...",
    "entityName": "...",
    "brief": "# Бриф для встречи...",
    "recentInteractions": 5,
    "openQuestions": [...]
  }
}
```

**Проверить:**
- [ ] `brief` содержит структурированную информацию
- [ ] Факты из базы (должность, компания) отражены в брифе
- [ ] `recentInteractions` соответствует реальному количеству

#### 3. Agent Act — выполнение действий

**Endpoint:** `POST /api/v1/agent/act`

```bash
curl -s -X POST \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Напомни позвонить [Имя] завтра в 10:00"}' \
  "http://localhost:3000/api/v1/agent/act" | jq
```

---

### Extraction Module

#### 1. Извлечение фактов (прямой режим)

**Endpoint:** `POST /api/v1/extraction/facts`

```bash
curl -s -X POST \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "entityId": "'$ENTITY_ID'",
    "messages": [
      {"content": "Иван работает в Яндексе product manager-ом", "timestamp": "2025-01-24T12:00:00Z"}
    ]
  }' \
  "http://localhost:3000/api/v1/extraction/facts" | jq
```

#### 2. Извлечение фактов (агентный режим)

**Endpoint:** `POST /api/v1/extraction/facts/agent`

Создать файл с запросом (для кириллицы):
```bash
cat > /tmp/extraction-test.json << 'EOF'
{
  "entityId": "uuid-entity",
  "entityName": "Имя",
  "messageContent": "Текст сообщения с фактами",
  "context": {
    "isOutgoing": false,
    "chatType": "private",
    "senderName": "Имя"
  }
}
EOF

curl -s -X POST \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d @/tmp/extraction-test.json \
  "http://localhost:3000/api/v1/extraction/facts/agent" | jq
```

**Ожидаемый результат:**
```json
{
  "entityId": "...",
  "factsCreated": 3,
  "relationsCreated": 1,
  "pendingEntitiesCreated": 0,
  "turns": 12,
  "toolsUsed": ["find_entity_by_name", "create_fact", "create_relation"]
}
```

**Проверить созданные факты:**
```bash
curl -s -H "X-API-Key: $API_KEY" \
  "http://localhost:3000/api/v1/entities/$ENTITY_ID" | \
  jq '.facts[] | {factType, value, source}'
```

---

### Entity Module

#### 1. Список entity

```bash
curl -s -H "X-API-Key: $API_KEY" \
  "http://localhost:3000/api/v1/entities?limit=10" | jq '.items | length'
```

#### 2. Детали entity

```bash
curl -s -H "X-API-Key: $API_KEY" \
  "http://localhost:3000/api/v1/entities/$ENTITY_ID" | \
  jq '{name, type, factsCount: (.facts | length)}'
```

#### 3. Создание entity

```bash
curl -s -X POST \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "person", "name": "Тестовый Контакт"}' \
  "http://localhost:3000/api/v1/entities" | jq
```

---

### Search Module

#### 1. Поиск сообщений

```bash
curl -s -H "X-API-Key: $API_KEY" \
  "http://localhost:3000/api/v1/search/messages?query=встреча&limit=5" | jq
```

#### 2. Семантический поиск

```bash
curl -s -X POST \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "обсуждение проекта", "limit": 10}' \
  "http://localhost:3000/api/v1/search/semantic" | jq
```

---

## Чек-лист перед релизом

### Базовая функциональность
- [ ] Health check возвращает `status: ok`
- [ ] Database connected
- [ ] Entity CRUD работает

### Agent Module
- [ ] `/agent/recall` — находит сообщения, синтезирует ответ
- [ ] `/agent/prepare/:id` — генерирует бриф с фактами
- [ ] `/agent/act` — создаёт напоминания/действия

### Extraction Module
- [ ] `/extraction/facts` — извлекает факты из сообщений
- [ ] `/extraction/facts/agent` — агентный режим с MCP tools
- [ ] Факты сохраняются в базу с правильными типами

### Search Module
- [ ] FTS поиск работает
- [ ] Semantic search возвращает релевантные результаты

### Интеграции
- [ ] Claude API отвечает (не timeout)
- [ ] Embeddings генерируются
- [ ] MCP tools вызываются агентом

---

## Troubleshooting

### Ошибка 401 Unauthorized
```bash
# Проверить API ключ
grep "^API_KEY=" .env

# Убедиться, что передаёте правильно
curl -v -H "X-API-Key: $API_KEY" ...
```

### Timeout при вызове агента
```bash
# Увеличить timeout curl
curl --max-time 120 ...

# Проверить логи сервера
tail -f /tmp/pkg-server.log
```

### Кириллица в curl
```bash
# Использовать файл вместо inline JSON
cat > /tmp/request.json << 'EOF'
{"query": "Текст на русском"}
EOF
curl -d @/tmp/request.json ...
```

### Факты не создаются (factsCreated: 0)
- Проверить, не существуют ли уже такие факты (дедупликация)
- Проверить логи на ошибки tool calls
- Увеличить `maxTurns` если агент не успевает

---

## Автоматизация

### Скрипт полного тестирования

```bash
#!/bin/bash
# test-real-data.sh

API_KEY=$(grep "^API_KEY=" .env | cut -d= -f2)
BASE_URL="http://localhost:3000/api/v1"

echo "=== Health Check ==="
curl -s "$BASE_URL/../health" | jq -e '.status == "ok"' || exit 1

echo "=== Get Test Entity ==="
ENTITY=$(curl -s -H "X-API-Key: $API_KEY" "$BASE_URL/entities?limit=1" | jq -r '.items[0]')
ENTITY_ID=$(echo $ENTITY | jq -r '.id')
ENTITY_NAME=$(echo $ENTITY | jq -r '.name')
echo "Testing with: $ENTITY_NAME ($ENTITY_ID)"

echo "=== Agent Recall ==="
curl -s -X POST -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d "{\"query\": \"Информация о $ENTITY_NAME\", \"maxTurns\": 5}" \
  "$BASE_URL/agent/recall" | jq -e '.success == true' || echo "WARN: recall failed"

echo "=== Agent Prepare ==="
curl -s -H "X-API-Key: $API_KEY" \
  "$BASE_URL/agent/prepare/$ENTITY_ID" | jq -e '.success == true' || echo "WARN: prepare failed"

echo "=== All tests completed ==="
```

---

## См. также

- [API_CONTRACTS.md](./API_CONTRACTS.md) — спецификации API
- [ARCHITECTURE.md](./ARCHITECTURE.md) — архитектура системы
- [docs/second-brain/](./second-brain/) — документация Second Brain
