---
module: Claude Agent Integration
date: 2026-01-25
problem_type: integration_issue
component: authentication
symptoms:
  - "OAuth token has expired error from Claude API"
  - "401 authentication_error on context generation"
  - "Context generated without facts despite messages present"
root_cause: config_error
resolution_type: environment_setup
severity: high
tags: [claude-api, oauth, authentication, docker, credentials]
---

# Claude OAuth Token Expired

**Дата:** 2026-01-25
**Сервер:** 82.22.23.59 (assistant.mityayka.ru)

## Симптомы

1. Context generation возвращает пустые факты несмотря на наличие сообщений
2. В логах ошибка:
   ```
   API Error: 401 {"type":"error","error":{"type":"authentication_error",
   "message":"OAuth token has expired. Please obtain a new token or refresh your existing token."}}
   ```
3. Claude agent не может вызвать API для синтеза контекста

## Причина

OAuth токен в файле `~/.claude/.credentials.json` на сервере истёк. Токен имеет поле `expiresAt` с Unix timestamp, после которого требуется refresh.

**Структура credentials файла:**
```json
{
  "claudeAiOauth": {
    "accessToken": "...",
    "refreshToken": "...",
    "expiresAt": 1768354681267,
    "scopes": ["user:inference"],
    "tokenType": "Bearer"
  }
}
```

## Диагностика

```bash
# Проверить credentials на сервере
ssh mityayka@82.22.23.59
cat ~/.claude/.credentials.json | jq '.claudeAiOauth.expiresAt'

# Конвертировать timestamp в дату
date -d @$(echo "1768354681267/1000" | bc)

# Тест CLI
npx @anthropic-ai/claude-code --print -p "say hello"
```

## Решение

### Шаг 1: Авторизовать Claude CLI на сервере

```bash
ssh mityayka@82.22.23.59
npx @anthropic-ai/claude-code
```

Claude CLI покажет ссылку для headless авторизации:
```
To sign in, please visit: https://claude.ai/oauth/...
Enter the code shown after authentication:
```

1. Открыть ссылку в браузере на локальной машине
2. Авторизоваться в claude.ai
3. Скопировать код авторизации
4. Ввести код в терминале сервера

### Шаг 2: Перезапустить контейнер

```bash
cd /opt/apps/pkg/docker
docker compose restart pkg-core
```

Контейнер монтирует credentials из хоста:
```yaml
# docker-compose.yml
volumes:
  - ${CLAUDE_CREDENTIALS_PATH:-~/.claude}/.credentials.json:/tmp/claude-credentials.json:ro
```

### Шаг 3: Верификация

```bash
# Проверить статус контейнера
docker compose ps

# Тест context generation
curl -X POST http://localhost:3000/api/v1/context \
  -H "Content-Type: application/json" \
  -d '{"entityId": "<uuid>"}'
```

Ожидаемый результат:
```json
{
  "entityName": "...",
  "sources": {
    "hotMessagesCount": 50,
    "factsIncluded": 6
  }
}
```

## Превентивные меры

1. **Мониторинг expiration:** Добавить проверку `expiresAt` в health checks
2. **Документация:** Добавить процедуру refresh в runbook
3. **Автоматизация:** Рассмотреть использование API ключа вместо OAuth для production (не истекает)

## Альтернатива: API ключ вместо OAuth

Для production серверов рекомендуется использовать API ключ:

```bash
# Получить API ключ: https://console.anthropic.com
export ANTHROPIC_API_KEY=sk-ant-api03-...
```

API ключ не истекает и не требует интерактивной авторизации.

**Важно:** Если установлен `ANTHROPIC_API_KEY`, Claude Code использует его вместо OAuth подписки.

## Связанные документы

- [docs/deploy/CICD.md](../../deploy/CICD.md) — CI/CD workflow
- [docs/solutions/deployment-issues/server-ip-change-multi-issue-20260125.md](../deployment-issues/server-ip-change-multi-issue-20260125.md) — предыдущие проблемы деплоя
- [.claude/agents/claude-code-expert.md](../../../.claude/agents/claude-code-expert.md) — полная документация по авторизации
- [Missing outputFormat in Agent Mode](./structured-output-undefined-agent-mode-20260124.md) — другая причина нулевых результатов от agent mode
- [Claude SDK Usage Extraction](./claude-sdk-usage-extraction-20250125.md) — usage данные в snake_case и в `result` message
- [**Claude SDK Snake_Case — Системная проблема**](./claude-sdk-snake-case-systemic-20250125.md) — централизованный трансформер для snake_case → camelCase
