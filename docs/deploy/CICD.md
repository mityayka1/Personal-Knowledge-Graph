# CI/CD (GitHub Actions)

Автоматический деплой при push в `master` ветку.

---

## Как это работает

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ git push    │────►│  GitHub     │────►│   Server    │
│ to master   │     │  Actions    │     │ (via SSH)   │
└─────────────┘     └─────────────┘     └─────────────┘
                          │
                    ┌─────▼─────┐
                    │ 1. git pull│
                    │ 2. build   │
                    │ 3. health  │
                    │ 4. cleanup │
                    └───────────┘
```

**Стратегия:** Source-based деплой — образы собираются на сервере из исходников.

---

## Требуемые секреты

В GitHub Repository → Settings → Secrets and variables → Actions:

| Secret | Значение | Описание |
|--------|----------|----------|
| `SERVER_HOST` | `82.22.23.59` | IP адрес сервера |
| `SERVER_USER` | `mityayka` | SSH пользователь |
| `SSH_PRIVATE_KEY` | `-----BEGIN...` | Приватный ключ для SSH |

### Генерация SSH ключа (если нужно)

```bash
# На локальной машине
ssh-keygen -t ed25519 -C "github-actions-deploy"

# Скопировать публичный ключ на сервер
ssh-copy-id -i ~/.ssh/id_ed25519.pub mityayka@82.22.23.59

# Приватный ключ (~/.ssh/id_ed25519) добавить в GitHub Secrets
```

---

## Workflow файл

Расположение: `.github/workflows/deploy.yml`

```yaml
name: Deploy to Production

on:
  push:
    branches:
      - master
  workflow_dispatch:

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
            set -e

            cd /opt/apps/pkg
            git config --global --add safe.directory /opt/apps/pkg

            echo "📥 Pulling latest changes..."
            git fetch origin master
            git reset --hard origin/master

            echo "🔨 Building and starting containers..."
            cd docker
            docker compose up -d --build

            echo "⏳ Waiting for health checks..."
            sleep 30

            echo "📊 Container status:"
            docker compose ps

            echo "🧹 Cleaning up old images..."
            docker image prune -f

            echo "✅ Deployment completed at $(date)"
```

---

## Особенности

### set -e
Скрипт остановится при первой ошибке — не продолжит деплой если git pull или build упадут.

### Health checks
После `docker compose up` ждём 30 секунд и проверяем статус контейнеров. Все сервисы должны быть `healthy`.

### safe.directory
Git требует явного указания безопасных директорий при работе от другого пользователя.

---

## Ручной запуск деплоя

1. GitHub → Actions → **Deploy to Production**
2. Нажать **Run workflow**
3. Выбрать ветку `master`
4. Нажать **Run workflow**

Или через CLI:
```bash
gh workflow run deploy.yml
```

---

## Мониторинг

### GitHub Actions
- Вкладка **Actions** в репозитории
- Логи каждого шага деплоя

### На сервере
```bash
# Статус контейнеров
cd /opt/apps/pkg/docker && docker compose ps

# Логи в реальном времени
docker compose logs -f

# Логи конкретного сервиса
docker logs pkg-core --tail 100 -f
```

---

## Откат

При проблемах после деплоя:

```bash
# На сервере
cd /opt/apps/pkg

# Посмотреть историю
git log --oneline -10

# Откатить на предыдущий коммит
git reset --hard HEAD~1

# Пересобрать
cd docker
docker compose up -d --build
```

Или откат на конкретный коммит:
```bash
git reset --hard abc1234
```

---

## Troubleshooting

### Деплой зависает
Проверить что SSH ключ добавлен в `~/.ssh/authorized_keys` на сервере.

### Permission denied
```bash
# На сервере
sudo chown -R mityayka:mityayka /opt/apps/pkg
```

### Контейнер unhealthy после деплоя
```bash
# Проверить логи проблемного контейнера
docker logs pkg-telegram-adapter --tail 200

# Перезапустить отдельный сервис
docker compose restart telegram-adapter
```

### git: dubious ownership
```bash
git config --global --add safe.directory /opt/apps/pkg
```
