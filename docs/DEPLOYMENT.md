# Deployment Guide

Руководство по деплою PKG на удалённый сервер.

---

## Документация

| Документ | Описание |
|----------|----------|
| [Server Setup](deploy/SERVER_SETUP.md) | Подготовка сервера, установка Docker |
| [Docker Deployment](deploy/DOCKER_DEPLOY.md) | Деплой через Docker Compose, автозапуск |
| [CI/CD](deploy/CICD.md) | GitHub Actions workflow |
| [Nginx & SSL](deploy/NGINX_SSL.md) | Reverse proxy, SSL сертификаты |
| [Operations](deploy/OPERATIONS.md) | Мониторинг, логи, обновления, бэкапы |
| [Troubleshooting](deploy/TROUBLESHOOTING.md) | Решение типичных проблем |
| [Checklist](deploy/CHECKLIST.md) | Чеклист деплоя |

---

## Конвенции

### Структура директорий на сервере

Все проекты размещаются в `/opt/apps/`:

```
/opt/apps/
├── pkg/                    # PKG (Personal Knowledge Graph)
│   ├── apps/               # Исходный код приложений
│   ├── docker/             # Docker Compose и конфигурация
│   └── docs/               # Документация
└── other-project/          # Другие проекты
```

**Путь к PKG:** `/opt/apps/pkg`

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
| 22 | SSH | Да (ограничить по IP) | Использовать ключи |
| 80 | HTTP (Nginx) | Да | Редирект на HTTPS |
| 443 | HTTPS (Nginx) | Да | Основной endpoint |
| 3000 | PKG Core | Нет (через Nginx) | API backend |
| 3001 | Telegram Adapter | Нет | Внутренний сервис |
| 3003 | Dashboard | Нет (через Nginx) | Web UI |
| 3004 | Bull Board | Нет (через Nginx) | Мониторинг очередей |
| 5678 | n8n | Нет (через Nginx) | **WebSocket required** |
| 6379 | Redis | Нет | Docker internal |

### Внешние зависимости

- **PostgreSQL** — удалённая база данных
- **OpenAI API** — для генерации embeddings
- **Telegram API** — для Telegram Adapter

### Авторизация

| Компонент | Тип авторизации | Настройка |
|-----------|-----------------|-----------|
| PKG Core API | API Key (`X-API-Key`) | `API_KEY` в .env |
| Dashboard | Basic Auth (Nginx) | `.htpasswd` файл |
| Bull Board | Basic Auth (Nginx) | `.htpasswd` файл |
| n8n | User Management | Первый запуск — регистрация |
| Redis | Нет | Изолирован в Docker |

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
│    :3003      │ │   :3000   │ │   :3004   │ │   :5678   │
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

## Быстрый старт

1. **Подготовка сервера** → [Server Setup](deploy/SERVER_SETUP.md)
2. **Настройка .env** → [Docker Deployment](deploy/DOCKER_DEPLOY.md)
3. **docker compose up -d** → [Docker Deployment](deploy/DOCKER_DEPLOY.md)
4. **Настройка Nginx + SSL** → [Nginx & SSL](deploy/NGINX_SSL.md)
5. **Проверка** → [Checklist](deploy/CHECKLIST.md)
