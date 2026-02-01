# Docker Deployment

Деплой PKG через Docker Compose и настройка автозапуска.

---

## Деплой приложения

### 1. Клонирование репозитория

```bash
cd ~
git clone https://github.com/your-org/PKG.git
cd PKG
```

### 2. Настройка переменных окружения

```bash
# Скопировать пример
cp docker/.env.example docker/.env

# Отредактировать конфигурацию
nano docker/.env
```

**Обязательные переменные:**

```bash
# DATABASE (получить от администратора)
DB_HOST=your-db-host.example.com
DB_PORT=5432
DB_USERNAME=your-db-username
DB_PASSWORD=your-db-password
DB_DATABASE=pkg
DB_SSL=true

# REDIS
REDIS_PREFIX=pkg:bull

# API & SECRETS
API_KEY=generate-secure-random-key-here
OPENAI_API_KEY=sk-your-openai-api-key

# TELEGRAM (для Telegram Adapter)
TELEGRAM_API_ID=your-api-id
TELEGRAM_API_HASH=your-api-hash
TELEGRAM_SESSION_STRING=your-session-string

# N8N (deprecated in v2.0+ - kept for backwards compatibility)
# n8n 2.0+ uses User Management instead of Basic Auth
# On first run, you'll create owner account via UI at /n8n/
N8N_USER=admin
N8N_PASSWORD=generate-secure-password-here

# CLAUDE CLI (path to credentials after `claude login`)
CLAUDE_CREDENTIALS_PATH=~/.claude

# TELEGRAM MINI APP (optional)
# Bot token for Mini App auth validation
TELEGRAM_BOT_TOKEN=your-bot-token
# Comma-separated list of allowed Telegram user IDs (whitelist)
ALLOWED_TELEGRAM_IDS=123456789,987654321
# DANGEROUS: Set to true ONLY for local development without Telegram auth
MINI_APP_AUTH_BYPASS=false
```

**Генерация безопасных ключей:**

```bash
# API_KEY (32 символа)
openssl rand -hex 32

# N8N_PASSWORD (16 символов)
openssl rand -base64 16
```

### 3. Авторизация Claude CLI (подписка Pro/Max)

PKG Core использует Claude CLI для LLM-задач (fact extraction, summarization).
Для работы по подписке нужно авторизовать CLI на хосте.

#### Вариант A: SSH Port Forwarding (рекомендуется)

```bash
# 1. На ЛОКАЛЬНОЙ машине подключитесь к серверу с port forwarding
ssh -L 8080:localhost:8080 deploy@your-server-ip

# 2. На СЕРВЕРЕ установите Claude CLI и запустите login
npm install -g @anthropic-ai/claude-code
claude login

# CLI покажет URL вида: http://localhost:8080/oauth/callback?code=...

# 3. Откройте этот URL в браузере на ЛОКАЛЬНОЙ машине
#    (он проброшен через SSH туннель)

# 4. Авторизуйтесь через claude.ai с вашей подпиской Pro/Max

# 5. Credentials сохранятся в ~/.claude/ на сервере
```

#### Вариант B: Копирование credentials с локальной машины

```bash
# На локальной машине (Linux)
scp ~/.claude/.credentials.json deploy@server:~/.claude/

# Или создайте файл вручную на сервере
mkdir -p ~/.claude
nano ~/.claude/.credentials.json
# Вставьте содержимое файла с локальной машины
```

> **macOS:** На macOS credentials хранятся в Keychain, не в файле.
> Используйте SSH Port Forwarding или авторизуйтесь напрямую на сервере.

#### Проверка авторизации

```bash
# На сервере
claude whoami
# Должно показать: Email: your@email.com, Subscription: Claude Max

# Проверить, что credentials файл существует
ls -la ~/.claude/.credentials.json
```

#### Лимиты подписки

| План | Лимиты | Сброс |
|------|--------|-------|
| Pro ($20/мес) | Базовые | Каждые 5 часов |
| Max 5x ($100/мес) | 5x Pro | Каждые 5 часов |
| Max 20x ($200/мес) | 20x Pro | Каждые 5 часов |

