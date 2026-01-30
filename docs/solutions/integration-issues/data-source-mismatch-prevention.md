# Data Source Mismatch Prevention

## Problem Summary

**What happened:** When new persistence targets (Activity, Commitment tables) were introduced, existing features reading from old tables (EntityEvent) didn't automatically see the new data.

**Impact:** Brief service queries EntityEvent for meetings/deadlines, but extracted commitments were saved to Activity/Commitment tables instead. Result: commitments extracted from daily synthesis didn't appear in morning briefs.

**Root cause:** Decoupled write and read paths — new features wrote to new tables, but consumers still read from legacy tables without awareness of data source changes.

---

## Prevention Strategy 1: Data Source Registration

### 1.1 Create a Data Source Registry

**Goal:** Central documentation of all table readers and writers to detect mismatches.

**Implementation:**

Create `/docs/DATA_SOURCES.md` documenting:
- Every table and its purpose
- All writers (services/components that save data)
- All readers (services/features that query data)
- Last update date for each mapping

**Template:**

```markdown
## Table: activities

### Writers
- ExtractionPersistenceService.persistProject()
- ExtractionPersistenceService.persistTask()
- ActivityService.create()

### Readers
- ActivityService.findAll() — Activity browse/search
- BrieflinkActivitiesProvider — DOES NOT READ (data not included in brief)
- (Action tools for /act functionality)

### Last Updated
2025-01-30 — Initial mapping, missing brief integration
```

### 1.2 Code Review Checklist Item

When adding new persistence target:

```
[ ] Data Source Registry updated:
    - Added new table with Writers section
    - Identified ALL readers that should see this data
    - Created migration plan for existing features

[ ] For each reader of similar data:
    - If should include new data: updated query
    - If shouldn't: documented why
    - Created tracking issue if decision deferred
```

### 1.3 Automated Detection

Add CI step to check for orphaned tables:

```bash
# scripts/check-data-sources.sh
grep -r "@Entity" packages/entities/src/*.entity.ts | \
  grep -o "'[^']*'" | \
  while read table; do
    if ! grep -q "$table" docs/DATA_SOURCES.md; then
      echo "ERROR: Unmapped entity $table"
      exit 1
    fi
  done
```

---

## Prevention Strategy 2: Feature Integration Testing

### 2.1 E2E Test: Data → Brief Consumption

**Purpose:** Verify that newly persisted data appears in all expected places.

**Test Pattern:**

```typescript
describe('Data Sources Integration', () => {
  describe('When extracting data in daily synthesis', () => {
    it('should appear in morning brief', async () => {
      // 1. Extract and persist activity
      const activity = await activityService.create({
        name: 'Project X',
        activityType: ActivityType.PROJECT,
      });

      // 2. Rebuild brief
      const brief = await briefService.buildBrief(userId);

      // 3. Verify activity appears in brief
      const briefActivities = brief.items.filter(
        i => i.sourceType === 'activity' // OR whatever sourceType is used
      );
      expect(briefActivities).toContainEqual(
        expect.objectContaining({ sourceId: activity.id })
      );
    });

    it('should appear in context synthesis', async () => {
      const commitment = await commitmentService.create({...});

      const context = await contextService.getEntityContext(
        relatedEntity.id
      );

      expect(context.commitments).toContainEqual(
        expect.objectContaining({ id: commitment.id })
      );
    });
  });
});
```

**Coverage:**
- ✅ Daily synthesis extracts and persists data
- ✅ Brief generation includes new data
- ✅ Context synthesis includes new data
- ✅ Search (FTS/vector) includes new data
- ✅ /daily command shows new data

### 2.2 Data Flow Testing

Test complete flow: Extraction → Persistence → Consumption

