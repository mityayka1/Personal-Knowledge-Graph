# Deployment Guide

Руководство по деплою PKG на удалённый сервер.

## Содержание

- [Конвенции](#конвенции)
- [Требования](#требования)
- [Архитектура деплоя](#архитектура-деплоя)
- [Подготовка сервера](#подготовка-сервера)
- [Установка Docker](#установка-docker)
- [Деплой приложения](#деплой-приложения)
- [CI/CD (GitHub Actions)](#cicd-github-actions)
- [Настройка Nginx (reverse proxy)](#настройка-nginx-reverse-proxy)
- [SSL сертификаты](#ssl-сертификаты)
- [Автозапуск](#автозапуск)
- [Мониторинг и логи](#мониторинг-и-логи)
- [Обновление приложения](#обновление-приложения)
- [Бэкапы](#бэкапы)
- [Troubleshooting](#troubleshooting)

---

## Конвенции

### Структура директорий на сервере

**Важно:** Все проекты на серверах размещаются в директории `/opt/apps/`:

```
/opt/apps/
├── pkg/                    # PKG (Personal Knowledge Graph)
│   ├── apps/               # Исходный код приложений
│   ├── docker/             # Docker Compose и конфигурация
│   ├── docs/               # Документация
│   └── ...
├── other-project/          # Другие проекты
└── ...
```

**Путь к PKG:** `/opt/apps/pkg`

Эта конвенция:
- Обеспечивает единообразие размещения проектов на всех серверах
- Упрощает автоматизацию деплоя и скриптов
- Отделяет приложения от системных директорий

### Именование

| Элемент | Конвенция | Пример |
|---------|-----------|--------|
| Директория проекта | lowercase | `/opt/apps/pkg` |
| Docker containers | `pkg-{service}` | `pkg-core`, `pkg-dashboard` |
| Docker volumes | `docker_{volume}` | `docker_redis-data` |
| Systemd services | `{project}.service` | `pkg.service` |

---

## Требования

### Минимальные требования к серверу

| Ресурс | Минимум | Рекомендуется |
|--------|---------|---------------|
| CPU | 2 vCPU | 4 vCPU |
| RAM | 4 GB | 8 GB |
| Disk | 40 GB SSD | 100 GB SSD |
| OS | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |

### Сетевые требования

| Порт | Сервис | Внешний доступ | Примечание |
|------|--------|----------------|------------|
| 22 | SSH | Да (ограничить по IP) | Использовать ключи, отключить password auth |
| 80 | HTTP (Nginx) | Да | Редирект на HTTPS |
| 443 | HTTPS (Nginx) | Да | Основной endpoint |
| 3000 | PKG Core | Нет (через Nginx) | API backend |
| 3001 | Telegram Adapter | Нет | Внутренний сервис |
| 3002 | Bull Board | Нет (через Nginx) | Мониторинг очередей |
| 3003 | Dashboard | Нет (через Nginx) | Web UI |
| 5678 | n8n | Нет (через Nginx) | **WebSocket required** |
| 6379 | Redis | Нет (Docker internal) | Не проброшен на хост |

> **Важно:**
> - Redis не имеет проброса портов на хост — доступен только внутри Docker network
> - PostgreSQL — удалённая база данных, не разворачивается локально
> - n8n требует WebSocket поддержку в Nginx для корректной работы UI

### Внешние зависимости

- **PostgreSQL** — удалённая база данных (credentials от администратора)
- **OpenAI API** — для генерации embeddings
- **Telegram API** — для Telegram Adapter (API ID, Hash, Session)

### Авторизация

| Компонент | Тип авторизации | Настройка |
|-----------|-----------------|-----------|
| PKG Core API | API Key (`X-API-Key` header) | `API_KEY` в .env |
| Dashboard | Basic Auth (Nginx) | `.htpasswd` файл |
| Bull Board | Basic Auth (Nginx) | `.htpasswd` файл |
| n8n | User Management (встроенная) | Первый запуск — регистрация owner |
| Redis | Нет (изолирован в Docker) | — |

> **n8n 2.0+:** Basic Auth (`N8N_BASIC_AUTH_*`) deprecated. n8n использует User Management — при первом запуске создаётся owner аккаунт через UI.

---

## Архитектура деплоя

```
                    Internet
                        │
                        ▼
                ┌───────────────┐
                │    Nginx      │
                │  (SSL, proxy) │
                └───────┬───────┘
                        │
        ┌───────────────┼───────────────┬───────────────┐
        │               │               │               │
        ▼               ▼               ▼               ▼
┌───────────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐
│   Dashboard   │ │ PKG Core  │ │ Bull Board│ │    n8n    │
│    :3003      │ │   :3000   │ │   :3002   │ │   :5678   │
└───────────────┘ └─────┬─────┘ └─────┬─────┘ └───────────┘
                        │             │
                        └──────┬──────┘
                               │
                        ┌──────▼──────┐
                        │    Redis    │
                        │    :6379    │
                        └─────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
        ▼                      ▼                      ▼
┌───────────────┐     ┌───────────────┐     ┌───────────────┐
│   Telegram    │     │  PostgreSQL   │     │ File Storage  │
│   Adapter     │     │   (remote)    │     │   (volume)    │
│    :3001      │     └───────────────┘     └───────────────┘
└───────────────┘
```

---

## Подготовка сервера

### 1. Подключение к серверу

```bash
ssh root@your-server-ip
```

### 2. Обновление системы

```bash
apt update && apt upgrade -y
```

### 3. Создание пользователя для деплоя

```bash
# Создать пользователя
adduser deploy
usermod -aG sudo deploy

# Настроить SSH ключи
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys

# Переключиться на нового пользователя
su - deploy
```

### 4. Настройка Firewall (UFW)

```bash
# Включить UFW
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Разрешить SSH (важно сделать до включения!)
sudo ufw allow ssh

# Разрешить HTTP и HTTPS
sudo ufw allow http
sudo ufw allow https

# Включить firewall
sudo ufw enable

# Проверить статус
sudo ufw status
```

### 5. Настройка Fail2ban (защита от brute-force)

```bash
sudo apt install fail2ban -y
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
```

---

## Установка Docker

### 1. Установка Docker Engine

```bash
# Удалить старые версии
sudo apt remove docker docker-engine docker.io containerd runc 2>/dev/null

# Установить зависимости
sudo apt install -y ca-certificates curl gnupg

# Добавить GPG ключ Docker
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Добавить репозиторий
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Установить Docker
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Добавить пользователя в группу docker
sudo usermod -aG docker deploy

# Перелогиниться для применения групп
exit
ssh deploy@your-server-ip
```

### 2. Проверка установки

```bash
docker --version
docker compose version
docker run hello-world
```

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

#### Важно: Лимиты подписки

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

### 5. Запуск сервисов

```bash
# Запуск всех сервисов
docker compose up -d

# Проверка статуса
docker compose ps

# Просмотр логов
docker compose logs -f
```

### 6. Проверка работоспособности

```bash
# Health check PKG Core
curl http://localhost:3000/api/v1/health

# Health check Telegram Adapter
curl http://localhost:3001/api/v1/health

# Health check Dashboard
curl http://localhost:3003/api/health

# Health check Bull Board
curl http://localhost:3002/health

# Health check n8n
curl http://localhost:5678/healthz
```

### 7. Первоначальная настройка n8n

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

---

## CI/CD (GitHub Actions)

Автоматический деплой при push в `master` ветку.

### Как это работает

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ git push    │────►│  GitHub     │────►│   Server    │
│ to master   │     │  Actions    │     │ (via SSH)   │
└─────────────┘     └─────────────┘     └─────────────┘
                          │
                    ┌─────▼─────┐
                    │ 1. git pull│
                    │ 2. build   │
                    │ 3. restart │
                    └───────────┘
```

### Настроенные секреты

В GitHub Repository → Settings → Secrets and variables → Actions:

| Secret | Описание |
|--------|----------|
| `SSH_PRIVATE_KEY` | Приватный ключ для SSH доступа к серверу |
| `SERVER_HOST` | IP адрес или hostname сервера |
| `SERVER_USER` | Пользователь SSH (обычно `root`) |

### Workflow файл

Расположение: `.github/workflows/deploy.yml`

```yaml
name: Deploy to Production

on:
  push:
    branches:
      - master
  workflow_dispatch:  # Позволяет запускать вручную

jobs:
  deploy:
    name: Deploy to Server
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1.2.0
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            cd /opt/apps/pkg
            git fetch origin master
            git reset --hard origin/master
            cd docker
            docker compose pull
            docker compose up -d --build
            docker image prune -f
            echo "Deployment completed at $(date)"
```

### Ручной запуск деплоя

1. Перейти в GitHub → Actions → Deploy to Production
2. Нажать "Run workflow"
3. Выбрать ветку (обычно `master`)
4. Нажать "Run workflow"

### Мониторинг деплоя

- **GitHub Actions:** вкладка Actions в репозитории
- **Логи на сервере:** `docker compose logs -f` в `/opt/apps/pkg/docker`

### Откат

При проблемах после деплоя:

```bash
# На сервере
cd /opt/apps/pkg
git log --oneline -5            # Найти предыдущий коммит
git reset --hard <commit-hash>  # Откатить
cd docker
docker compose up -d --build    # Пересобрать
```

---

## Настройка Nginx (reverse proxy)

### 1. Установка Nginx

```bash
sudo apt install nginx -y
sudo systemctl enable nginx
```

### 2. Создание Basic Auth (для Dashboard и Bull Board)

```bash
# Установить apache2-utils для htpasswd
sudo apt install apache2-utils -y

# Создать файл с пользователем (будет запрошен пароль)
sudo htpasswd -c /etc/nginx/.htpasswd admin

# Добавить дополнительных пользователей (без -c)
# sudo htpasswd /etc/nginx/.htpasswd another_user

# Проверить файл
cat /etc/nginx/.htpasswd
```

### 3. Конфигурация сайта

```bash
sudo nano /etc/nginx/sites-available/pkg
```

```nginx
# PKG Core API
upstream pkg_core {
    server 127.0.0.1:3000;
    keepalive 32;
}

# Dashboard
upstream pkg_dashboard {
    server 127.0.0.1:3003;
    keepalive 16;
}

# Bull Board
upstream pkg_bull_board {
    server 127.0.0.1:3002;
}

# n8n
upstream pkg_n8n {
    server 127.0.0.1:5678;
    keepalive 16;
}

# WebSocket connection upgrade map
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

# HTTP -> HTTPS redirect
server {
    listen 80;
    server_name pkg.example.com;
    return 301 https://$server_name$request_uri;
}

# Main HTTPS server
server {
    listen 443 ssl http2;
    server_name pkg.example.com;

    # SSL configuration (managed by Certbot)
    ssl_certificate /etc/letsencrypt/live/pkg.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pkg.example.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # API
    location /api/ {
        proxy_pass http://pkg_core;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";

        # Timeouts for long-running requests (LLM, summarization)
        proxy_connect_timeout 60s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;

        # Buffering
        proxy_buffering on;
        proxy_buffer_size 4k;
        proxy_buffers 8 4k;
    }

    # Dashboard (protected with Basic Auth)
    location / {
        auth_basic "PKG Dashboard";
        auth_basic_user_file /etc/nginx/.htpasswd;

        proxy_pass http://pkg_dashboard;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support (for HMR in dev, live updates)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 86400s;
    }

    # Bull Board (protected with Basic Auth)
    location /bull-board/ {
        auth_basic "Bull Board";
        auth_basic_user_file /etc/nginx/.htpasswd;

        # Trailing slash in proxy_pass strips /bull-board/ prefix
        proxy_pass http://pkg_bull_board/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # n8n (has built-in User Management auth)
    # IMPORTANT: n8n requires WebSocket for UI to work properly
    location /n8n/ {
        proxy_pass http://pkg_n8n/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support (CRITICAL for n8n)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # Long timeout for WebSocket connections
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;

        # Disable buffering for WebSocket
        proxy_buffering off;
    }

    # n8n webhooks (direct access without /n8n/ prefix)
    location /webhook/ {
        proxy_pass http://pkg_n8n/webhook/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Longer timeout for webhook processing
        proxy_read_timeout 300s;
    }
}
```

### 4. Активация конфигурации

```bash
# Создать симлинк
sudo ln -s /etc/nginx/sites-available/pkg /etc/nginx/sites-enabled/

# Удалить default сайт (опционально)
sudo rm /etc/nginx/sites-enabled/default

# Проверить конфигурацию
sudo nginx -t

# Перезапустить Nginx
sudo systemctl reload nginx
```

---

## SSL сертификаты

### Вариант 1: Получение сертификата ДО настройки Nginx

Если Nginx ещё не настроен, используйте standalone режим:

```bash
# Установка Certbot
sudo apt install certbot python3-certbot-nginx -y

# Остановить Nginx (если запущен)
sudo systemctl stop nginx

# Получить сертификат в standalone режиме
sudo certbot certonly --standalone -d pkg.example.com

# Запустить Nginx
sudo systemctl start nginx
```

### Вариант 2: Получение сертификата с существующим Nginx

```bash
# Установка Certbot
sudo apt install certbot python3-certbot-nginx -y

# Временно создать простую конфигурацию для проверки домена
sudo tee /etc/nginx/sites-available/pkg-temp << 'EOF'
server {
    listen 80;
    server_name pkg.example.com;
    root /var/www/html;
}
EOF

sudo ln -sf /etc/nginx/sites-available/pkg-temp /etc/nginx/sites-enabled/pkg
sudo nginx -t && sudo systemctl reload nginx

# Получение сертификата
sudo certbot --nginx -d pkg.example.com

# После получения сертификата — заменить на полную конфигурацию
# (см. раздел "Настройка Nginx" выше)
```

### Проверка автообновления

```bash
# Статус таймера
sudo systemctl status certbot.timer

# Тестовый прогон обновления
sudo certbot renew --dry-run
```

### После получения SSL

Убедитесь, что конфигурация Nginx содержит:

1. **HTTP -> HTTPS редирект** (порт 80)
2. **SSL сертификаты** в HTTPS блоке (порт 443)
3. **Правильные пути** к fullchain.pem и privkey.pem

```bash
# Проверить конфигурацию
sudo nginx -t

# Применить изменения
sudo systemctl reload nginx

# Проверить HTTPS
curl -I https://pkg.example.com/api/v1/health
```

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

---

## Мониторинг и логи

### Просмотр логов

```bash
cd /opt/apps/pkg/docker

# Все сервисы
docker compose logs -f

# Конкретный сервис
docker compose logs -f pkg-core
docker compose logs -f telegram-adapter

# Последние N строк
docker compose logs --tail=100 pkg-core
```

### Health endpoints

| Сервис | Endpoint | Ожидаемый ответ |
|--------|----------|-----------------|
| PKG Core | `/api/v1/health` | `{ "status": "ok" }` |
| Telegram Adapter | `/api/v1/health` | `{ "status": "ok" }` |
| Dashboard | `/api/health` | `{ "status": "ok" }` |
| Bull Board | `/health` | 200 OK |
| n8n | `/healthz` | 200 OK |

### Мониторинг ресурсов

```bash
# Docker stats
docker stats

# Disk usage
docker system df
df -h

# Memory
free -h
```

### Bull Board

Мониторинг очередей BullMQ доступен по адресу:
- URL: `http://pkg.example.com/bull-board/`
- Показывает: очереди, jobs, статусы, ошибки

---

## Обновление приложения

### Стандартное обновление

```bash
cd /opt/apps/pkg

# Получить изменения
git pull origin main

# Пересобрать и перезапустить
cd docker
docker compose build
docker compose up -d

# Проверить логи
docker compose logs -f --tail=100
```

### Обновление с миграциями БД

```bash
cd /opt/apps/pkg

# Получить изменения
git pull origin main

# Остановить сервисы
cd docker
docker compose down

# Применить миграции (выполняется на хосте или через docker)
docker compose run --rm pkg-core npm run migration:run

# Пересобрать и запустить
docker compose build
docker compose up -d
```

### Откат

```bash
cd /opt/apps/pkg

# Откатить код
git checkout <previous-commit>

# Откатить миграцию (если нужно)
docker compose run --rm pkg-core npm run migration:revert

# Пересобрать
cd docker
docker compose build
docker compose up -d
```

---

## Бэкапы

### Redis (локальные данные очередей)

```bash
# Создать бэкап
docker compose exec redis redis-cli BGSAVE
docker cp pkg-redis:/data/dump.rdb ~/backups/redis-$(date +%Y%m%d).rdb

# Восстановить
docker compose stop redis
docker cp ~/backups/redis-YYYYMMDD.rdb pkg-redis:/data/dump.rdb
docker compose start redis
```

### File Storage (volume)

```bash
# Создать бэкап
docker run --rm -v pkg_file-storage:/data -v ~/backups:/backup \
  alpine tar czf /backup/files-$(date +%Y%m%d).tar.gz -C /data .

# Восстановить
docker run --rm -v pkg_file-storage:/data -v ~/backups:/backup \
  alpine tar xzf /backup/files-YYYYMMDD.tar.gz -C /data
```

### n8n workflows

```bash
# Создать бэкап
docker run --rm -v pkg_n8n-data:/data -v ~/backups:/backup \
  alpine tar czf /backup/n8n-$(date +%Y%m%d).tar.gz -C /data .
```

### Автоматические бэкапы (cron)

```bash
crontab -e
```

```cron
# Ежедневно в 3:00
0 3 * * * /opt/apps/pkg/scripts/backup.sh >> /home/deploy/logs/backup.log 2>&1
```

---

## Troubleshooting

### Контейнер не запускается

```bash
# Проверить логи
docker compose logs pkg-core

# Проверить конфигурацию
docker compose config

# Проверить переменные окружения
docker compose exec pkg-core env | grep DB_
```

### Проблемы с подключением к БД

```bash
# Проверить доступность БД с сервера
nc -zv your-db-host.example.com 5432

# Проверить SSL
openssl s_client -connect your-db-host.example.com:5432 -starttls postgres
```

### Redis не доступен

```bash
# Проверить статус контейнера
docker compose ps redis

# Проверить подключение
docker compose exec redis redis-cli ping
```

### Очереди не обрабатываются

```bash
# Проверить Bull Board
curl http://localhost:3002/health

# Проверить очереди через CLI
docker compose exec redis redis-cli KEYS "pkg:bull:*"
```

### Telegram Adapter не подключается

```bash
# Проверить логи
docker compose logs telegram-adapter

# Частые причины:
# - Неверный SESSION_STRING
# - Истекшая сессия (нужно перегенерировать)
# - Блокировка IP Telegram'ом
```

### Nginx 502 Bad Gateway

```bash
# Проверить, запущены ли контейнеры
docker compose ps

# Проверить доступность изнутри
curl http://localhost:3000/api/v1/health

# Проверить логи Nginx
sudo tail -f /var/log/nginx/error.log
```

### n8n UI не работает / WebSocket ошибки

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

### n8n webhooks не работают

```bash
# Проверить, что location /webhook/ настроен в Nginx
grep -A5 "location /webhook/" /etc/nginx/sites-available/pkg

# Тест webhook
curl -X POST https://pkg.example.com/webhook/test

# Проверить логи n8n
docker compose logs n8n | grep webhook
```

### Claude CLI не работает в контейнере

```bash
# Проверить, что credentials смонтированы
docker compose exec pkg-core ls -la /home/nestjs/.claude/

# Проверить путь в .env
grep CLAUDE_CREDENTIALS_PATH docker/.env

# Тест из контейнера
docker compose exec pkg-core claude whoami
```

### Очистка диска

```bash
# Удалить неиспользуемые образы
docker image prune -a

# Удалить все неиспользуемые ресурсы
docker system prune -a

# Очистить логи контейнеров
sudo truncate -s 0 /var/lib/docker/containers/*/*-json.log
```

---

## Полезные команды

```bash
# Перезапустить конкретный сервис
docker compose restart pkg-core

# Пересобрать и перезапустить один сервис
docker compose up -d --build pkg-core

# Зайти в контейнер
docker compose exec pkg-core sh

# Посмотреть переменные окружения
docker compose exec pkg-core env

# Проверить сеть между контейнерами
docker compose exec pkg-core ping redis

# Посмотреть volumes
docker volume ls | grep pkg

# Экспортировать логи в файл
docker compose logs --no-color > logs-$(date +%Y%m%d).txt
```

---

## Чеклист деплоя

### Подготовка сервера
- [ ] Сервер обновлён (`apt update && apt upgrade`)
- [ ] Создан пользователь `deploy` с sudo
- [ ] SSH ключи настроены, password auth отключён
- [ ] Firewall (UFW) настроен: 22, 80, 443
- [ ] Fail2ban установлен и запущен

### Docker
- [ ] Docker и Docker Compose установлены
- [ ] Пользователь `deploy` добавлен в группу `docker`
- [ ] Репозиторий склонирован в `/opt/apps/pkg`

### Конфигурация
- [ ] `.env` файл создан из `.env.example`
- [ ] Database credentials заполнены и проверены
- [ ] `API_KEY` сгенерирован (`openssl rand -hex 32`)
- [ ] `OPENAI_API_KEY` добавлен
- [ ] Telegram credentials заполнены (если используется)

### Claude CLI (для LLM задач)
- [ ] Claude CLI установлен (`npm install -g @anthropic-ai/claude-code`)
- [ ] Авторизация выполнена (`claude login` через SSH port forwarding)
- [ ] Проверка: `claude whoami` показывает подписку
- [ ] Credentials смонтированы в docker-compose (`CLAUDE_CREDENTIALS_PATH`)

### Запуск
- [ ] Образы собраны (`docker compose build`)
- [ ] Сервисы запущены (`docker compose up -d`)
- [ ] Все контейнеры в статусе `healthy` (`docker compose ps`)

### Health checks
- [ ] PKG Core: `curl http://localhost:3000/api/v1/health`
- [ ] Telegram Adapter: `curl http://localhost:3001/api/v1/health`
- [ ] Dashboard: `curl http://localhost:3003/api/health`
- [ ] Bull Board: `curl http://localhost:3002/health`
- [ ] n8n: `curl http://localhost:5678/healthz`

### Nginx
- [ ] Nginx установлен и запущен
- [ ] `.htpasswd` создан для Basic Auth
- [ ] Конфигурация `/etc/nginx/sites-available/pkg` создана
- [ ] Симлинк в `sites-enabled` создан
- [ ] `nginx -t` проходит без ошибок
- [ ] WebSocket для n8n работает (UI открывается без ошибок)

### SSL
- [ ] Certbot установлен
- [ ] Сертификат получен для домена
- [ ] HTTP -> HTTPS редирект работает
- [ ] `certbot renew --dry-run` успешен

### Автозапуск и мониторинг
- [ ] Systemd service `pkg.service` создан и enabled
- [ ] Cron job для бэкапов настроен
- [ ] Bull Board доступен через `/bull-board/`
- [ ] n8n доступен через `/n8n/`

### n8n (первый запуск)
- [ ] Открыть `https://pkg.example.com/n8n/`
- [ ] Создать owner аккаунт через UI
- [ ] Импортировать/создать workflows
