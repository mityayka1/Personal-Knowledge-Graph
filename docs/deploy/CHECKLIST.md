# Deployment Checklist

Чеклист для проверки корректности деплоя PKG.

---

## Подготовка сервера

- [ ] Сервер обновлён (`apt update && apt upgrade`)
- [ ] Создан пользователь `deploy` с sudo
- [ ] SSH ключи настроены, password auth отключён
- [ ] Firewall (UFW) настроен: 22, 80, 443
- [ ] Fail2ban установлен и запущен

---

## Docker

- [ ] Docker и Docker Compose установлены
- [ ] Пользователь `deploy` добавлен в группу `docker`
- [ ] Репозиторий склонирован в `/opt/apps/pkg`

---

## Конфигурация

- [ ] `.env` файл создан из `.env.example`
- [ ] Database credentials заполнены и проверены
- [ ] `API_KEY` сгенерирован (`openssl rand -hex 32`)
- [ ] `JWT_SECRET` сгенерирован (`openssl rand -hex 32`)
- [ ] `OPENAI_API_KEY` добавлен
- [ ] Telegram credentials заполнены (если используется)

---

## Claude CLI (для LLM задач)

- [ ] Claude CLI установлен (`npm install -g @anthropic-ai/claude-code`)
- [ ] Авторизация выполнена (`claude login` через SSH port forwarding)
- [ ] Проверка: `claude whoami` показывает подписку
- [ ] Credentials смонтированы в docker-compose (`CLAUDE_CREDENTIALS_PATH`)

---

## Запуск

- [ ] Образы собраны (`docker compose build`)
- [ ] Сервисы запущены (`docker compose up -d`)
- [ ] Все контейнеры в статусе `healthy` (`docker compose ps`)

---

## Health checks

- [ ] PKG Core: `curl http://localhost:3000/api/v1/health`
- [ ] Telegram Adapter: `curl http://localhost:3001/api/v1/health`
- [ ] Dashboard: `curl http://localhost:3003/api/health`
- [ ] Bull Board: `curl http://localhost:3004/health`
- [ ] n8n: `curl http://localhost:5678/healthz`

---

## Nginx

- [ ] Nginx установлен и запущен
- [ ] `.htpasswd` создан для Basic Auth
- [ ] Конфигурация `/etc/nginx/sites-available/pkg` создана
- [ ] Симлинк в `sites-enabled` создан
- [ ] `nginx -t` проходит без ошибок
- [ ] WebSocket для n8n работает (UI открывается без ошибок)

---

## SSL

- [ ] Certbot установлен
- [ ] Сертификат получен для домена
- [ ] HTTP -> HTTPS редирект работает
- [ ] `certbot renew --dry-run` успешен

---

## Автозапуск и мониторинг

- [ ] Systemd service `pkg.service` создан и enabled
- [ ] Cron job для бэкапов настроен
- [ ] Bull Board доступен через `/bull-board/`
- [ ] n8n доступен через `/n8n/`

---

## n8n (первый запуск)

- [ ] Открыть `https://pkg.example.com/n8n/`
- [ ] Создать owner аккаунт через UI
- [ ] Импортировать/создать workflows

---

## Финальная проверка

- [ ] Dashboard доступен через HTTPS
- [ ] API отвечает с валидным API ключом
- [ ] Telegram Adapter подключён и получает сообщения
- [ ] Очереди обрабатываются (проверить Bull Board)
