---
module: Architecture
date: 2026-01-25
problem_type: architecture_violation
component: dashboard, pkg-core, telegram-adapter
symptoms:
  - "Dashboard connecting directly to Telegram Adapter"
  - "path-to-regexp v8+ wildcard params returning arrays"
  - "API calls bypassing PKG Core"
root_cause: architecture_violation
resolution_type: prevention_strategy
severity: high
tags: [architecture, source-agnostic, dashboard, proxy, path-to-regexp, nestjs]
---

# Source-Agnostic Architecture Prevention Strategies

## Overview

This document outlines prevention strategies for maintaining the Source-Agnostic architecture principle in PKG, and handling path-to-regexp v8+ breaking changes in NestJS wildcard routes.

**Problem:** Dashboard was configured to connect directly to Telegram Adapter instead of through PKG Core, violating the Source-Agnostic architecture principle.

**Additional issue:** path-to-regexp v8+ introduces breaking changes with wildcard params that can cause routing failures.

---

## Issue 1: Dashboard Connecting Directly to Adapters

### Architecture Principle

```
┌─────────────┐      ┌──────────┐      ┌──────────────────┐
│  Dashboard  │─────►│ PKG Core │─────►│ Telegram Adapter │
│  (Client)   │      │  (API)   │      │   (Internal)     │
└─────────────┘      └──────────┘      └──────────────────┘
      │                   │
      │   CORRECT PATH    │
      └───────────────────┘

┌─────────────┐                        ┌──────────────────┐
│  Dashboard  │───────────────────────►│ Telegram Adapter │
│  (Client)   │      VIOLATION!        │   (Internal)     │
└─────────────┘                        └──────────────────┘
```

**Why Source-Agnostic matters:**
1. **Single point of control** - PKG Core handles auth, rate limiting, logging
2. **Future extensibility** - Adding WhatsApp/Email adapters doesn't require Dashboard changes
3. **Security** - Adapters don't need to expose public endpoints
4. **Testing** - Mock PKG Core, not individual adapters

### Root Cause

- Developer added `TELEGRAM_ADAPTER_URL` to Dashboard config
- Created direct API calls to Telegram Adapter from Dashboard
- Bypassed PKG Core proxy layer

### Prevention Strategies

#### 1. Configuration Validation

**In Dashboard `nuxt.config.ts`:**
```typescript
// nuxt.config.ts
export default defineNuxtConfig({
  runtimeConfig: {
    // Server-side only
    apiKey: process.env.API_KEY || '',
    pkgCoreUrl: process.env.PKG_CORE_URL || 'http://localhost:3000/api/v1',

    // NOTE: TELEGRAM_ADAPTER_URL intentionally NOT included
    // Dashboard routes ALL adapter requests through PKG Core
    // See: docs/ARCHITECTURE.md "Source-Agnostic" section

    public: {
      appName: 'PKG Dashboard',
    },
  },
});
```

**Environment variable validation script:**
```bash
#!/bin/bash
# scripts/validate-env.sh

# Check for forbidden direct adapter URLs in Dashboard
if grep -r "TELEGRAM_ADAPTER_URL" apps/dashboard/ --include="*.ts" --include="*.vue" | grep -v ".nuxt"; then
  echo "ERROR: Dashboard should not reference TELEGRAM_ADAPTER_URL directly"
  echo "Use PKG Core proxy routes instead (/api/v1/internal/telegram/*)"
  exit 1
fi

# Check for other adapters
for ADAPTER in WHATSAPP EMAIL CALENDAR; do
  if grep -r "${ADAPTER}_ADAPTER_URL" apps/dashboard/ --include="*.ts" --include="*.vue" | grep -v ".nuxt"; then
    echo "ERROR: Dashboard should not reference ${ADAPTER}_ADAPTER_URL directly"
    exit 1
  fi
done

echo "OK: No direct adapter URL references in Dashboard"
```

#### 2. Code Review Checklist

Add to code review process:

