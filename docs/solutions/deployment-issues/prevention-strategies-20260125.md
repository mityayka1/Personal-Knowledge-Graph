---
module: Deployment
date: 2026-01-25
problem_type: deployment_issues
component: infrastructure
symptoms:
  - "Telegram session invalidated after server IP change"
  - "Nginx intercepting Nuxt server routes (/_nuxt/, /api/)"
  - "Cannot create users in container without bcrypt native module"
root_cause: config_error
resolution_type: prevention_strategy
severity: medium
tags: [deployment, telegram, nginx, bcrypt, docker, prevention]
---

# Deployment Issues Prevention Strategies

## Overview

This document outlines prevention strategies for three common deployment issues encountered during PKG deployment:

1. **Telegram Session Invalidation on IP Change** - MTProto session tied to IP
2. **Nginx Intercepting Nuxt Server Routes** - Proxy configuration conflicts
3. **Database User Management Without bcrypt** - Native module dependency in containers

---

## Issue 1: Telegram Session Invalidation on IP Change

### Problem Description

Telegram's MTProto protocol binds sessions to the originating IP address. When the server IP changes (cloud provider migration, Cloudflare tunnel changes, VPN reconfiguration), the session becomes invalid with errors like:

```
AUTH_KEY_UNREGISTERED
SESSION_REVOKED
The session has been terminated
```

### Root Cause

- MTProto sessions are cryptographically bound to the IP they were created from
- IP changes (even through proxies/tunnels) invalidate the session
- This is a Telegram security feature to prevent session hijacking

### Prevention Strategies

#### Pre-Deployment Checklist

- [ ] **Document current network configuration**
  - Note whether using direct IP, Cloudflare tunnel, or VPN
  - Record the outbound IP visible to Telegram: `curl ifconfig.me`

- [ ] **Plan for static outbound IP**
  - Use a cloud provider with static IP (not behind NAT)
  - If using Cloudflare tunnel: understand IP will be CF's egress IP
  - Consider dedicated egress IP for Telegram traffic

- [ ] **Prepare session regeneration procedure**
  - Document `scripts/remote-telegram-auth.sh` usage
  - Ensure SSH access is available for re-authentication
  - Keep Telegram account phone accessible for 2FA codes

#### Configuration Validation

```bash
# Before deployment - verify network path
curl -s ifconfig.me
# Note this IP - session will be bound to it

# In docker-compose.yml - consider network_mode
services:
  telegram-adapter:
    # If you need consistent outbound IP:
    # network_mode: "host"  # Uses host IP directly
    # Or configure external proxy
```

#### Monitoring Recommendations

```bash
# Add to health check script
check_telegram_session() {
  # Check adapter logs for session errors
  docker logs pkg-telegram-adapter --tail 50 2>&1 | grep -E "AUTH_KEY|SESSION_REVOKED|terminated"

  # Health endpoint should reflect connection status
  curl -s http://localhost:3001/api/v1/health | jq '.telegram.connected'
}

# Alert on IP change
CURRENT_IP=$(curl -s ifconfig.me)
EXPECTED_IP="82.22.23.59"  # Your server IP
if [ "$CURRENT_IP" != "$EXPECTED_IP" ]; then
  echo "WARNING: IP changed from $EXPECTED_IP to $CURRENT_IP"
  echo "Telegram session may need regeneration"
fi
```

#### Documentation Updates

Add to `docs/deploy/CHECKLIST.md`:
```markdown
## Telegram Session

- [ ] Outbound IP documented: _______________
- [ ] Session generated from THIS IP (not local machine)
- [ ] Re-auth script tested: `./scripts/remote-telegram-auth.sh`
- [ ] Phone number accessible for codes
```

#### Recovery Procedure

```bash
# When session is invalidated:
cd ~/PKG

# 1. Stop telegram-adapter (releases session)
docker compose stop telegram-adapter

# 2. Run re-auth script (from local machine with SSH)
./scripts/remote-telegram-auth.sh deploy@server

# 3. Verify new session works
docker compose start telegram-adapter
docker logs pkg-telegram-adapter -f
```

---

## Issue 2: Nginx Intercepting Nuxt Server Routes

### Problem Description

When deploying Nuxt 3 dashboard behind Nginx, requests to:
- `/_nuxt/` (Vite/Webpack chunks)
- `/api/` (Nuxt server routes, NOT the PKG API)

May be incorrectly proxied to PKG Core API instead of the Dashboard, causing:
- 404 errors for static assets
- API calls going to wrong backend
- Broken HMR in development

### Root Cause

- Nginx `location /api/` captures ALL `/api/*` requests
- Nuxt dashboard may use `/api/` for its own server routes
- Static assets `/_nuxt/` need to reach Nuxt server, not be blocked

### Prevention Strategies

#### Pre-Deployment Checklist

- [ ] **Map all service routes before configuring Nginx**
  - PKG Core API: `/api/v1/`
  - Dashboard internal routes: Check Nuxt `server/api/` directory
  - Dashboard assets: `/_nuxt/`