```typescript
// e2e/data-flow.spec.ts
describe('Data Flow: Extraction → Persistence → Brief', () => {
  it('daily synthesis data reaches brief', async () => {
    const message = 'I need to review the contract by Friday';

    // 1. Extract
    const extracted = await extractionService.extract(message, user);
    expect(extracted.commitments).toHaveLength(1);

    // 2. Persist
    const result = await persistenceService.persist({
      ownerEntityId: user.id,
      commitments: extracted.commitments,
    });
    expect(result.commitmentsCreated).toBe(1);

    // 3. Verify in Brief
    const brief = await briefService.buildBrief(user.id);
    const hasCommitment = brief.items.some(
      i => i.title.includes('contract') &&
           i.sourceType === 'commitment'
    );
    expect(hasCommitment).toBe(true);
  });
});
```

### 2.3 Consumer Synchronization Tests

For each reader, ensure it knows about new writers:

```typescript
// Test naming: `{reader}._should_include_{writer}` or {reader}._excludes_{writer}_intentionally`

describe('BriefService', () => {
  it('_should_include_activities_from_daily_synthesis', async () => {
    // Activities created by ExtractionPersistenceService should appear
  });

  it('_should_include_commitments_from_daily_synthesis', async () => {
    // Commitments created by ExtractionPersistenceService should appear
  });

  it('_excludes_entity_events_from_activities_intentionally', async () => {
    // Document why activity table is separate from entity_events
    // Expected: Activities are structured vs EntityEvents are ad-hoc
  });
});
```

---

## Prevention Strategy 3: Architecture Documentation Updates

### 3.1 Update DATA_MODEL.md with Data Flow Diagrams

**Add section: "Data Flow: Writers & Readers"**

```markdown
## Data Flow: Writers → Readers

### Example: Daily Synthesis Path
```
Daily Messages
     ↓
DailySynthesisExtractionService.extract()
     ↓
ExtractionPersistenceService.persist()
     ├→ Activity table (projects/tasks)
     └→ Commitment table
     ↓
Brief consumers:
  ├→ BriefService.buildBrief() ← MISSING: should query Activity/Commitment
  ├→ ContextService.getContext()
  └→ SearchService.search()
```

### 3.2 Update ARCHITECTURE.md with Consumer List

For each module, document what it reads:

```markdown
## PKG Core Module: Notification

### BriefService
Reads from:
- EntityEvent table (legacy)
- ExtractedEvent table
- EntityFact table
- ~~Activity table~~ — NOT IMPLEMENTED (bug #XYZ)
- ~~Commitment table~~ — NOT IMPLEMENTED (bug #XYZ)

Last updated: 2025-01-30
```

### 3.3 Create DATA_CONSUMER_MAP.ts

Keep a runtime-validated map of readers:

```typescript
// src/database/data-consumer-map.ts
export const DATA_CONSUMER_MAP = {
  'entity_events': {
    entityType: 'EntityEvent',
    consumers: [
      { service: 'BriefService', method: 'buildBrief()' },
      { service: 'DigestService', method: 'generateDigest()' },
      { service: 'NotificationService', method: 'getUpcoming()' },
    ],
    lastUpdated: '2025-01-30',
  },
  'activities': {
    entityType: 'Activity',
    consumers: [
      { service: 'ActivityService', method: 'findAll()' },
      // MISSING: BriefService (should read for /daily output)
    ],
    lastUpdated: '2025-01-30',
  },
  'commitments': {
    entityType: 'Commitment',
    consumers: [
      { service: 'CommitmentService', method: 'findAll()' },
      // MISSING: BriefService (should read for /daily output)
    ],
    lastUpdated: '2025-01-30',
  },
} as const;
```

---

## Prevention Strategy 4: Feature Checklist for New Persistence

### 4.1 Persistence Feature Checklist

When introducing new data persistence (new table or new writer):

