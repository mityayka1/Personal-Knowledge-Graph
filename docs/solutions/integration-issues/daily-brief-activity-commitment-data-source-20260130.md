---
module: notification-and-summarization
date: 2026-01-30
problem_type: integration_issue
component: DigestService, NotificationModule, SecondBrainExtractionService, Activity, Commitment
symptoms:
  - Morning Brief missing activities and commitments
  - Daily Synthesis writes to Activity/Commitment tables
  - Brief only reads from EntityEvent
  - Data source mismatch causing incomplete briefs
  - Open tasks and deadlines not shown to users
root_cause: incomplete_data_source_integration
severity: high
tags:
  - daily-brief
  - data-source-mismatch
  - repository-injection
  - typeorm
  - notification-context
  - morning-brief
---

# Daily Brief Missing Activities and Commitments — Data Source Integration

## Problem

Morning Brief queries only EntityEvent table but Daily Synthesis creates Activity and Commitment records. This causes a data mismatch: users don't see their tasks, deadlines, and commitments in morning notifications even though the system extracted them.

**User Impact:** Morning briefing incomplete — missing overdue tasks, pending deadlines, and important commitments that should be highlighted.

## Symptoms

1. **Missing activities in brief** — Tasks and milestones extracted by Daily Synthesis not visible in morning notifications
2. **Missing commitments** — Promises and commitments not included in brief context
3. **Incomplete context** — Brief shows only events, missing critical action items
4. **Data source isolation** — DigestService only queries EntityEvent, ignoring Activity/Commitment tables

## Investigation

### Step 1: Check DigestService Data Sources

**File:** `apps/pkg-core/src/modules/notification/digest.service.ts`

Current brief generation queries only:
```typescript
const events = await this.extractedEventRepo.find({
  where: { entityId, createdAt: GreaterThan(periodStart) },
  relations: ['linkedEntity', 'extractedBy'],
});
```

Missing queries for:
- `Activity` repository (tasks, milestones with deadlines)
- `Commitment` repository (promises and obligations)

### Step 2: Check Activity/Commitment Creation

**File:** `apps/pkg-core/src/modules/summarization/daily-synthesis.service.ts`

The service DOES create Activity and Commitment records:

```typescript
// Activity creation
const activity = this.activityRepo.create({
  ownerEntity: entity,
  activityType: 'task' | 'milestone',
  description: extractedText,
  deadline: parsedDeadline,
  status: 'active',
});

// Commitment creation
const commitment = this.commitmentRepo.create({
  entity,
  commitmentType: 'promise' | 'obligation',
  description: text,
  status: 'pending',
});
```

### Step 3: Check Brief Schema

**File:** `apps/pkg-core/src/modules/notification/digest.entity.ts`

BriefSourceType only includes EntityEvent sources:

```typescript
export type BriefSourceType =
  | 'entity_event'
  | 'extracted_event'
  | 'entity_fact'
  | 'entity';
  // Missing: 'activity' | 'commitment'
```

## Root Causes

### 1. Missing Repository Injection

DigestService doesn't have access to Activity/Commitment repositories, so even if code was added to query them, it would fail.

### 2. Incomplete Data Source Type Definition

BriefSourceType only covers EventSource types, not structured actions like Activity or Commitment.

### 3. Unmapped Activity/Commitment Queries

No implementation of `getOverdueActivities()` or `getPendingCommitments()` methods in DigestService.

## Solution

### 1. Inject Activity and Commitment Repositories

**File:** `apps/pkg-core/src/modules/notification/digest.service.ts`

```typescript
import { Activity } from '../../../database/entities/activity.entity';
import { Commitment } from '../../../database/entities/commitment.entity';
import { In, LessThan } from 'typeorm';

@Injectable()
export class DigestService {
  constructor(
    @InjectRepository(ExtractedEvent)
    private extractedEventRepo: Repository<ExtractedEvent>,

    @InjectRepository(Activity)
    private activityRepo: Repository<Activity>,

    @InjectRepository(Commitment)
    private commitmentRepo: Repository<Commitment>,

    // ... other injections
  ) {}
}
```