- [ ] **Use versioned API paths**
  - PKG Core: `/api/v1/` (not bare `/api/`)
  - This prevents conflicts with other services

- [ ] **Test each location block independently**

#### Configuration Validation

```nginx
# CORRECT - Specific paths take precedence
server {
    # Dashboard (catch-all for frontend)
    location / {
        proxy_pass http://pkg_dashboard;
        # ... standard proxy headers
    }

    # PKG Core API - versioned path (more specific than /)
    location /api/v1/ {
        proxy_pass http://pkg_core;
        # ... proxy settings
    }

    # If dashboard has its own /api/ routes:
    location /dashboard-api/ {
        # Rewrite to dashboard's /api/
        rewrite ^/dashboard-api/(.*) /api/$1 break;
        proxy_pass http://pkg_dashboard;
    }

    # Nuxt assets - explicit match (optional, / should handle it)
    location /_nuxt/ {
        proxy_pass http://pkg_dashboard;
        # Long cache for hashed assets
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
}
```

#### Nginx Debugging

```bash
# Test which location handles a request
nginx -T 2>/dev/null | grep -A20 "location"

# Check access logs for routing
sudo tail -f /var/log/nginx/access.log | grep -E "/_nuxt|/api"

# Test specific paths
curl -I https://your-domain.com/_nuxt/entry.js
# Should return 200 from dashboard, not 404 from API

curl -I https://your-domain.com/api/v1/health
# Should hit PKG Core
```

#### Monitoring Recommendations

```bash
# Add to monitoring script
check_nginx_routing() {
  # Test critical routes

  # PKG Core API
  API_STATUS=$(curl -s -o /dev/null -w "%{http_code}" https://domain.com/api/v1/health)
  [ "$API_STATUS" != "200" ] && echo "ERROR: API returning $API_STATUS"

  # Dashboard static assets (check any _nuxt path)
  NUXT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" https://domain.com/_nuxt/)
  # 404 is OK (directory listing blocked), but 502/503 indicates routing issue
  [ "$NUXT_STATUS" == "502" ] && echo "ERROR: /_nuxt/ not reaching dashboard"

  # Dashboard root
  DASH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" https://domain.com/)
  [ "$DASH_STATUS" != "200" ] && [ "$DASH_STATUS" != "401" ] && echo "ERROR: Dashboard returning $DASH_STATUS"
}
```

#### Documentation Updates

Add to `docs/deploy/NGINX_SSL.md`:
```markdown
## Route Mapping

Before configuring locations, document all service routes:

| Path | Service | Notes |
|------|---------|-------|
| `/api/v1/` | PKG Core | REST API |
| `/_nuxt/` | Dashboard | Static assets |
| `/` | Dashboard | Frontend SPA |
| `/n8n/` | n8n | WebSocket required |
| `/bull-board/` | Bull Board | Queue monitoring |
| `/webhook/` | n8n | Webhook endpoints |

**Nginx Location Priority:**
1. Exact match `=`
2. Prefix match `^~`
3. Regex `~` or `~*`
4. Longest prefix match

Always test routing after changes:
\`\`\`bash
nginx -t && sudo systemctl reload nginx
curl -I https://domain.com/api/v1/health
curl -I https://domain.com/
\`\`\`
```

---

## Issue 3: Database User Management Without bcrypt in Container

### Problem Description

When needing to create or reset user passwords from within a Docker container, the operation fails because:
- bcrypt requires native compilation
- Alpine images may lack build tools
- Production images are optimized (no dev dependencies)

Errors like:
```
Error: Cannot find module 'bcrypt'
node-pre-gyp ERR! build error
```

### Root Cause

- bcrypt is a native Node.js addon requiring compilation
- Production Docker images don't include build tools
- Seed scripts that use bcrypt fail in production containers

### Prevention Strategies

#### Pre-Deployment Checklist

- [ ] **Test user creation in production-like container**
  ```bash
  docker compose exec pkg-core node -e "require('bcrypt')"
  ```

- [ ] **Pre-hash passwords before deployment**
  - Generate hashed password locally
  - Insert directly into database

- [ ] **Document password management procedure**

#### Configuration Validation

```dockerfile
# In Dockerfile.pkg-core - ensure bcrypt is properly installed
FROM node:20-alpine AS builder

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++

# ... build steps ...

FROM node:20-alpine AS production

# For bcrypt to work, we need the compiled .node file from builder
# This is handled by npm/pnpm install copying native bindings
```

#### Alternative: Pre-Hash Passwords

```bash
# On local machine with bcrypt available
node -e "const bcrypt = require('bcrypt'); bcrypt.hash('your-password', 12).then(h => console.log(h))"
# Output: $2b$12$...

# Then insert directly into database
docker compose exec postgres psql -U pkg -d pkg -c "
  INSERT INTO users (id, username, password_hash, role, status)
  VALUES (
    gen_random_uuid(),
    'admin',
    '\$2b\$12\$YOUR_HASH_HERE',
    'admin',
    'active'
  );
"
```