```markdown
## Checklist: Add New Persistence Target

### Phase 1: Planning
- [ ] Entity definition created and registered in entities.ts
- [ ] Migration created and tested
- [ ] Writer service implemented (the code that saves data)
- [ ] Update docs/DATA_SOURCES.md with Writers section

### Phase 2: Consumer Analysis
- [ ] Identify all services that read similar data
- [ ] For each reader:
  - [ ] Should this feature consume the new data?
  - [ ] If YES: Create tracking issue to implement
  - [ ] If NO: Document reason in code/docs

### Phase 3: E2E Validation
- [ ] E2E test: persist data → verify in all expected consumers
- [ ] Test all consumer paths:
  - [ ] Morning brief includes new data (/daily)
  - [ ] Context synthesis includes new data (/prepare)
  - [ ] Search includes new data (/recall)
  - [ ] Digest includes new data (email)

### Phase 4: Code Review
- [ ] Data Source Registry updated with new table
- [ ] All tracking issues created for missing consumers
- [ ] E2E tests added and passing
- [ ] Architecture docs updated with new data flow
```

**Template for tracking issue:**

```markdown
## [Task] Integrate {NEW_TABLE} into {CONSUMER}

**Context:** {NEW_TABLE} now stores {DATA_TYPE}.
{CONSUMER} needs to include this data in its output.

**Required changes:**
- Update {CONSUMER} query to include {NEW_TABLE}
- Add E2E test verifying data appears
- Update docs/DATA_CONSUMER_MAP.ts

**Example:** Activity/Commitment → BriefService.buildBrief()

Current state:
```typescript
// Only reads from entity_events
const events = await entityEventRepo.find();
```

Expected state:
```typescript
// Also reads from activities and commitments
const events = await entityEventRepo.find();
const activities = await activityRepo.find();
const commitments = await commitmentRepo.find();
return [...events, ...activities, ...commitments];
```
```

---

## Prevention Strategy 5: Automated Consumer Detection

### 5.1 Repository Scanner

Add utility to scan which services read which tables:

```typescript
// scripts/analyze-data-consumers.ts
import * as fs from 'fs';
import * as path from 'path';

interface Consumer {
  service: string;
  method: string;
  repoType: string;
  file: string;
}

const consumers: Record<string, Consumer[]> = {};

// Scan for @InjectRepository decorators
const srcDir = path.join(__dirname, '../src');
scanDir(srcDir, (file) => {
  const content = fs.readFileSync(file, 'utf8');

  const matches = content.matchAll(
    /@InjectRepository\((\w+)\)/g
  );

  for (const match of matches) {
    const repo = match[1];
    const serviceName = path.basename(file, '.ts');

    consumers[repo] = consumers[repo] || [];
    consumers[repo].push({
      service: serviceName,
      method: 'unknown',
      repoType: repo,
      file,
    });
  }
});

// Output in DATA_SOURCES.md format
console.log(generateDataSourcesMarkdown(consumers));
```

**Run in CI:**

```bash
# Before each PR
npm run analyze:data-consumers > /tmp/current-consumers.json
git diff origin/main docs/DATA_SOURCES.md > /tmp/doc-changes.json

if ! jq -e '.[] | keys | contains(current_consumers)' /tmp/doc-changes.json; then
  echo "ERROR: New consumer detected but not documented"
  exit 1
fi
```

---

## Prevention Strategy 6: Query-Level Validation

### 6.1 Unified Event Query Builder

Create a helper that ensures all event readers are consistent:

```typescript
// src/modules/notification/unified-event.helper.ts

export interface UnifiedEventSource {
  id: string;
  sourceType: 'entity_event' | 'extracted_event' | 'activity' | 'commitment';
  title: string;
  date: Date;
  priority?: 'high' | 'medium' | 'low';
}

export class UnifiedEventBuilder {
  constructor(
    private entityEventRepo: Repository<EntityEvent>,
    private activityRepo: Repository<Activity>,
    private commitmentRepo: Repository<Commitment>,
  ) {}

  /**
   * Get all events for entity from all sources.
   * IMPORTANT: When new sources are added, this MUST be updated.
   */
  async getAllEvents(
    entityId: string,
    options: { since?: Date; types?: string[] } = {},
  ): Promise<UnifiedEventSource[]> {
    const events: UnifiedEventSource[] = [];

    // Source 1: EntityEvent (legacy)
    const entityEvents = await this.entityEventRepo.find({
      where: {
        entityId,
        eventDate: options.since
          ? MoreThanOrEqual(options.since)
          : undefined,
      },
    });
    events.push(
      ...entityEvents.map(e => ({
        id: e.id,
        sourceType: 'entity_event' as const,
        title: e.title || e.eventType,
        date: e.eventDate,
        priority: e.confidence ? 'high' : 'medium',
      }))
    );

    // Source 2: Activity (from daily synthesis)
    const activities = await this.activityRepo.find({
      where: {
        ownerEntityId: entityId,
        createdAt: options.since
          ? MoreThanOrEqual(options.since)
          : undefined,
      },
    });
    events.push(
      ...activities.map(a => ({
        id: a.id,
        sourceType: 'activity' as const,
        title: a.name,
        date: a.deadline || a.createdAt,
        priority: a.priority ? a.priority.toLocaleLowerCase() as any : undefined,
      }))
    );

    // Source 3: Commitment (from daily synthesis)
    const commitments = await this.commitmentRepo.find({
      where: {
        fromEntityId: entityId,
        dueDate: options.since
          ? MoreThanOrEqual(options.since)
          : undefined,
      },
    });
    events.push(
      ...commitments.map(c => ({
        id: c.id,
        sourceType: 'commitment' as const,
        title: c.title,
        date: c.dueDate,
        priority: c.priority
          ? c.priority.toLocaleLowerCase() as any
          : undefined,
      }))
    );

    // TODO: Add new sources here when introduced
    // Source 4: (future table)

    return events.sort((a, b) => b.date.getTime() - a.date.getTime());
  }
}
```

**Usage in BriefService:**

```typescript
export class BriefService {
  constructor(
    private unifiedEventBuilder: UnifiedEventBuilder,
    // ... other deps
  ) {}

  async buildBrief(entityId: string): Promise<BriefState> {
    const allEvents = await this.unifiedEventBuilder.getAllEvents(entityId);
    // ... rest of logic using allEvents
  }
}
```

**Why this prevents the bug:**
- Single source of truth for "what counts as an event"
- When new table is added, one place to update
- Code reviewer sees `TODO: Add new sources here` comment
- Easy to search for consumers of this pattern

---

## Prevention Strategy 7: Migration Guides for New Tables

### 7.1 New Table Checklist

When introducing a new persistence table:

**File: `/docs/solutions/guides/new-persistence-target.md`**

```markdown
# Implementing a New Persistence Target

## Steps

### 1. Create Entity
- [ ] Define entity in `packages/entities/src/{name}.entity.ts`
- [ ] Register in `apps/pkg-core/src/database/entities.ts`
- [ ] Create migration

### 2. Document Writers
- [ ] Add Writer service(s)
- [ ] Document in `DATA_SOURCES.md`
- [ ] Add logging for debugging

### 3. Consumer Analysis (CRITICAL)
Before merging, identify all consumers:
```bash
# Find all services that read related data
grep -r "EntityEvent\|ExtractedEvent\|EntityFact" src/ | grep find\|query
```

- [ ] List every service that reads similar data
- [ ] For each: Decide if should include new table
- [ ] Create tracking issues for new integrations

### 4. Add E2E Test
```typescript
// e2e/{feature}-data-flow.spec.ts
// Test: Write → Persist → Verify in all consumers
```

### 5. Update Documentation
- [ ] `DATA_SOURCES.md` — add table with writers/readers
- [ ] `ARCHITECTURE.md` — add data flow diagram
- [ ] `DATA_CONSUMER_MAP.ts` — update reader list

### 6. Code Review
- [ ] Ask reviewer: "Are there consumers I'm missing?"
- [ ] Reviewer checks DATA_SOURCES.md against actual code
- [ ] All tracking issues created

## Real Example: Activity/Commitment → Brief

What should have happened:
1. Activity table created ✅
2. ExtractionPersistenceService writes to it ✅
3. ~~BriefService queries it~~ ❌ (BUG)
4. Context synthesis queries it ❌ (might also be missing)
5. Search includes it ❌ (might also be missing)

What went wrong:
- Step 3-5 skipped because Activity table wasn't linked to Brief
- Activity/Commitment tables added without consumer audit
```