- Лимиты **общие** для claude.ai и Claude Code CLI
- При превышении лимита — задачи будут ждать до сброса
- Для высокой нагрузки рекомендуется Max 20x

### 4. Сборка образов

```bash
cd /opt/apps/pkg/docker
docker compose build
```

### 5. Сборка Mini App

Mini App — это Vue.js приложение, которое раздаётся как статика через Nginx.

```bash
cd /opt/apps/pkg/apps/mini-app
pnpm build
```

**Важно:** При обновлении кода Mini App всегда пересобирайте его:
```bash
git pull origin <branch>
cd apps/mini-app && pnpm build
```

### 6. Запуск сервисов

```bash
# Запуск всех сервисов
docker compose up -d

# Проверка статуса
docker compose ps

# Просмотр логов
docker compose logs -f
```

### 7. Проверка работоспособности

```bash
# Health check PKG Core
curl http://localhost:3000/api/v1/health

# Health check Telegram Adapter
curl http://localhost:3001/api/v1/health

# Health check Dashboard
curl http://localhost:3003/api/health

# Health check Bull Board
curl http://localhost:3004/health

# Health check n8n
curl http://localhost:5678/healthz
```

### 8. Первоначальная настройка n8n

n8n 2.0+ использует User Management вместо Basic Auth. При первом запуске:

1. Откройте `http://localhost:5678` (или через Nginx после настройки)
2. Создайте owner аккаунт (email + пароль)
3. Этот аккаунт будет администратором n8n

**Важные переменные окружения для n8n:**

| Переменная | Описание | Значение |
|------------|----------|----------|
| `N8N_PATH` | Subpath для reverse proxy | `/n8n/` |
| `N8N_EDITOR_BASE_URL` | Полный URL редактора | `https://pkg.example.com/n8n/` |
| `WEBHOOK_URL` | URL для webhooks | `https://pkg.example.com/webhook/` |

> **Важно:** После изменения `N8N_EDITOR_BASE_URL` или `WEBHOOK_URL` в `.env` нужно перезапустить контейнер:
> ```bash
> docker compose restart n8n
> ```

### 9. Настройка Telegram Mini App

Telegram Mini App используется для управления pending approvals (извлечённые проекты, задачи, обязательства).

**Переменные окружения:**

| Переменная | Описание | Обязательно |
|------------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Token бота для валидации initData | Да |
| `ALLOWED_TELEGRAM_IDS` | Whitelist user IDs (через запятую) | Да |
| `MINI_APP_AUTH_BYPASS` | **⚠️ ОПАСНО:** отключает auth | Нет (default: false) |

**⚠️ КРИТИЧЕСКИ ВАЖНО:**

- `MINI_APP_AUTH_BYPASS=true` полностью **отключает авторизацию** Mini App API!
- Использовать **ТОЛЬКО** для локальной разработки
- В production **ВСЕГДА** `MINI_APP_AUTH_BYPASS=false` или не указывать

**Проверка настройки:**

```bash
# Проверить что auth включён
docker compose logs pkg-core | grep "Mini App"
# Должно быть: "Mini App access whitelist enabled: N user(s)"
# НЕ должно быть: "⚠️ MINI_APP_AUTH_BYPASS=true"
```

**Telegram Adapter переменные для deep-links:**

| Переменная | Описание | Пример |
|------------|----------|--------|
| `MINI_APP_URL` | URL Mini App | `https://tlg-mini-app.example.com` |
| `TELEGRAM_MINI_APP_URL` | Алиас для совместимости | то же самое |

Обе переменные поддерживаются для backward compatibility. Telegram Adapter проверяет сначала `MINI_APP_URL`, затем `TELEGRAM_MINI_APP_URL`.

---

## Автозапуск

### Systemd сервис для Docker Compose

```bash
sudo nano /etc/systemd/system/pkg.service
```

```ini
[Unit]
Description=PKG Docker Compose Application
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/apps/pkg/docker
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
User=deploy
Group=deploy

[Install]
WantedBy=multi-user.target
```

```bash
# Активировать сервис
sudo systemctl daemon-reload
sudo systemctl enable pkg
sudo systemctl start pkg

# Проверить статус
sudo systemctl status pkg
```