```markdown
## Architecture Compliance

- [ ] **No direct adapter URLs in Dashboard**
  - Dashboard must NOT reference `*_ADAPTER_URL` environment variables
  - All adapter communication goes through PKG Core proxy

- [ ] **New Dashboard API calls go through `/api/v1/`**
  - Check target URLs in fetch/axios calls
  - Should be: `${pkgCoreUrl}/...` not adapter URLs

- [ ] **New PKG Core proxy routes if needed**
  - If Dashboard needs new adapter functionality:
    1. Create proxy controller in PKG Core (`/internal/{adapter}/*`)
    2. Dashboard calls PKG Core
    3. PKG Core forwards to adapter
```

#### 3. Test Cases That Catch This Issue

**Unit Test: Dashboard Configuration**
```typescript
// apps/dashboard/__tests__/config.spec.ts
import nuxtConfig from '../nuxt.config';

describe('Dashboard Configuration', () => {
  it('should not have direct adapter URLs in config', () => {
    const config = nuxtConfig.runtimeConfig || {};

    // Check that adapter URLs are not present
    expect(config).not.toHaveProperty('telegramAdapterUrl');
    expect(config).not.toHaveProperty('whatsappAdapterUrl');
    expect(config).not.toHaveProperty('emailAdapterUrl');

    // Only pkgCoreUrl should exist
    expect(config).toHaveProperty('pkgCoreUrl');
  });

  it('should have pkgCoreUrl as the only backend URL', () => {
    const config = nuxtConfig.runtimeConfig || {};

    // Find all URL-like config values
    const urlKeys = Object.keys(config).filter(key =>
      key.toLowerCase().includes('url') &&
      typeof config[key] === 'string'
    );

    expect(urlKeys).toEqual(['pkgCoreUrl']);
  });
});
```

**Integration Test: Proxy Routes Exist**
```typescript
// apps/pkg-core/__tests__/integration/proxy-routes.spec.ts
describe('Internal Proxy Routes', () => {
  it('should have telegram proxy route', async () => {
    const response = await request(app)
      .get('/api/v1/internal/telegram/health')
      .set('X-API-Key', testApiKey);

    // Even if adapter is down, we should get gateway error, not 404
    expect([200, 502, 503]).toContain(response.status);
  });

  it('should forward requests to telegram adapter', async () => {
    // Mock telegram adapter response
    nock('http://telegram-adapter:3001')
      .get('/api/v1/health')
      .reply(200, { status: 'ok' });

    const response = await request(app)
      .get('/api/v1/internal/telegram/health')
      .set('X-API-Key', testApiKey);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
```

**E2E Test: Dashboard Media Through Proxy**
```typescript
// apps/dashboard/__tests__/e2e/media-proxy.spec.ts
describe('Media Proxy', () => {
  it('should load media through PKG Core proxy', async () => {
    // Navigate to messages with media
    await page.goto('/interactions/test-interaction-id');

    // Check that image src uses PKG Core, not Telegram Adapter
    const imgSrc = await page.$eval('img.message-media', el => el.src);

    expect(imgSrc).toContain('/api/telegram/media/');
    expect(imgSrc).not.toContain('telegram-adapter');
    expect(imgSrc).not.toContain(':3001');
  });
});
```

**Lint Rule (ESLint Custom Rule)**
```javascript
// .eslintrc.cjs (for apps/dashboard)
module.exports = {
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        selector: "Literal[value=/telegram-adapter|:3001/]",
        message: 'Direct adapter URLs are forbidden. Use PKG Core proxy routes.',
      },
      {
        selector: "TemplateLiteral[quasis.0.value.raw=/TELEGRAM_ADAPTER/]",
        message: 'Direct adapter URLs are forbidden. Use PKG Core proxy routes.',
      },
    ],
  },
};
```

#### 4. Documentation Updates

**Add to `docs/ARCHITECTURE.md`:**
```markdown
## Source-Agnostic Architecture

### Client Communication Rules

| Client | Can Call | Cannot Call |
|--------|----------|-------------|
| Dashboard | PKG Core `/api/v1/*` | Telegram Adapter, Worker |
| Mobile App | PKG Core `/api/v1/*` | Telegram Adapter, Worker |
| n8n Worker | PKG Core `/api/v1/*` | Direct DB, Telegram Adapter |

### Adding New Adapter Communication

When Dashboard needs to communicate with an adapter:

1. **Create PKG Core proxy controller**
   ```typescript
   // apps/pkg-core/src/modules/internal-proxy/{adapter}-proxy.controller.ts
   @Controller('internal/{adapter}')
   export class AdapterProxyController {
     @All('*path')
     async proxy(@Req() req, @Res() res) { ... }
   }
   ```

2. **Create Dashboard server route (Nuxt)**
   ```typescript
   // apps/dashboard/server/api/{adapter}/[...path].ts
   export default defineEventHandler(async (event) => {
     const targetUrl = `${config.pkgCoreUrl}/internal/{adapter}/${path}`;
     // Proxy to PKG Core, NOT directly to adapter
   });
   ```

3. **Use in Dashboard components**
   ```typescript
   // Composable
   const { data } = useFetch('/api/{adapter}/some-endpoint');
   // Automatically routes through: Dashboard → PKG Core → Adapter
   ```

### Why Not Direct Communication?

1. **Authentication** - PKG Core validates JWT/API keys
2. **Rate Limiting** - Central control of request rates
3. **Logging** - Unified access logs in PKG Core
4. **Future Sources** - Add WhatsApp adapter without changing Dashboard
5. **Testing** - Mock PKG Core responses, not individual adapters
```

#### 5. Automated CI Check

**.github/workflows/architecture-check.yml:**
```yaml
name: Architecture Compliance

on:
  pull_request:
    paths:
      - 'apps/dashboard/**'
      - 'apps/pkg-core/**'

jobs:
  check-source-agnostic:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Check for direct adapter URLs in Dashboard
        run: |
          # Search for adapter URL references
          if grep -rE "(TELEGRAM|WHATSAPP|EMAIL)_ADAPTER_URL" apps/dashboard/ \
               --include="*.ts" --include="*.vue" --include="*.js" \
               | grep -v ".nuxt" | grep -v "node_modules"; then
            echo "::error::Dashboard must not reference adapter URLs directly"
            echo "Use PKG Core proxy routes instead"
            exit 1
          fi

          # Search for hardcoded adapter ports
          if grep -rE "localhost:300[1-9]|telegram-adapter:|whatsapp-adapter:" apps/dashboard/ \
               --include="*.ts" --include="*.vue" --include="*.js" \
               | grep -v ".nuxt" | grep -v "node_modules"; then
            echo "::error::Dashboard contains hardcoded adapter URLs"
            exit 1
          fi

          echo "Architecture check passed"
```

---

## Issue 2: path-to-regexp v8+ Breaking Changes

### Problem Description

NestJS uses `path-to-regexp` for route matching. Version 8+ introduces breaking changes:

**Before v8 (path-to-regexp v6.x):**
```typescript
@All('*')
async handler(@Req() req) {
  const path = req.params[0];  // String: "foo/bar/baz"
}
```

**After v8:**
```typescript
@All('*path')  // Named param required
async handler(@Req() req) {
  const path = req.params.path;  // Array: ["foo", "bar", "baz"]
}
```

### Breaking Changes Summary

| Aspect | v6 (old) | v8 (new) |
|--------|----------|----------|
| Wildcard syntax | `*` | `*name` (must be named) |
| Param type | string | string[] (array of segments) |
| Access | `params[0]` | `params.name` |
| Empty path | `""` | `[]` |

### Prevention Strategies

#### 1. Migration Pattern

**Safe wildcard handler:**
```typescript
// apps/pkg-core/src/modules/internal-proxy/telegram-proxy.controller.ts

@Controller('internal/telegram')
export class TelegramProxyController {
  @All('*path')  // Named wildcard (v8+ compatible)
  async proxy(@Req() req: Request, @Res() res: Response) {
    // Handle both v6 (string) and v8 (array) formats
    const rawPath = (req.params as { path?: string | string[] }).path;
    const path = Array.isArray(rawPath) ? rawPath.join('/') : rawPath || '';

    const targetUrl = `${this.adapterUrl}/api/v1/${path}`;
    // ...
  }
}
```

#### 2. Type-Safe Helper

```typescript
// libs/common/src/utils/path-params.ts

/**
 * Extract path from wildcard route param.
 * Handles both path-to-regexp v6 (string) and v8+ (array) formats.
 *
 * @example
 * // Route: @All('*path')
 * const path = extractWildcardPath(req.params, 'path');
 * // "/foo/bar" or ["foo", "bar"] → "foo/bar"
 */