### 2. Add Query Methods

**File:** `apps/pkg-core/src/modules/notification/digest.service.ts`

Add helper method to find overdue activities:

```typescript
/**
 * Find overdue activities (tasks, milestones) for entity.
 * Overdue = deadline passed AND not completed
 */
private async getOverdueActivities(
  entityId: string,
  limit = 10,
): Promise<Activity[]> {
  const now = new Date();

  return this.activityRepo.find({
    where: {
      ownerEntity: { id: entityId },
      activityType: In(['task', 'milestone']),
      deadline: LessThan(now),
      status: In(['active', 'idea']), // Not completed or cancelled
    },
    relations: ['ownerEntity'],
    order: { deadline: 'ASC' }, // Most overdue first
    take: limit,
  });
}
```

Add helper method to find pending commitments:

```typescript
/**
 * Find pending/active commitments for entity.
 * Includes promises, obligations, and other commitments not yet fulfilled.
 */
private async getPendingCommitments(
  entityId: string,
  limit = 10,
): Promise<Commitment[]> {
  return this.commitmentRepo.find({
    where: {
      entity: { id: entityId },
      commitmentType: In(['promise', 'obligation', 'agreement']),
      status: In(['pending', 'active']),
    },
    relations: ['entity'],
    order: { createdAt: 'DESC' },
    take: limit,
  });
}
```

### 3. Extend BriefSourceType

**File:** `apps/pkg-core/src/modules/notification/digest.entity.ts` (or types file)

```typescript
export type BriefSourceType =
  | 'entity_event'
  | 'extracted_event'
  | 'entity_fact'
  | 'entity'
  | 'activity'    // NEW - Tasks and milestones
  | 'commitment'; // NEW - Promises and obligations
```

### 4. Register Entities in Module

**File:** `apps/pkg-core/src/modules/notification/notification.module.ts`

Ensure Activity and Commitment are imported:

```typescript
import { TypeOrmModule } from '@nestjs/typeorm';
import { Activity } from '../../../database/entities/activity.entity';
import { Commitment } from '../../../database/entities/commitment.entity';
import { ExtractedEvent } from '../../../database/entities/extracted-event.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ExtractedEvent,
      Activity,     // NEW
      Commitment,   // NEW
    ]),
    // ... other imports
  ],
  providers: [DigestService, NotificationService],
})
export class NotificationModule {}
```

### 5. Integrate into Brief Generation

**File:** `apps/pkg-core/src/modules/notification/digest.service.ts`

Update brief generation to include activities and commitments:

```typescript
async generateMorningBrief(entityId: string): Promise<string> {
  const entity = await this.entityRepo.findOne({
    where: { id: entityId },
  });

  if (!entity) {
    return 'No brief available';
  }

  const sections: string[] = [];

  // 1. Overdue activities (highest priority)
  const overdueActivities = await this.getOverdueActivities(entityId, 5);
  if (overdueActivities.length > 0) {
    sections.push(this.formatOverdueActivitiesSection(overdueActivities));
  }

  // 2. Recent events
  const periodStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const events = await this.extractedEventRepo.find({
    where: {
      entityId,
      createdAt: GreaterThan(periodStart),
    },
    relations: ['linkedEntity'],
    order: { createdAt: 'DESC' },
    take: 10,
  });

  if (events.length > 0) {
    sections.push(this.formatEventsSection(events));
  }

  // 3. Pending commitments (lower priority than overdue)
  const pendingCommitments = await this.getPendingCommitments(entityId, 5);
  if (pendingCommitments.length > 0) {
    sections.push(this.formatCommitmentsSection(pendingCommitments));
  }

  return sections.join('\n\n') || 'Ничего нового за последние сутки.';
}

/**
 * Format overdue activities section with clear warning
 */
private formatOverdueActivitiesSection(activities: Activity[]): string {
  const lines = activities.map(activity => {
    const daysOverdue = Math.floor(
      (Date.now() - activity.deadline.getTime()) / (1000 * 60 * 60 * 24),
    );
    return `⚠️ <b>${activity.description}</b>\n   Просрочено на ${daysOverdue} дн.`;
  });

  return '<b>Просроченные задачи:</b>\n' + lines.join('\n');
}

/**
 * Format commitments section
 */
private formatCommitmentsSection(commitments: Commitment[]): string {
  const lines = commitments.map(commitment => {
    return `🤝 ${commitment.description}`;
  });

  return '<b>Обязательства:</b>\n' + lines.join('\n');
}
```

