# План реализации: JWT авторизация для Dashboard (Issue #48)

**Issue:** https://github.com/mityayka1/Personal-Knowledge-Graph/issues/48
**Дата:** 2026-01-14
**Статус:** Draft

---

## Проблема

Текущая архитектура с nginx Basic Auth создаёт критические проблемы:
1. **Client-side fetch не работает** — браузер не передаёт Basic Auth credentials в `fetch()` запросы
2. **Нет logout** — Basic Auth credentials кэшируются браузером
3. **Нет user management** — один пароль для всех
4. **SSR конфликт** — server-side работает, client-side hydration блокируется

---

## Архитектура решения

### Целевая схема

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Browser    │────►│  Dashboard   │────►│  PKG Core    │
│              │     │   (Nuxt)     │     │  (NestJS)    │
└──────────────┘     └──────────────┘     └──────────────┘
       │                    │                    │
       │  1. Login form     │                    │
       │─────────────────►  │                    │
       │                    │  2. POST /auth/login
       │                    │──────────────────► │
       │                    │                    │ 3. Validate
       │                    │  4. JWT tokens     │    Generate JWT
       │                    │◄────────────────── │
       │  5. httpOnly cookie│                    │
       │◄───────────────────│                    │
       │                    │                    │
       │  6. API requests   │  7. Forward with   │
       │  (with cookie)     │     Bearer token   │
       │─────────────────►  │──────────────────► │
       │                    │              (CombinedAuthGuard)
```

### Dual Authentication Strategy

PKG Core поддерживает два типа аутентификации:
1. **JWT (Bearer token)** — для Dashboard и будущих клиентов
2. **API Key (X-API-Key)** — для service-to-service (Telegram Adapter, n8n, Bull Board)

**CombinedAuthGuard** определяет тип по формату:
- `Authorization: Bearer eyJ...` (3 части через `.`) → JWT
- `X-API-Key: ...` или `Authorization: Bearer <not-jwt>` → API Key

---

## Задачи реализации

### Phase 1: Backend (PKG Core)

#### 1.1 User Entity

**Файл:** `packages/entities/src/user.entity.ts`

```typescript
@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true, length: 100 })
  username: string;

  @Column({ unique: true, nullable: true, length: 255 })
  email: string | null;

  @Column({ name: 'password_hash' })
  passwordHash: string;

  @Column({ length: 100, nullable: true, name: 'display_name' })
  displayName: string | null;

  @Column({
    type: 'enum',
    enum: ['admin', 'user'],
    default: 'user',
  })
  role: 'admin' | 'user';

  @Column({
    type: 'enum',
    enum: ['active', 'inactive', 'locked'],
    default: 'active',
  })
  status: 'active' | 'inactive' | 'locked';

  @Column({ name: 'last_login_at', type: 'timestamp', nullable: true })
  lastLoginAt: Date | null;

  @Column({ name: 'failed_login_attempts', default: 0 })
  failedLoginAttempts: number;

  @Column({ name: 'locked_until', type: 'timestamp', nullable: true })
  lockedUntil: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
```

**Миграция:** `1768300000000-AddUsersTable.ts`

#### 1.2 AuthModule Structure

```
apps/pkg-core/src/modules/auth/
├── auth.module.ts
├── auth.controller.ts
├── auth.service.ts
├── strategies/
│   └── jwt.strategy.ts
├── guards/
│   └── jwt-auth.guard.ts
├── dto/
│   ├── login.dto.ts
│   ├── refresh-token.dto.ts
│   └── auth-response.dto.ts
└── interfaces/
    └── jwt-payload.interface.ts