export function extractWildcardPath(
  params: Record<string, string | string[] | undefined>,
  paramName: string = 'path'
): string {
  const raw = params[paramName];

  if (Array.isArray(raw)) {
    return raw.join('/');
  }

  if (typeof raw === 'string') {
    // Remove leading slash if present
    return raw.startsWith('/') ? raw.slice(1) : raw;
  }

  return '';
}

/**
 * Type guard for path-to-regexp v8 array params
 */
export function isArrayParam(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string');
}
```

#### 3. Test Cases for path-to-regexp

```typescript
// apps/pkg-core/__tests__/unit/path-params.spec.ts
import { extractWildcardPath } from '@libs/common/utils/path-params';

describe('extractWildcardPath', () => {
  describe('path-to-regexp v8 format (array)', () => {
    it('should join array segments', () => {
      expect(extractWildcardPath({ path: ['foo', 'bar', 'baz'] }))
        .toBe('foo/bar/baz');
    });

    it('should handle empty array', () => {
      expect(extractWildcardPath({ path: [] })).toBe('');
    });

    it('should handle single segment', () => {
      expect(extractWildcardPath({ path: ['health'] })).toBe('health');
    });
  });

  describe('path-to-regexp v6 format (string)', () => {
    it('should return string as-is', () => {
      expect(extractWildcardPath({ path: 'foo/bar/baz' }))
        .toBe('foo/bar/baz');
    });

    it('should remove leading slash', () => {
      expect(extractWildcardPath({ path: '/foo/bar' }))
        .toBe('foo/bar');
    });

    it('should handle empty string', () => {
      expect(extractWildcardPath({ path: '' })).toBe('');
    });
  });

  describe('edge cases', () => {
    it('should handle undefined param', () => {
      expect(extractWildcardPath({ other: 'value' })).toBe('');
    });

    it('should use custom param name', () => {
      expect(extractWildcardPath({ wildcard: ['a', 'b'] }, 'wildcard'))
        .toBe('a/b');
    });
  });
});
```

#### 4. Integration Test for Proxy Routes

```typescript
// apps/pkg-core/__tests__/integration/telegram-proxy.spec.ts
describe('TelegramProxyController', () => {
  describe('wildcard path handling', () => {
    it('should handle nested paths', async () => {
      nock('http://telegram-adapter:3001')
        .get('/api/v1/chats/123/messages/456/download')
        .reply(200, { data: 'test' });

      const response = await request(app)
        .get('/api/v1/internal/telegram/chats/123/messages/456/download')
        .set('X-API-Key', apiKey);

      expect(response.status).toBe(200);
    });

    it('should handle root path', async () => {
      nock('http://telegram-adapter:3001')
        .get('/api/v1/')
        .reply(200, { status: 'ok' });

      const response = await request(app)
        .get('/api/v1/internal/telegram/')
        .set('X-API-Key', apiKey);

      expect(response.status).toBe(200);
    });

    it('should forward query params', async () => {
      nock('http://telegram-adapter:3001')
        .get('/api/v1/media')
        .query({ size: 'x', thumb: 'true' })
        .reply(200, { url: 'test' });

      const response = await request(app)
        .get('/api/v1/internal/telegram/media?size=x&thumb=true')
        .set('X-API-Key', apiKey);

      expect(response.status).toBe(200);
    });
  });
});
```

#### 5. Code Review Checklist for Wildcard Routes

```markdown
## Wildcard Route Review