## Prevention

### Code Review Checklist

- [ ] **Data source completeness** — Brief should include Activity, Commitment, and Event tables
  ```bash
  # Verify all entity types are queried
  grep -A 5 "generateMorningBrief\|generateBrief" digest.service.ts
  ```

- [ ] **Repository injection** — All referenced tables must be injected via @InjectRepository()
  ```bash
  # Check all entities are registered
  grep "TypeOrmModule.forFeature" notification.module.ts
  ```

- [ ] **BriefSourceType coverage** — Type definition should match all data sources
  ```typescript
  // Verify all sources are represented
  type BriefSourceType = 'entity_event' | 'extracted_event' | 'entity_fact' | 'entity' | 'activity' | 'commitment';
  ```

- [ ] **Sort order priority** — Overdue activities should come before events
  ```typescript
  // Check brief section order:
  // 1. Overdue activities (time-critical)
  // 2. Recent events
  // 3. Pending commitments
  ```

### CI/CD Validation

```bash
#!/bin/bash
# scripts/validate-brief-sources.sh

echo "Checking brief data sources..."

# Verify Activity and Commitment are injected
if ! grep -q "InjectRepository(Activity)" apps/pkg-core/src/modules/notification/digest.service.ts; then
  echo "ERROR: Activity repository not injected in DigestService"
  exit 1
fi

if ! grep -q "InjectRepository(Commitment)" apps/pkg-core/src/modules/notification/digest.service.ts; then
  echo "ERROR: Commitment repository not injected in DigestService"
  exit 1
fi

# Verify both are registered in module
if ! grep -q "Activity" apps/pkg-core/src/modules/notification/notification.module.ts; then
  echo "ERROR: Activity not registered in NotificationModule"
  exit 1
fi

echo "✓ Brief data sources are properly configured"
```

### Testing Strategy

