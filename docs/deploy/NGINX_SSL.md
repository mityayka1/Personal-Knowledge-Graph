# Nginx & SSL Configuration

Настройка reverse proxy и SSL сертификатов.

---

## Установка Nginx

```bash
sudo apt install nginx -y
sudo systemctl enable nginx
```

---

## Создание Basic Auth

Для защиты Dashboard и Bull Board:

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

---

## Конфигурация сайта

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
    server 127.0.0.1:3004;
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

---

## Активация конфигурации

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