- [ ] **Named wildcard param used**
  - Use `@All('*path')` not `@All('*')`
  - Ensures forward compatibility with path-to-regexp v8+

- [ ] **Array handling in place**
  - Check if `req.params.path` could be array
  - Use `extractWildcardPath()` helper or explicit `Array.isArray()` check

- [ ] **Tests cover both formats**
  - String path: `"foo/bar/baz"`
  - Array path: `["foo", "bar", "baz"]`
  - Empty path: `""` and `[]`

- [ ] **Query params preserved**
  - Wildcard should not affect query string handling
```

#### 6. Documentation Update

**Add to `docs/developing/NESTJS_PATTERNS.md`:**
```markdown
## Wildcard Routes (Proxy Controllers)

### path-to-regexp v8+ Compatibility

NestJS uses path-to-regexp for route matching. Version 8+ changed wildcard behavior:

\`\`\`typescript
// DEPRECATED (v6 syntax, may break in future)
@All('*')
handler(@Req() req) {
  const path = req.params[0];  // Works in v6, fails in v8
}

// CORRECT (v8+ compatible)
@All('*path')
handler(@Req() req) {
  // Handle both string (v6) and array (v8) formats
  const rawPath = req.params.path;
  const path = Array.isArray(rawPath) ? rawPath.join('/') : rawPath || '';
}

// BEST (use helper)
import { extractWildcardPath } from '@libs/common/utils/path-params';

@All('*path')
handler(@Req() req) {
  const path = extractWildcardPath(req.params);
}
\`\`\`

### When to Use Wildcards

- **Proxy controllers** - Forward requests to other services
- **Catch-all routes** - Handle unknown paths gracefully

### Testing Wildcards

Always test with:
- Deep paths: `/a/b/c/d`
- Single segment: `/health`
- Empty path: `/`
- With query params: `/path?key=value`
```

