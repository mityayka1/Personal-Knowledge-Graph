# Operations Guide

Мониторинг, логи, обновления и бэкапы.

---

## Подключение к серверу

### SSH доступ

```bash
ssh mityayka@assistant.mityayka.ru
```

### Быстрая проверка после деплоя

```bash
# Одной командой — проверить статус всех контейнеров
ssh mityayka@assistant.mityayka.ru "cd /opt/apps/pkg/docker && docker compose ps"

# Проверить логи pkg-core за последние 5 минут
ssh mityayka@assistant.mityayka.ru "docker logs pkg-core --tail 50 --since 5m"

# Проверить логи telegram-adapter
ssh mityayka@assistant.mityayka.ru "docker logs pkg-telegram-adapter --tail 50 --since 5m"

# Проверить логи dashboard
ssh mityayka@assistant.mityayka.ru "docker logs pkg-dashboard --tail 50 --since 5m"

# Все логи сразу (follow mode)
ssh mityayka@assistant.mityayka.ru "cd /opt/apps/pkg/docker && docker compose logs -f --tail 20"
```

### Проверка health endpoints

```bash
# С сервера
curl -s http://localhost:3000/api/v1/health | jq
curl -s http://localhost:3001/api/v1/health | jq
curl -s http://localhost:3003/api/health | jq

# Удалённо через SSH
ssh mityayka@assistant.mityayka.ru "curl -s http://localhost:3000/api/v1/health"
```

### Контейнеры

| Container | Service | Port |
|-----------|---------|------|
| `pkg-core` | PKG Core API | 3000 |
| `pkg-telegram-adapter` | Telegram Adapter | 3001 |
| `pkg-dashboard` | Dashboard UI | 3003 |
| `pkg-bull-board` | Queue Monitor | 3004 |
| `pkg-n8n` | n8n Workflows | 5678 |
| `pkg-redis` | Redis | 6379 |

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

Мониторинг очередей BullMQ:
- URL: `http://pkg.example.com/bull-board/`
- Показывает: очереди, jobs, статусы, ошибки

---

## Обновление приложения

### Стандартное обновление

```bash
cd /opt/apps/pkg

# Получить изменения
git pull origin master

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
git pull origin master

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

## Очистка диска

```bash
# Удалить неиспользуемые образы
docker image prune -a

# Удалить все неиспользуемые ресурсы
docker system prune -a

# Очистить логи контейнеров
sudo truncate -s 0 /var/lib/docker/containers/*/*-json.log
```