```typescript
describe('DigestService - Brief Generation', () => {
  let service: DigestService;
  let activityRepo: Repository<Activity>;
  let commitmentRepo: Repository<Commitment>;
  let eventRepo: Repository<ExtractedEvent>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forFeature([
          Activity,
          Commitment,
          ExtractedEvent,
        ]),
      ],
      providers: [DigestService],
    }).compile();

    service = module.get<DigestService>(DigestService);
    activityRepo = module.get<Repository<Activity>>(
      getRepositoryToken(Activity),
    );
    commitmentRepo = module.get<Repository<Commitment>>(
      getRepositoryToken(Commitment),
    );
    eventRepo = module.get<Repository<ExtractedEvent>>(
      getRepositoryToken(ExtractedEvent),
    );
  });

  describe('generateMorningBrief', () => {
    it('should include overdue activities', async () => {
      const entity = await createTestEntity();

      // Create overdue activity
      const overdueActivity = activityRepo.create({
        ownerEntity: entity,
        activityType: 'task',
        description: 'Fix critical bug',
        deadline: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
        status: 'active',
      });
      await activityRepo.save(overdueActivity);

      const brief = await service.generateMorningBrief(entity.id);

      expect(brief).toContain('Просроченные задачи');
      expect(brief).toContain('Fix critical bug');
      expect(brief).toContain('⚠️');
    });

    it('should include pending commitments', async () => {
      const entity = await createTestEntity();

      const commitment = commitmentRepo.create({
        entity,
        commitmentType: 'promise',
        description: 'Call John on Monday',
        status: 'pending',
      });
      await commitmentRepo.save(commitment);

      const brief = await service.generateMorningBrief(entity.id);

      expect(brief).toContain('Обязательства');
      expect(brief).toContain('Call John on Monday');
    });

    it('should prioritize overdue activities over other sources', async () => {
      const entity = await createTestEntity();

      // Create recent event
      const event = eventRepo.create({
        entityId: entity.id,
        eventType: 'mention',
        description: 'User mentioned something',
        createdAt: new Date(),
      });
      await eventRepo.save(event);

      // Create overdue activity
      const activity = activityRepo.create({
        ownerEntity: entity,
        activityType: 'task',
        description: 'Critical task',
        deadline: new Date(Date.now() - 1000),
        status: 'active',
      });
      await activityRepo.save(activity);

      const brief = await service.generateMorningBrief(entity.id);

      // Verify overdue tasks appear first
      const activitiesIndex = brief.indexOf('Просроченные задачи');
      const eventsIndex = brief.indexOf('События');

      expect(activitiesIndex).toBeLessThan(eventsIndex);
    });

    it('should handle empty data gracefully', async () => {
      const entity = await createTestEntity();

      const brief = await service.generateMorningBrief(entity.id);

      expect(brief).toContain('Ничего нового');
    });
  });

  describe('getOverdueActivities', () => {
    it('should return only overdue, non-completed tasks', async () => {
      const entity = await createTestEntity();

      // Overdue task (should be included)
      const overdueTask = activityRepo.create({
        ownerEntity: entity,
        activityType: 'task',
        deadline: new Date(Date.now() - 1000),
        status: 'active',
      });

      // Future task (should be excluded)
      const futureTask = activityRepo.create({
        ownerEntity: entity,
        activityType: 'task',
        deadline: new Date(Date.now() + 1000000),
        status: 'active',
      });

      // Completed task (should be excluded)
      const completedTask = activityRepo.create({
        ownerEntity: entity,
        activityType: 'task',
        deadline: new Date(Date.now() - 1000),
        status: 'completed',
      });

      await activityRepo.save([overdueTask, futureTask, completedTask]);

      const overdue = await (service as any).getOverdueActivities(entity.id);

      expect(overdue).toHaveLength(1);
      expect(overdue[0]).toEqual(overdueTask);
    });

    it('should include milestones', async () => {
      const entity = await createTestEntity();

      const overdueMilestone = activityRepo.create({
        ownerEntity: entity,
        activityType: 'milestone',
        deadline: new Date(Date.now() - 1000),
        status: 'active',
      });

      await activityRepo.save(overdueMilestone);

      const overdue = await (service as any).getOverdueActivities(entity.id);

      expect(overdue).toHaveLength(1);
      expect(overdue[0].activityType).toBe('milestone');
    });
  });
});
```

## Best Practices

1. **Complete data source coverage** — Brief should aggregate from all relevant tables
2. **Priority-based ordering** — Time-critical items (overdue) first
3. **Repository injection** — All data sources must be injected in constructor
4. **Type safety** — Extend BriefSourceType whenever adding new sources
5. **Clear formatting** — Different source types should be visually distinct
6. **Graceful degradation** — Brief should be valid even if some sources are empty

## Related Documentation

- [Phase C: Extract & React](../../second-brain/02-PHASE-C-EXTRACT-REACT.md) — Event extraction and Activity creation
- [DATA_MODEL.md](../../DATA_MODEL.md) — Activity and Commitment entity definitions
- [Duplicate Notifications Solution](./duplicate-notifications-missing-context-20260129.md) — Related brief formatting improvements

## Commit

```
feat(notification): integrate Activity and Commitment into Morning Brief

- Inject Activity and Commitment repositories into DigestService
- Add getOverdueActivities() and getPendingCommitments() query methods
- Extend BriefSourceType to include 'activity' and 'commitment' sources
- Register Activity and Commitment in NotificationModule TypeORM config
- Prioritize overdue activities in brief (highest priority section)
- Add commitments as lower-priority section after events
- Update brief generation to aggregate from all entity data sources

This ensures morning briefings include critical tasks and commitments,
not just extracted events. Resolves data source mismatch between
Daily Synthesis (which creates activities) and Morning Brief
(which only read events).

Closes: [issue-number]
```
