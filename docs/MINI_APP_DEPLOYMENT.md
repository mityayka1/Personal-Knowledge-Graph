# Telegram Mini App Deployment

## Overview

PKG Telegram Mini App — Vue 3 SPA для управления извлечёнными событиями через Telegram.

## URLs

| Environment | URL |
|-------------|-----|
| Production | https://tlg-mini-app.assistant.mityayka.ru |

## Server Configuration

**Server:** assistant.mityayka.ru (same as PKG Core)

### Nginx Config

Location: `/etc/nginx/sites-available/tlg-mini-app`

```nginx
# PKG Telegram Mini App
server {
    listen 443 ssl http2;
    server_name tlg-mini-app.assistant.mityayka.ru;

    ssl_certificate /etc/letsencrypt/live/tlg-mini-app.assistant.mityayka.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tlg-mini-app.assistant.mityayka.ru/privkey.pem;

    # ALLOWALL required for Telegram iframe
    add_header X-Frame-Options "ALLOWALL";

    root /opt/apps/pkg/apps/mini-app/dist;
    index index.html;

    # SPA routing
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API proxy to pkg-core
    # Mini App calls /api/v1/mini-app/* which gets proxied to pkg-core
    location /api/ {
        proxy_pass http://127.0.0.1:3000/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Authorization $http_authorization;
    }
}
```

### API Routing

Mini App API доступен по пути `/api/v1/mini-app/*`:
- Frontend вызывает: `/api/v1/mini-app/dashboard`
- Nginx проксирует на: `http://127.0.0.1:3000/api/v1/mini-app/dashboard`
- NestJS маршрут: `API_PREFIX(/api/v1) + @Controller('mini-app')`

### SSL Certificate

- **Provider:** Let's Encrypt (certbot)
- **Expiry:** 2026-05-01
- **Auto-renewal:** Enabled via certbot timer

### Static Files

Location: `/opt/apps/pkg/apps/mini-app/dist/`

## Deployment

### Build & Deploy

```bash
# SSH to server
ssh mityayka@assistant.mityayka.ru

# Go to project
cd /opt/apps/pkg

# Pull latest code
git pull

# Install dependencies (if changed)
pnpm install

# Build Mini App
pnpm --filter mini-app build
```

### Alternative: Local build + rsync

```bash
# Local build
cd apps/mini-app
pnpm build

# Deploy
rsync -avz --delete dist/ mityayka@assistant.mityayka.ru:/opt/apps/pkg/apps/mini-app/dist/
```

## Environment Variables

### telegram-adapter (.env)

```env
# Mini App URL for inline buttons
TELEGRAM_MINI_APP_URL=https://tlg-mini-app.assistant.mityayka.ru
```

### pkg-core (.env)

```env
# Telegram Mini App security
TELEGRAM_BOT_TOKEN=<bot-token>
ALLOWED_TELEGRAM_IDS=864381617  # Comma-separated user IDs
```

## BotFather Configuration

1. Open @BotFather
2. Select your bot
3. Bot Settings → Menu Button → Configure menu button
4. Enter URL: `https://tlg-mini-app.assistant.mityayka.ru`

## Security

- **Authentication:** TelegramAuthGuard validates initData HMAC-SHA256 signature
- **Whitelist:** Only users in `ALLOWED_TELEGRAM_IDS` can access
- **HTTPS:** Required by Telegram
- **X-Frame-Options:** ALLOWALL (required for Telegram iframe embedding)

## Troubleshooting

### Check nginx config
```bash
sudo nginx -t
sudo systemctl reload nginx
```

### Check SSL certificate
```bash
sudo certbot certificates
```

### Renew SSL manually
```bash
sudo certbot renew
```

### View nginx logs
```bash
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```
