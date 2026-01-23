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
                    │ 3. restart │
                    └───────────┘
```

---

## Настроенные секреты

В GitHub Repository → Settings → Secrets and variables → Actions:

| Secret | Описание |
|--------|----------|
| `SSH_PRIVATE_KEY` | Приватный ключ для SSH доступа к серверу |
| `SERVER_HOST` | IP адрес или hostname сервера |
| `SERVER_USER` | Пользователь SSH (обычно `root`) |

---

## Workflow файл

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

            # Fix git ownership for all projects in /opt/apps/
            git config --global --add safe.directory '/opt/apps/*'

            git fetch origin master
            git reset --hard origin/master
            cd docker
            docker compose pull
            docker compose up -d --build
            docker image prune -f
            echo "Deployment completed at $(date)"
```

---

## Ручной запуск деплоя

1. Перейти в GitHub → Actions → Deploy to Production
2. Нажать "Run workflow"
3. Выбрать ветку (обычно `master`)
4. Нажать "Run workflow"

---

## Мониторинг деплоя

- **GitHub Actions:** вкладка Actions в репозитории
- **Логи на сервере:** `docker compose logs -f` в `/opt/apps/pkg/docker`

---

## Откат

При проблемах после деплоя:

```bash
# На сервере
cd /opt/apps/pkg
git log --oneline -5            # Найти предыдущий коммит
git reset --hard <commit-hash>  # Откатить
cd docker
docker compose up -d --build    # Пересобрать
```
