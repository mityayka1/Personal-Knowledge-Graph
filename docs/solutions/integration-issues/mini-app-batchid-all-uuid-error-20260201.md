# Mini App batchId='all' UUID Error

---
title: Mini App batchId='all' UUID Error
date: 2026-02-01
category: integration-issues
tags:
  - mini-app
  - uuid
  - api-contract
  - telegram
module: telegram-mini-app
symptoms:
  - "invalid input syntax for type uuid: 'all'"
  - Mini App показывает "Что-то пошло не так"
  - Первый экран работает, ошибка при переходе к подтверждению
severity: high
resolution_time: 30min
---

## Симптомы

1. Mini App открывается нормально (первый экран)
2. При переходе к списку pending approvals — ошибка "Что-то пошло не так"
3. В логах pkg-core:
   ```
   QueryFailedError: invalid input syntax for type uuid: "all"
   ```

## Контекст

Dashboard API для pending approvals возвращает специальное значение `id: 'all'` для объединённого представления всех pending items (проекты + задачи + обязательства). Это позволяет пользователю видеть все pending approvals в одном списке.

Mini App использует этот же Dashboard API и передаёт `batchId` в endpoint `/api/v1/telegram-mini-app/pending-approvals`.

## Корневая причина

Контроллер `TelegramMiniAppController.listPendingApprovals()` передавал `batchId` напрямую в сервис, который использовал его в SQL WHERE clause:

```typescript
// Было (неправильно):
if (batchId) {
  qb.andWhere('pa.batch_id = :batchId', { batchId });
}
```

Когда Dashboard передавал `batchId: 'all'`, PostgreSQL пытался сравнить UUID-колонку со строкой 'all', что вызывало ошибку синтаксиса.

## Решение

В контроллере добавлена проверка на специальное значение 'all':

```typescript
// apps/pkg-core/src/modules/telegram-mini-app/controllers/telegram-mini-app.controller.ts

@Get('pending-approvals')
async listPendingApprovals(
  @Query('batchId') batchId?: string,
  @Query('status') status?: string,
  @Query('limit') limit = 20,
  @Query('offset') offset = 0,
): Promise<PendingApprovalListResponseDto> {
  // 'all' is a special value meaning no filter
  const effectiveBatchId = batchId && batchId !== 'all' ? batchId : undefined;

  const { items, total } = await this.pendingApprovalService.list({
    batchId: effectiveBatchId,
    status: status as PendingApprovalStatus,
    limit,
    offset,
  });

  return { items, total, limit, offset };
}
```

## Дополнительная проблема: Mini App не пересобран

После исправления бэкенда ошибка сохранялась. Причина — Mini App (Vue.js) не был пересобран после обновления кода.

**Решение:** Добавлен шаг сборки Mini App в документацию деплоя:

```bash
cd /opt/apps/pkg/apps/mini-app
pnpm build
```

## Предотвращение

### 1. API Contract Documentation
Документировать специальные значения в API контрактах:
```typescript
/**
 * @param batchId - UUID batch ID or 'all' for no filter
 */
```

### 2. Input Validation
Валидировать входные параметры до использования в SQL:
```typescript
const isValidUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const effectiveBatchId = batchId && isValidUuid(batchId) ? batchId : undefined;
```

### 3. Frontend Build Step in CI/CD
Включить `pnpm build` для Mini App в pipeline деплоя.

### 4. E2E Tests
Добавить тесты для специальных значений:
```typescript
it('should handle batchId=all as no filter', async () => {
  const response = await request(app)
    .get('/api/v1/telegram-mini-app/pending-approvals?batchId=all')
    .set('X-Telegram-Init-Data', validInitData);

  expect(response.status).toBe(200);
  expect(response.body.items).toBeDefined();
});
```

### 5. Deployment Checklist
Обновлён `docs/deploy/DOCKER_DEPLOY.md` — добавлен шаг сборки Mini App.

## Связанные файлы

- `apps/pkg-core/src/modules/telegram-mini-app/controllers/telegram-mini-app.controller.ts`
- `apps/mini-app/src/views/PendingApprovalDetail.vue`
- `docs/deploy/DOCKER_DEPLOY.md`

## Коммиты

- `9d045f6` - fix(mini-app): handle 'all' batchId as no filter
- `d52eec0` - docs(deploy): add Mini App build step to deployment guide
