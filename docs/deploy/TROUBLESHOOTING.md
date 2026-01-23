# Troubleshooting

Решение типичных проблем при деплое и эксплуатации PKG.

---

## Контейнер не запускается

```bash
# Проверить логи
docker compose logs pkg-core

# Проверить конфигурацию
docker compose config

# Проверить переменные окружения
docker compose exec pkg-core env | grep DB_
```

---

## Проблемы с подключением к БД

```bash
# Проверить доступность БД с сервера
nc -zv your-db-host.example.com 5432

# Проверить SSL
openssl s_client -connect your-db-host.example.com:5432 -starttls postgres
```

---

## Redis не доступен

```bash
# Проверить статус контейнера
docker compose ps redis

# Проверить подключение
docker compose exec redis redis-cli ping
```

---

## Очереди не обрабатываются

```bash
# Проверить Bull Board
curl http://localhost:3004/health

# Проверить очереди через CLI
docker compose exec redis redis-cli KEYS "pkg:bull:*"
```

---

## Telegram Adapter не подключается

```bash
# Проверить логи
docker compose logs telegram-adapter

# Частые причины:
# - Неверный SESSION_STRING
# - Истекшая сессия (нужно перегенерировать)
# - Блокировка IP Telegram'ом
```

---

## Защита Telegram сессии от коллизий

**⚠️ ВАЖНО:** Одновременный запуск одной Telegram сессии с разных машин может привести к бану аккаунта!

### Локальная разработка

При запуске `pnpm start:dev` в telegram-adapter срабатывает защита:

```
╔═══════════════════════════════════════════════════════════════════════════╗
║  ⚠️  TELEGRAM SESSION PROTECTION                                          ║
╠═══════════════════════════════════════════════════════════════════════════╣
║  Local development is BLOCKED to prevent session collision with PROD.     ║
╚═══════════════════════════════════════════════════════════════════════════╝
```

**Для локальной разработки** (с ОТДЕЛЬНОЙ сессией от production):

```bash
# 1. Убедитесь, что production сервис остановлен ИЛИ используется другая сессия
# 2. Запустите с флагом разрешения:
ALLOW_LOCAL_TELEGRAM=true pnpm start:dev
```

### Удалённая авторизация через SSH

Для авторизации Telegram на удалённом сервере без GUI:

```bash
# Использование
./scripts/remote-telegram-auth.sh deploy@your-server.com

# Или с кастомным путём к PKG
PKG_REMOTE_PATH=/custom/path ./scripts/remote-telegram-auth.sh user@server
```

Скрипт выполняет:
1. Останавливает telegram-adapter (освобождает сессию)
2. Запускает интерактивную авторизацию (телефон, код, 2FA)
3. Обновляет `TELEGRAM_SESSION_STRING` в .env
4. Перезапускает telegram-adapter
5. Проверяет успешность подключения

---

## Nginx 502 Bad Gateway

```bash
# Проверить, запущены ли контейнеры
docker compose ps

# Проверить доступность изнутри
curl http://localhost:3000/api/v1/health

# Проверить логи Nginx
sudo tail -f /var/log/nginx/error.log
```

---

## n8n UI не работает / WebSocket ошибки

**Симптомы:**
- UI открывается, но не реагирует на действия
- В консоли браузера ошибки WebSocket
- Workflow editor не работает

**Причины и решения:**

1. **Отсутствует WebSocket поддержка в Nginx**
   ```bash
   # Проверить, что в конфигурации есть:
   grep -A5 "location /n8n/" /etc/nginx/sites-available/pkg

   # Должно быть:
   # proxy_set_header Upgrade $http_upgrade;
   # proxy_set_header Connection $connection_upgrade;
   # proxy_read_timeout 86400s;
   ```

2. **Не настроен N8N_PATH**
   ```bash
   # Проверить переменные n8n
   docker compose exec n8n printenv | grep N8N_

   # Должно быть:
   # N8N_PATH=/n8n/
   # N8N_EDITOR_BASE_URL=https://your-domain.com/n8n/
   ```

3. **Неправильный WEBHOOK_URL**
   ```bash
   # Webhooks должны использовать внешний URL
   docker compose exec n8n printenv | grep WEBHOOK_URL
   # Ожидается: https://your-domain.com/webhook/
   ```

4. **Буферизация мешает WebSocket**
   ```nginx
   # В location /n8n/ должно быть:
   proxy_buffering off;
   ```

**Тест WebSocket:**
```bash
# Установить wscat
npm install -g wscat

# Проверить WebSocket соединение
wscat -c wss://pkg.example.com/n8n/
```

---

## n8n webhooks не работают

```bash
# Проверить, что location /webhook/ настроен в Nginx
grep -A5 "location /webhook/" /etc/nginx/sites-available/pkg

# Тест webhook
curl -X POST https://pkg.example.com/webhook/test

# Проверить логи n8n
docker compose logs n8n | grep webhook
```

---

## Claude CLI не работает в контейнере

```bash
# Проверить, что credentials смонтированы
docker compose exec pkg-core ls -la /home/nestjs/.claude/

# Проверить путь в .env
grep CLAUDE_CREDENTIALS_PATH docker/.env

# Тест из контейнера
docker compose exec pkg-core claude whoami
```
