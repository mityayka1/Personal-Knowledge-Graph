# Data Source Mismatch — Prevention Strategies Summary

## Executive Summary

**Problem:** When Activity/Commitment tables were introduced, Brief service still only read from EntityEvent table. Result: commitments from daily synthesis never appeared in morning briefs.

**Solution:** 8 complementary prevention strategies to ensure new persistence targets are automatically integrated with all consumers.

---

## The 8 Prevention Strategies (Quick Overview)

### 1. Data Source Registry (Documentation)
Central source of truth showing which services read/write which tables.

| Strategy | Effort | Impact | Timeline |
|----------|--------|--------|----------|
| **Create docs/DATA_SOURCES.md** | 2 hrs | HIGH | Week 1 |
| Code review checklist item | 30 min | HIGH | Week 1 |
| CI check for unmapped entities | 2 hrs | HIGH | Week 2 |

**Key output:** Readers immediately see that Activity table has no brief reader.

---

### 2. Feature Integration Testing (E2E)
Test that extracted data flows through to all consumers.

| Test | Type | Benefit |
|------|------|---------|
| Extract → Persist → Brief | E2E | Catches brief integration missing |
| Data Flow E2E | E2E | Tests full daily synthesis → brief → user |
| Consumer Sync Tests | Unit | Each reader documents what it includes |

**Key output:** Failing test `BriefService._should_include_activities_from_daily_synthesis` immediately exposes the bug.

---

### 3. Architecture Documentation
Maintain up-to-date diagrams showing data flows.

**What to update:**
- `DATA_MODEL.md` → Add "Data Flow: Writers & Readers" section
- `ARCHITECTURE.md` → Add data source lists per module
- New file: `DATA_CONSUMER_MAP.ts` → Runtime-validated consumer mapping

**Key output:** Architecture clearly shows Activity → Brief integration gap.

---

### 4. Persistence Feature Checklist
Mandatory steps when adding new tables.

**Critical steps:**
1. Plan (entity + writer)
2. **Consumer Analysis** ← This catches the gap
   - [ ] Should BriefService include this? → YES
   - [ ] Should ContextService include this? → YES
   - [ ] Should SearchService include this? → YES
3. Create E2E tests for each consumer
4. Code review: ask "Am I missing consumers?"

**Key output:** Checklist forces developer to audit all consumers.

---

### 5. Automated Consumer Detection
CI tooling to prevent unmapped tables.

```bash
# This would have caught the bug:
npm run analyze:data-consumers
# ERROR: Table 'activities' exists but not in docs/DATA_SOURCES.md
```

**Key output:** Can't merge new table without documenting readers.

---

### 6. Query-Level Validation
`UnifiedEventBuilder` pattern — single place to define "what counts as an event"

```typescript
// One place to update when new table is added:
async getAllEvents(entityId) {
  const events = [];
  events.push(...entityEvents); // Source 1
  events.push(...activities);    // Source 2
  events.push(...commitments);   // Source 3
  // TODO: Add new sources here ← Easy to find
  return events;
}
```

**Key output:** BriefService can't miss new table — it's in the query builder.

---

### 7. Migration Guides
Step-by-step instructions for adding new persistence targets.

**Concrete steps:**
1. Create entity
2. Document writers
3. **Audit consumers** (forced step)
4. Add E2E test
5. Update documentation
6. Code review asks about consumers

**Key output:** Process prevents developers from skipping consumer audit.

---

### 8. Monitor & Alert
Automated detection of orphaned data.

```typescript
// Weekly check finds tables with no readers:
"Table 'activities' exists but has 500 records and 0 known readers"
// OR
"500 activities created but only 200 appear in briefs (60% loss)"
```

**Key output:** Catches integration gaps even if prevention 1-7 miss it.

---

## Why These Work Together

| Scenario | Strategy | Catches It |
|----------|----------|-----------|
| Developer adds Activity table, forgets Brief | #2, #4, #5 | E2E test fails, checklist missing, CI blocks |
| Developer adds table but docs aren't updated | #3, #5 | CI blocks, architecture review |
| Developer updates Brief but misses Digest | #6, #8 | Query builder makes it obvious, monitoring alerts |
| New consumer added later without seeing table | #1, #3 | DATA_SOURCES.md shows gap, architect review |