#### Create Management Script

```bash
#!/bin/bash
# scripts/create-user.sh - Run from HOST, not container

set -e

USERNAME=${1:-admin}
PASSWORD=${2:-$(openssl rand -base64 16)}

# Hash password using local Node.js
HASH=$(node -e "
  const bcrypt = require('bcrypt');
  bcrypt.hash('$PASSWORD', 12).then(h => console.log(h));
")

# Escape $ for SQL
ESCAPED_HASH=$(echo "$HASH" | sed 's/\$/\\$/g')

# Insert into database
docker compose exec -T postgres psql -U pkg -d pkg << EOF
INSERT INTO users (id, username, password_hash, display_name, role, status, created_at, updated_at)
VALUES (
  gen_random_uuid(),
  '$USERNAME',
  '$ESCAPED_HASH',
  '$USERNAME',
  'admin',
  'active',
  NOW(),
  NOW()
)
ON CONFLICT (username) DO UPDATE SET
  password_hash = EXCLUDED.password_hash,
  updated_at = NOW();
EOF

echo "User '$USERNAME' created/updated"
echo "Password: $PASSWORD"
```

#### Monitoring Recommendations

```bash
# Verify bcrypt works in container after deployment
docker compose exec pkg-core node -e "
  const bcrypt = require('bcrypt');
  bcrypt.hash('test', 10).then(h => {
    console.log('bcrypt OK:', h.substring(0, 20) + '...');
  }).catch(e => {
    console.error('bcrypt FAILED:', e.message);
    process.exit(1);
  });
"
```

#### Documentation Updates

Add to `docs/deploy/DOCKER_DEPLOY.md`:
```markdown
## User Management in Production

### Creating Admin User

**Option A: Use management script (recommended)**
\`\`\`bash
./scripts/create-user.sh admin my-secure-password
\`\`\`

**Option B: Pre-hash and insert directly**
\`\`\`bash
# Generate hash locally
HASH=$(node -e "require('bcrypt').hash('password', 12).then(console.log)")

# Insert via psql
docker compose exec postgres psql -U pkg -d pkg -c "
  INSERT INTO users (id, username, password_hash, role, status)
  VALUES (gen_random_uuid(), 'admin', '\$HASH', 'admin', 'active');
"
\`\`\`

### Resetting Password

\`\`\`bash
./scripts/create-user.sh existing-user new-password
# Script uses ON CONFLICT to update existing users
\`\`\`
```

---

## Consolidated Pre-Deployment Checklist

Add these items to `docs/deploy/CHECKLIST.md`:

```markdown
## Network & Sessions

- [ ] Server outbound IP documented: _______________
- [ ] IP is static (no NAT/dynamic assignment)
- [ ] Telegram session created from THIS server IP
- [ ] Re-authentication script accessible and tested

## Nginx Routing

- [ ] Route map documented for all services
- [ ] `/_nuxt/` reaches Dashboard (not blocked/misrouted)
- [ ] `/api/v1/` reaches PKG Core
- [ ] Location blocks tested individually
- [ ] WebSocket working for n8n (`/n8n/`)

## User Management

- [ ] bcrypt working in production container: `docker compose exec pkg-core node -e "require('bcrypt')"`
- [ ] User creation script available: `scripts/create-user.sh`
- [ ] Initial admin user created
- [ ] Admin password documented securely
```

---

## Monitoring Dashboard Additions

Consider adding these checks to monitoring:

```yaml
# prometheus/alerts.yml (example)
groups:
  - name: deployment-health
    rules:
      - alert: TelegramSessionInvalid
        expr: telegram_adapter_connected == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Telegram session may be invalid"
          runbook: "Check logs for AUTH_KEY errors, run re-auth script"

      - alert: NginxRoutingError
        expr: nginx_upstream_response_status{status="502"} > 10
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Nginx returning 502 errors"
          runbook: "Check if upstream services are running"
```

---

## Related Documentation

- [docs/deploy/CHECKLIST.md](../deploy/CHECKLIST.md) - Deployment checklist
- [docs/deploy/TROUBLESHOOTING.md](../deploy/TROUBLESHOOTING.md) - Issue resolution
- [docs/deploy/NGINX_SSL.md](../deploy/NGINX_SSL.md) - Nginx configuration
- [docs/deploy/DOCKER_DEPLOY.md](../deploy/DOCKER_DEPLOY.md) - Docker deployment

## Prevention Summary

| Issue | Prevention | Recovery Time |
|-------|------------|---------------|
| Telegram IP change | Static IP, document network path | 5-10 min (re-auth) |
| Nginx routing | Route mapping, versioned APIs | 2-5 min (config fix) |
| bcrypt in container | Management script, pre-hash | Immediate (script) |
