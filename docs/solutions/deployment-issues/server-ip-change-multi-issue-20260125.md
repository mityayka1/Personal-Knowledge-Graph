---
module: PKG Deployment Infrastructure
date: 2026-01-25
problem_type: multi_component_deployment_issue
severity: high
status: resolved

components:
  - telegram-adapter
  - nginx
  - dashboard
  - database

symptoms:
  - "Telegram AUTH_KEY_DUPLICATED error on container startup"
  - "Dashboard login returns 404 on /api/auth/login"
  - "Nginx intercepting Dashboard's own /api/auth/* routes"
  - "Admin user login fails after deployment"

root_cause:
  - "Telegram session bound to previous IP (150.241.230.206)"
  - "Nginx location /api/ wildcard intercepting Dashboard routes"
  - "bcrypt unavailable in production container for user management"

resolution_time_minutes: 45

tags:
  - deployment
  - telegram
  - nginx
  - routing
  - authentication
  - docker
  - production

references:
  - docs/deploy/TROUBLESHOOTING.md
  - docs/deploy/NGINX_SSL.md
  - docs/deploy/DOCKER_DEPLOY.md
  - docs/SERVER_SETUP_LOG.md
---

# Server IP Change: Multi-Component Deployment Issues

**Дата:** 2026-01-25
**Сервер:** 82.22.23.59 (assistant.mityayka.ru)
**Предыдущий IP:** 150.241.230.206 (Cloudflare proxy)

## Обзор проблемы

При переходе с Cloudflare proxy на прямую A-запись произошла смена IP сервера. Это вызвало каскад из трёх связанных проблем:

1. **Telegram AUTH_KEY_DUPLICATED** — сессия привязана к старому IP
2. **Nginx 404 на /api/auth/login** — неправильная маршрутизация запросов
3. **Невозможность создать пользователя** — bcrypt недоступен в контейнере

## Проблема 1: Telegram AUTH_KEY_DUPLICATED

### Симптомы

```
Container pkg-telegram-adapter keeps restarting
Logs: "AUTH_KEY_DUPLICATED" error
Health check fails
```

### Причина

MTProto протокол Telegram привязывает authentication key к IP адресу, с которого была создана сессия. При смене IP (150.241.230.206 → 82.22.23.59) старый `TELEGRAM_SESSION_STRING` становится невалидным.

### Решение

**Шаг 1:** Остановить telegram-adapter (освободить сессию)
```bash
cd /opt/apps/pkg/docker
docker compose stop telegram-adapter
```

**Шаг 2:** Запустить скрипт авторизации на новом сервере
```bash
# На сервере через SSH
cd /opt/apps/pkg/apps/telegram-adapter
npx ts-node scripts/auth.ts
```

**Шаг 3:** Ввести телефон, код, 2FA пароль

**Шаг 4:** Скопировать новый session string в `.env`
```bash
# /opt/apps/pkg/docker/.env
TELEGRAM_SESSION_STRING=1AgAOMTQ5LjE1NC4xNjcuNTA...
```

**Шаг 5:** Перезапустить контейнер
```bash
docker compose up -d telegram-adapter
docker logs -f pkg-telegram-adapter  # Проверить "Connected to Telegram"
```

### Превентивные меры

- Документировать IP сервера при деплое
- Использовать статический IP
- Иметь готовый скрипт для удалённой авторизации
- Добавить проверку IP в мониторинг

---

## Проблема 2: Nginx перехватывает Dashboard routes

### Симптомы

```
Dashboard login form submits to /api/auth/login
Browser receives 404 Not Found
Network tab shows request went to pkg-core (wrong!)
```

### Причина

Nginx конфигурация имела:
```nginx
location /api/ {
    proxy_pass http://pkg-core:3000/api/;
}
```

Это перехватывало ВСЕ `/api/*` запросы, включая `/api/auth/*` которые принадлежат Dashboard (Nuxt server routes), а не pkg-core.

**Архитектура:**
```
Dashboard (Nuxt) → /api/auth/login   → Dashboard backend → pkg-core /api/v1/auth/login
                   /api/auth/me
                   /api/auth/logout

PKG Core         → /api/v1/*         → Прямые API вызовы
```

### Решение

Изменить Nginx конфигурацию в `/etc/nginx/sites-available/pkg`:

**До (неправильно):**
```nginx
location /api/ {
    proxy_pass http://pkg-core:3000/api/;
}
```

**После (правильно):**
```nginx
# Только /api/v1/* идёт в pkg-core
location /api/v1/ {
    proxy_pass http://pkg-core:3000/api/v1/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

# Dashboard обрабатывает свои /api/* routes сам
# (остаются в location / который проксирует на Dashboard)
```

**Применить:**
```bash
sudo nginx -t
sudo systemctl reload nginx
```

### Превентивные меры

- Использовать версионированные API пути (`/api/v1/`)
- Документировать все endpoint paths каждого сервиса
- Тестировать каждый location block при изменениях
- Nuxt server routes не должны конфликтовать с upstream proxy

---

## Проблема 3: Создание пользователя без bcrypt

### Симптомы

```bash
# Попытка запустить seed script
docker exec pkg-core node dist/database/seeds/admin-user.seed.js
# Error: Cannot find module 'bcrypt'
```

### Причина

Production Docker образ оптимизирован и не содержит bcrypt native module в доступном пути `node_modules`.

### Решение

**Вариант A: Генерация хеша локально + SQL**

```bash
# На локальной машине с bcrypt
cd /path/to/pkg/apps/pkg-core
node -e "const bcrypt = require('bcrypt'); bcrypt.hash('YourPassword', 12).then(h => console.log(h));"
# Вывод: $2b$12$...
```

```sql
-- Через MCP db tool или psql
UPDATE users
SET password_hash = '$2b$12$...',
    updated_at = NOW()
WHERE username = 'admin';
```

**Вариант B: MCP db tool (если настроен)**

```
Использовать mcp__db__execute_sql для прямого SQL доступа
```

### Превентивные меры

- Создать скрипт `scripts/create-user.sh` для управления пользователями с хоста
- Добавить bcrypt в production dependencies (если нужны seed scripts)
- Документировать процедуру создания admin user в деплой чеклисте

---

## Чеклист при смене IP сервера

- [ ] Остановить telegram-adapter перед изменением DNS
- [ ] Обновить DNS A-запись
- [ ] Проверить DNS propagation (`dig assistant.mityayka.ru`)
- [ ] Переавторизовать Telegram сессию на новом IP
- [ ] Обновить `TELEGRAM_SESSION_STRING` в `.env`
- [ ] Проверить Nginx routing для всех сервисов
- [ ] Проверить SSL сертификаты (Certbot привязан к домену, не IP)
- [ ] Обновить `docs/SERVER_SETUP_LOG.md` с новым IP

---

## Ссылки

- [TROUBLESHOOTING.md](../deploy/TROUBLESHOOTING.md) — общие проблемы деплоя
- [NGINX_SSL.md](../deploy/NGINX_SSL.md) — конфигурация Nginx
- [SERVER_SETUP_LOG.md](../SERVER_SETUP_LOG.md) — текущие credentials и статус
- [Claude OAuth Token Expired](../integration-issues/claude-oauth-token-expired-ClaudeAgent-20260125.md) — OAuth токен истекает после смены сервера
- [Source-Agnostic Architecture Prevention](../integration-issues/source-agnostic-architecture-prevention.md) — архитектурный паттерн Dashboard → PKG Core → Adapter