---

## Consolidated Prevention Checklist

Add to `docs/deploy/CHECKLIST.md`:

```markdown
## Architecture Compliance

### Source-Agnostic Principle

- [ ] Dashboard only calls PKG Core (`/api/v1/*`)
- [ ] No `*_ADAPTER_URL` in Dashboard config
- [ ] Proxy routes exist in PKG Core for adapter communication
- [ ] Architecture diagram matches implementation

### Wildcard Routes

- [ ] All wildcards use named params (`*path` not `*`)
- [ ] Array handling for path-to-regexp v8+
- [ ] Tests cover string and array path formats
```

---

## Quick Reference: Correct Patterns

### Dashboard → PKG Core → Adapter

```typescript
// 1. Dashboard composable calls its own server
const { data } = useFetch('/api/telegram/media/123/456');

// 2. Dashboard server routes to PKG Core
// server/api/telegram/[...path].ts
const targetUrl = `${config.pkgCoreUrl}/internal/telegram/${path}`;

// 3. PKG Core proxy controller forwards to adapter
// TelegramProxyController
const targetUrl = `${this.telegramAdapterUrl}/api/v1/${path}`;
```

### Wildcard Route Handler

```typescript
@All('*path')
async proxy(@Req() req: Request, @Res() res: Response) {
  const rawPath = (req.params as { path?: string | string[] }).path;
  const path = Array.isArray(rawPath) ? rawPath.join('/') : rawPath || '';
  // ...
}
```

---

## Related Documentation

- [docs/ARCHITECTURE.md](../../ARCHITECTURE.md) - System architecture
- [docs/API_CONTRACTS.md](../../API_CONTRACTS.md) - API contracts
- [CLAUDE.md](../../../CLAUDE.md) - Development guidelines
- [apps/pkg-core/src/modules/internal-proxy/](../../../apps/pkg-core/src/modules/internal-proxy/) - Proxy controllers

## Prevention Summary

| Issue | Prevention | Detection |
|-------|------------|-----------|
| Direct adapter access | Config validation, CI check | grep for `*_ADAPTER_URL` |
| path-to-regexp v8 | Named wildcards, array handling | Tests with array params |
| Missing proxy route | Architecture review | 404 on `/internal/*` paths |