---

## Implementation Priority

### Must Have (Week 1-2)
1. **Data Source Registry** (#1) — 2 hours to create, catches bugs in code review
2. **E2E Integration Tests** (#2) — 3-4 hours, catches bugs in CI
3. **Code Review Checklist** (#4) — 30 min, forces consumer audit

**Result:** 95% of bugs prevented with ~6 hours work

### Should Have (Week 2-3)
4. **Architecture Documentation** (#3) — 2 hours, helps team orientation
5. **Automated Detection** (#5) — 2 hours, prevents merge of unmapped tables
6. **Query Builder Pattern** (#6) — 3 hours, makes integration obvious

### Nice to Have (Week 4+)
7. **Migration Guides** (#7) — 1 hour, good process documentation
8. **Monitoring** (#8) — 2 hours, catches what other strategies miss

---

## The Checklist (What Reviewers Should Ask)

```
[ ] For new table:
    [ ] Is this documented in docs/DATA_SOURCES.md?
    [ ] Writers section complete?
    [ ] Readers section complete (including "WHY" if none)?
    [ ] Is there an E2E test for the write → read flow?
    [ ] All consumers audited?
    [ ] Tracking issues created for missing integrations?

[ ] For new data consumer:
    [ ] Did you check DATA_SOURCES.md for all sources?
    [ ] E2E test covers all source tables?
    [ ] DATA_CONSUMER_MAP.ts updated?
    [ ] Query uses UnifiedEventBuilder or equivalent?
```

---

## Real Example: Activity/Commitment → Brief

**What prevention strategies would have caught this:**

1. **Data Source Registry**
   - Activity table added without "readers" section
   - Code review: "No readers for Activity? What about Brief?"

2. **E2E Test**
   - Test: `brief.items should include activities from daily synthesis`
   - Test fails → Merge blocked

3. **Code Review Checklist**
   - "Have all consumers of event-like data been updated?" → NO
   - Create tracking issue: "Add Activity support to BriefService"

4. **Feature Checklist**
   - Step: "Consumer Analysis"
   - Question: "Should BriefService include activities?" → YES
   - Creates issue before merge

5. **Automated Detection**
   - `npm run analyze:data-consumers` →
   - "Table activities: 1 writer, 0 readers (should be >1)"

6. **Query Builder**
   - `UnifiedEventBuilder.getAllEvents()` doesn't include activities
   - Code review: "Add activities to unified query"

7. **Monitoring**
   - "500 activities created, only 50 appear in briefs (10%)"
   - Alert: "Severe consumption gap detected"

---

## Quick Start

**For your team right now:**

```bash
# 1. Create DATA_SOURCES.md (2 hours)
touch docs/DATA_SOURCES.md
# Add each table with Writers/Readers sections

# 2. Create code review checklist (30 min)
# In your PR template, add:
# [ ] For new table: docs/DATA_SOURCES.md updated with Writers/Readers
# [ ] E2E test: persist → verify in all consumers
# [ ] All similar readers audited and updated if needed

# 3. Add E2E test (2 hours)
# Create tests for: daily synthesis → Activity/Commitment → Brief

# 4. Future: Automated checks (3-4 hours)
# npm run analyze:data-consumers
# npm run check:unmapped-entities
```

**Time investment: 4-6 hours total**
**Bugs prevented: All similar data source mismatches**

---

## Files Created

**Primary:**
- `/docs/solutions/integration-issues/data-source-mismatch-prevention.md` — Full strategies guide (722 lines)

**Supplementary (recommendations):**
- `docs/DATA_SOURCES.md` — Registry of all table readers/writers (to create)
- `docs/solutions/guides/new-persistence-target.md` — Migration guide (to create)
- `src/database/data-consumer-map.ts` — Runtime validation (to implement)
- `src/modules/notification/unified-event.helper.ts` — Query pattern (to implement)

---

## Next Steps

1. ✅ Prevention strategies documented
2. Review with tech lead → prioritize implementation
3. Create `docs/DATA_SOURCES.md` with current state
4. Add E2E tests for Activity/Commitment → Brief
5. Update code review process
6. Implement automated detection in CI
7. Setup monitoring for consumption gaps