```

#### 1.3 API Endpoints

| Method | Endpoint | Body | Response | Auth |
|--------|----------|------|----------|------|
| POST | `/api/v1/auth/login` | `{ username, password }` | `{ accessToken, expiresIn }` + cookie | Public |
| POST | `/api/v1/auth/refresh` | Cookie или `{ refreshToken }` | `{ accessToken, expiresIn }` + new cookie | Public |
| POST | `/api/v1/auth/logout` | Cookie | 204 + clear cookie | JWT |
| GET | `/api/v1/auth/me` | - | `{ id, username, role }` | JWT |

#### 1.4 CombinedAuthGuard

**Файл:** `apps/pkg-core/src/common/guards/combined-auth.guard.ts`

Приоритет:
1. `@Public()` → пропустить
2. JWT token (Bearer eyJ...) → JwtAuthGuard
3. API Key (X-API-Key или не-JWT Bearer) → ApiKeyGuard
4. Нет credentials → 401

#### 1.5 Refresh Tokens Storage

**Решение:** Redis (TTL native, уже используется для BullMQ)

```
Key format: auth:refresh:{userId}:{tokenId}
Value: { tokenHash, userAgent, ip, createdAt }
TTL: 7 days
```

#### 1.6 Rate Limiting

**NestJS Throttler** на `/auth/login`:
- 10 attempts per minute per IP
- 5 attempts per minute per username
- Progressive lockout (5 fails → 15 min lock)

### Phase 2: Frontend (Dashboard)

#### 2.1 Login Page

**Файл:** `apps/dashboard/pages/login.vue`

- Username/password form
- Error display
- "Remember me" option (longer refresh token)
- Redirect handling (`?redirect=/path`)

#### 2.2 useAuth Composable

**Файл:** `apps/dashboard/composables/useAuth.ts`

```typescript
export function useAuth() {
  const user = useState<User | null>('user', () => null);
  const isAuthenticated = computed(() => !!user.value);

  async function login(username: string, password: string): Promise<void>;
  async function logout(): Promise<void>;
  async function refreshToken(): Promise<void>;
  async function fetchUser(): Promise<void>;

  return { user, isAuthenticated, login, logout, refreshToken, fetchUser };
}
```

#### 2.3 Auth Middleware

**Файл:** `apps/dashboard/middleware/auth.global.ts`

```typescript
export default defineNuxtRouteMiddleware((to) => {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated.value && to.path !== '/login') {
    return navigateTo(`/login?redirect=${encodeURIComponent(to.fullPath)}`);
  }
});
```

#### 2.4 API Interceptor

**Файл:** `apps/dashboard/plugins/api.ts`

- Добавление Bearer token к запросам
- Auto-refresh при 401 с valid refresh token
- Redirect на /login при refresh failure

### Phase 3: Infrastructure

#### 3.1 Environment Variables

**Добавить в `.env`:**
```bash
# JWT Authentication
JWT_SECRET=<openssl rand -hex 32>
JWT_ACCESS_EXPIRATION=15m
JWT_REFRESH_EXPIRATION=7d
```

#### 3.2 docker-compose.yml

```yaml
pkg-core:
  environment:
    JWT_SECRET: ${JWT_SECRET:?JWT_SECRET is required}
    JWT_ACCESS_EXPIRATION: ${JWT_ACCESS_EXPIRATION:-15m}
    JWT_REFRESH_EXPIRATION: ${JWT_REFRESH_EXPIRATION:-7d}

dashboard:
  environment:
    JWT_SECRET: ${JWT_SECRET:?JWT_SECRET is required}
```

#### 3.3 Nginx Changes

**Убрать Basic Auth для Dashboard:**
```nginx
location / {
    # auth_basic removed - JWT handled by application
    proxy_pass http://pkg_dashboard;
    proxy_set_header Authorization $http_authorization;
    # ... rest of config
}
```

**Оставить Basic Auth для Bull Board** (или мигрировать позже).

### Phase 4: Seed & Testing

#### 4.1 Admin User Seed

**Файл:** `apps/pkg-core/src/database/seeds/admin-user.seed.ts`

```typescript
// Default admin credentials (change on first login)
// Username: admin
// Password: from ADMIN_INITIAL_PASSWORD env or generate random
```

#### 4.2 Unit Tests

- `AuthService`: login, refresh, logout, validateToken
- `CombinedAuthGuard`: JWT vs API Key routing
- `JwtStrategy`: token validation

#### 4.3 Integration Tests

- Login flow (success, failure, lockout)
- Refresh flow (rotation, expiration, replay attack)
- Protected routes (with JWT, with API Key, without auth)

#### 4.4 E2E Tests

- Full login → use dashboard → logout flow
- Token refresh without redirect
- Session persistence across reload

---

## Dependencies

### NPM Packages

```bash
# PKG Core
pnpm --filter @pkg/pkg-core add @nestjs/passport @nestjs/jwt passport passport-jwt bcrypt
pnpm --filter @pkg/pkg-core add -D @types/passport-jwt @types/bcrypt