---

## Prevention Strategy 8: Monitor & Alert

### 8.1 Orphaned Data Detection

Add periodic check for tables with no readers:

```typescript
// src/modules/database/orphaned-table.monitor.ts

@Injectable()
export class OrphanedTableMonitor {
  constructor(
    private datastore: DataStore,
    private logger: Logger,
  ) {}

  @Cron('0 0 * * 0') // Weekly check
  async checkForOrphanedTables() {
    const KNOWN_CONSUMERS = DATA_CONSUMER_MAP;

    // Get all tables
    const tables = await this.datastore.getAllTableNames();

    for (const table of tables) {
      const consumers = KNOWN_CONSUMERS[table];

      if (!consumers || consumers.consumers.length === 0) {
        this.logger.warn(
          `Orphaned table detected: ${table} (no known readers)`,
        );

        // Could: Create Slack notification, GitHub issue, etc.
        await this.notifyDevs({
          message: `Table ${table} exists but has no known readers. Is this intentional?`,
          severity: 'warning',
        });
      }
    }
  }
}
```

### 8.2 Data Freshness Check

Verify that data written is actually being consumed:

```typescript
@Injectable()
export class DataConsumptionMonitor {
  async checkDataConsumption() {
    // For each new table, verify:
    // 1. Data is being written
    // 2. Data is being read
    // 3. No orphaned records growing indefinitely

    const activities = await this.activityRepo.find();
    const briefedActivities = await this.briefService.getActivitiesInBriefs();

    if (activities.length > briefedActivities.length * 1.5) {
      this.logger.warn(
        `Potential consumption issue: ${activities.length} activities, ` +
        `but only ${briefedActivities.length} in briefs`
      );
    }
  }
}
```

---

## Implementation Roadmap

### Phase 1: Documentation (Week 1)
- [ ] Create `docs/DATA_SOURCES.md`
- [ ] Audit existing tables/consumers
- [ ] Create `docs/solutions/guides/new-persistence-target.md`

### Phase 2: Testing (Week 2)
- [ ] Add E2E test for Activity/Commitment → Brief
- [ ] Add consumer synchronization tests
- [ ] Implement `UnifiedEventBuilder`

### Phase 3: Automation (Week 3)
- [ ] Create `scripts/analyze-data-consumers.ts`
- [ ] Add CI check for unmapped entities
- [ ] Create `DATA_CONSUMER_MAP.ts`

### Phase 4: Monitoring (Week 4)
- [ ] Add `OrphanedTableMonitor`
- [ ] Add `DataConsumptionMonitor`
- [ ] Set up alerts/notifications

### Phase 5: Integration (Week 5)
- [ ] Update code review template
- [ ] Add checklist to PR template
- [ ] Train team on new process

---

## Quick Reference: When Adding New Persistence

```
NEW TABLE → REGISTER → DOCUMENT → TEST → INTEGRATE

1. Create entity (packages/entities/)
2. Register in entities.ts
3. Create migration
4. Create writer service
5. Update docs/DATA_SOURCES.md (Writers section)
6. Audit readers:
   - BriefService?
   - ContextService?
   - SearchService?
   - DigestService?
7. Create E2E test: persist → verify in brief
8. Update DATA_CONSUMER_MAP.ts
9. Create tracking issues for missing consumers
10. Code review: ask "Am I missing consumers?"
```

---

## Lessons Learned

| What | Why | Solution |
|------|-----|----------|
| Activity table created without brief integration | Thought Activity was internal | Require consumer audit |
| No E2E test for daily synthesis → brief | Thought extraction was standalone | Test data flow end-to-end |
| Data flow not documented | No central place to track readers | Create DATA_SOURCES.md |
| Easy to miss new tables in code review | No tooling to detect unmapped tables | CI check for unmapped entities |
| Multiple services querying similar data inconsistently | No unified query pattern | Create UnifiedEventBuilder |
