# Server Setup Log

## Server Info

| Parameter | Value |
|-----------|-------|
| **IP** | 150.241.230.206 |
| **Hostname** | assistant.mityayka.ru |
| **User** | mityayka |
| **SSH** | `ssh mityayka@150.241.230.206` |
| **sudo** | Yes (NOPASSWD) |
| **OS** | Ubuntu 24.04.3 LTS |
| **RAM** | 4GB |
| **Disk** | 96GB (93GB free) |

---

## Credentials

### Basic Auth (Dashboard, Bull Board, n8n)
- **Username:** admin
- **Password:** 3LYFrWvusEavNfLsoYbBw

### API Key
```
a93451d176fab5181062e90a12e56e9ded0d7ea8ab2ed61a129ba9ed3b479947
```

### n8n
- **User:** admin
- **Password:** BFuzYD3pu5Ej8dt4O8lNIu4OIQvNe4L

---

## URLs

| Service | URL |
|---------|-----|
| **Dashboard** | https://assistant.mityayka.ru/ |
| **API** | https://assistant.mityayka.ru/api/v1/ |
| **Bull Board** | https://assistant.mityayka.ru/bull-board/ |
| **n8n** | https://assistant.mityayka.ru/n8n/ |
| **Webhooks** | https://assistant.mityayka.ru/webhook/ |

---

## Setup Progress

### Phase 1: Server Preparation

| Step | Status | Notes |
|------|--------|-------|
| Connect to server | ✅ done | SSH key auth |
| Update system | ✅ done | apt update && upgrade |
| Configure firewall (UFW) | ✅ done | 22, 80, 443 allowed |
| Install fail2ban | ✅ done | SSH protection enabled |

### Phase 2: Docker Installation

| Step | Status | Notes |
|------|--------|-------|
| Install Docker Engine | ✅ done | Docker 29.1.4 |
| Install Docker Compose plugin | ✅ done | v5.0.1 |
| Add user to docker group | ✅ done | |
| Verify installation | ✅ done | |

### Phase 3: Application Deployment

| Step | Status | Notes |
|------|--------|-------|
| Clone repository | ✅ done | ~/PKG |
| Configure .env | ✅ done | All credentials set |
| Build images | ✅ done | All 4 services |
| Start services | ✅ done | All healthy |
| Verify health checks | ✅ done | |
| Claude CLI authorization | ⏳ pending | Requires SSH port forwarding |

### Phase 4: Nginx & SSL

| Step | Status | Notes |
|------|--------|-------|
| Install Nginx | ✅ done | nginx 1.24.0 |
| Create .htpasswd | ✅ done | admin user |
| Configure sites | ✅ done | /etc/nginx/sites-available/pkg |
| Install Certbot | ✅ done | |
| Obtain SSL certificate | ✅ done | Let's Encrypt, expires 2026-04-13 |

### Phase 5: Final Configuration

| Step | Status | Notes |
|------|--------|-------|
| Docker auto-restart | ✅ done | restart: unless-stopped (default) |
| Test all endpoints | ✅ done | API, Dashboard (Basic Auth) |
| Setup backups | ⏳ pending | |

---

## Services Status

```
NAMES                  STATUS
pkg-dashboard          healthy
pkg-n8n                healthy
pkg-telegram-adapter   healthy
pkg-core               healthy
pkg-bull-board         healthy
pkg-redis              healthy
```

---

## Remaining Tasks

1. **Claude CLI Authorization**
   - SSH with port forwarding: `ssh -L 8080:localhost:8080 mityayka@150.241.230.206`
   - Run: `claude login`
   - Open http://localhost:8080/... in local browser
   - Credentials will be saved to ~/.claude

2. **Backups** (optional)
   - PostgreSQL: remote database, backup on DB server
   - Redis: local volume, consider periodic snapshots
   - n8n workflows: export to JSON periodically

---

## Useful Commands

```bash
# Check services
cd ~/PKG/docker && docker compose ps

# View logs
docker logs pkg-core --tail 100 -f
docker logs pkg-telegram-adapter --tail 100 -f

# Restart services
cd ~/PKG/docker && docker compose restart

# Update application
cd ~/PKG && git pull && cd docker && docker compose up -d --build

# Check Nginx
sudo nginx -t
sudo systemctl status nginx

# Check SSL certificate
sudo certbot certificates
```