# Throttling (already may be installed)
pnpm --filter @pkg/pkg-core add @nestjs/throttler
```

### Entity Registration

Добавить `User` в:
- `packages/entities/src/index.ts`
- `apps/pkg-core/src/common/config/database.config.ts` (entities array)
- `apps/pkg-core/src/database/data-source.ts` (entities array)

---

## Security Considerations

### Token Security
- [ ] Access token: 15 min expiration, in-memory только
- [ ] Refresh token: httpOnly, Secure, SameSite=Strict cookie
- [ ] JWT secret: >= 256 bits, unique per environment
- [ ] Token type validation (access vs refresh)

### Password Security
- [ ] bcrypt hashing (cost factor 12)
- [ ] Constant-time comparison (timing attacks)
- [ ] No username enumeration (same error for wrong user/password)

### Attack Prevention
- [ ] Rate limiting on /auth/login
- [ ] Account lockout after 5 failed attempts
- [ ] Refresh token rotation on each use
- [ ] Token family revocation on reuse detection

### Cookie Settings
```typescript
{
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/api/v1/auth',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
}
```

---

## Rollout Plan

### Step 1: Development
1. Implement User entity + migration
2. Implement AuthModule
3. Implement CombinedAuthGuard
4. Update Dashboard with login flow
5. Unit & integration tests

### Step 2: Staging
1. Deploy to staging environment
2. E2E testing
3. Security review
4. Performance testing (token validation overhead)

### Step 3: Production
1. Generate JWT_SECRET on server
2. Update .env with JWT variables
3. Deploy backend (pkg-core)
4. Deploy frontend (dashboard)
5. Update nginx config (remove Basic Auth)
6. Verify all services healthy
7. Create initial admin user

### Rollback Plan
1. Restore nginx Basic Auth config
2. Redeploy previous docker images
3. Users re-authenticate with Basic Auth

---

## Acceptance Criteria

- [ ] Пользователь видит форму логина при первом входе
- [ ] После логина токен сохраняется в httpOnly cookie
- [ ] Все API запросы работают (SSR и client-side)
- [ ] Токен автоматически обновляется до истечения
- [ ] Logout полностью очищает сессию
- [ ] Неавторизованные запросы возвращают 401
- [ ] Rate limiting защищает от brute force
- [ ] Service-to-service (Telegram Adapter, n8n) продолжает работать через API Key

---

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| JWT secret leak | Low | Critical | Env variable, rotate periodically |
| Token replay attack | Low | Medium | Short TTL, refresh rotation |
| Brute force | High | Medium | Rate limiting, account lockout |
| Service auth break | Medium | High | CombinedAuthGuard с API Key fallback |
| Migration failure | Low | High | Test on staging first |

---

## Timeline (Estimated)

| Phase | Tasks | Effort |
|-------|-------|--------|
| Phase 1: Backend | Entity, AuthModule, Guards, Tests | ~3 days |
| Phase 2: Frontend | Login page, useAuth, middleware | ~2 days |
| Phase 3: Infrastructure | Env vars, docker, nginx | ~1 day |
| Phase 4: Testing & Deploy | E2E, staging, production | ~2 days |
| **Total** | | **~8 days** |

---

## Open Questions

1. **RBAC сейчас?** — Решение: НЕТ для MVP, заложить extension point в User entity
2. **Max concurrent sessions?** — Предложение: 5 sessions per user
3. **Remember me?** — Предложение: 30 days refresh token vs 7 days default
4. **Bull Board auth?** — Предложение: оставить Basic Auth, мигрировать позже

---

## References

- Issue: https://github.com/mityayka1/Personal-Knowledge-Graph/issues/48
- NestJS JWT: https://docs.nestjs.com/security/authentication
- Passport JWT: http://www.passportjs.org/packages/passport-jwt/
- OWASP Session Management: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
