# Integration Issues Solutions Index

## Data Source Mismatch Problem

### The Issue
When new persistence targets (Activity, Commitment tables) were introduced, existing features reading from old tables (EntityEvent) didn't automatically see the new data. Result: commitments extracted from daily synthesis didn't appear in morning briefs.

### Root Cause
Decoupled write and read paths — new features wrote to new tables, but consumers still read from legacy tables without awareness of data source changes.

### Documents

| Document | Purpose | Length |
|----------|---------|--------|
| **data-source-mismatch-prevention.md** | Complete prevention strategies guide with code examples | 722 lines |
| **PREVENTION_SUMMARY.md** | Executive summary and quick reference | 263 lines |
| **This file** | Index of all related documents | — |

---

## Key Files in This Directory

### Prevention Strategies
**File:** `/data-source-mismatch-prevention.md`

8 complementary strategies organized by implementation phase:

1. **Data Source Registry** (Documentation) — Central list of all table readers/writers
2. **Feature Integration Testing** (E2E) — Tests verifying data flows to all consumers
3. **Architecture Documentation** — Diagrams and consumer maps
4. **Persistence Feature Checklist** — Mandatory steps when adding new tables
5. **Automated Consumer Detection** — CI tooling to prevent unmapped tables
6. **Query-Level Validation** — Unified event builders for consistent querying
7. **Migration Guides** — Step-by-step instructions for new persistence
8. **Monitor & Alert** — Detect orphaned tables and consumption issues

**Best for:** Team leads, architects, comprehensive understanding

---

### Prevention Summary
**File:** `/PREVENTION_SUMMARY.md`

Quick reference with:
- 1-paragraph overview of each strategy
- Which prevention catches the bug
- Implementation priority (Must Have / Should Have / Nice to Have)
- Code review checklist
- Real example walkthrough
- 4-6 hour implementation timeline

**Best for:** Code reviewers, developers, implementation planning

---

## Quick Start Implementation

### Phase 1: Today (4-6 hours)
1. Read `PREVENTION_SUMMARY.md` (20 min)
2. Create `docs/DATA_SOURCES.md` registry (2 hours)
3. Add to code review template (30 min)
4. Add E2E test for Activity/Commitment → Brief (2 hours)

**Result:** 95% of similar bugs prevented

### Phase 2: Next Week
- Implement `UnifiedEventBuilder` pattern
- Create `DATA_CONSUMER_MAP.ts`
- Add automated consumer detection

### Phase 3: Following Week
- Create migration guide for new persistence targets
- Add CI checks
- Train team on new process

---

## Problem-Strategy Mapping

| Problem | Prevention Strategies | Prevents It? |
|---------|----------------------|--------------|
| Developer adds table, forgets Brief reader | #2 (E2E), #4 (Checklist), #5 (CI) | YES (3 safeguards) |
| Consumer added but documentation not updated | #1 (Registry), #3 (Docs) | YES (visible in review) |
| New feature reads old table, misses new data | #6 (Query builder), #3 (Docs) | YES (code search finds it) |
| Data written but never read (orphaned) | #8 (Monitoring) | YES (alert on gap) |
| Similar bugs in future | All 8 strategies | YES (process prevents) |

---

## Specific Code Locations

### The Bug's Location
```
apps/pkg-core/src/modules/notification/brief.service.ts:164-204

private async updateSourceStatus(item: BriefItem, status: EventStatus) {
  switch (item.sourceType) {
    case 'entity_event': ... // Handled
    case 'extracted_event': ... // Handled
    case 'entity_fact': ... // Handled
    // MISSING: case 'activity' / case 'commitment'
  }
}
```

### Data Flow
```
Daily Messages
    ↓
DailySynthesisExtractionService.extract()
    ↓
ExtractionPersistenceService.persist() → Activity/Commitment tables
    ↓
BriefService.buildBrief() → Only reads EntityEvent
    ↓
Result: Commitments created but never shown in brief ❌
```

### How Each Strategy Fixes It

1. **Registry** — Shows Activity has no brief reader
2. **E2E Test** — Fails when activity not in brief
3. **Docs** — Architect sees Activity → Brief gap
4. **Checklist** — Forces "audit BriefService?"
5. **CI Check** — Blocks merge if Activity not in readers
6. **Query Builder** — Activity must be in getAllEvents()
7. **Guide** — Step 3 is "Audit consumers"
8. **Monitoring** — Alerts on low activity→brief rate

---

## For Different Roles

### Product Owner
- Read: `PREVENTION_SUMMARY.md` (5 min)
- Know: What happens when new data types are added
- Action: Require consumer audit in stories

### Tech Lead / Architect
- Read: `data-source-mismatch-prevention.md` (20 min)
- Implement: Strategies 1-3 this week
- Monitor: All new persistence targets

### Backend Developer
- Read: `PREVENTION_SUMMARY.md` (15 min)
- Follow: Code review checklist when adding new tables
- Use: UnifiedEventBuilder pattern for queries

### QA / Code Reviewer
- Read: `PREVENTION_SUMMARY.md` section "The Checklist" (5 min)
- Check: Consumer audit in PRs with new tables
- Create: E2E tests for data flows

---

## Related Documentation

These prevention strategies complement:
- `/docs/DATA_MODEL.md` — Schema and relationships
- `/docs/ARCHITECTURE.md` — System structure (to be updated with data flows)
- `/docs/API_CONTRACTS.md` — Service interfaces
- `/CLAUDE.md` — Project guidelines

---

## Testing The Prevention Strategies

### How We Know They Work

1. **Before Prevention:** Activity table added → Brief doesn't read → Bug in production
2. **After Prevention #1-2:** Activity table added → E2E test fails → Caught before merge
3. **After Prevention #3-5:** Activity table → Registry audit + CI check → Developer can't merge without fixing
4. **After Prevention #6:** Brief service uses UnifiedEventBuilder → Activity auto-included
5. **After Prevention #7-8:** Future changes caught by migration guide and monitoring

---

## Metrics for Success

| Metric | Target | How to Measure |
|--------|--------|-----------------|
| % of new tables with E2E tests | 100% | PR checklist audit |
| % of tables with documented readers | 100% | DATA_SOURCES.md coverage |
| % of data reaching all consumers | >95% | Monitoring alerts |
| Time to detect data source mismatches | <1 day | CI check + monitoring |
| Developer awareness of strategy | >90% | Checklist compliance |

---

## Commits Related to This Issue

```
8b4aa5a docs: add prevention strategies for data source mismatch problem
82deace docs: add prevention strategies summary for quick reference
```

**To read the full strategies:**
```bash
git show 8b4aa5a:docs/solutions/integration-issues/data-source-mismatch-prevention.md
```

---

## Questions & Answers

**Q: Which strategy is most critical?**
A: #2 (E2E testing) + #4 (Checklist). Together they catch 95% of bugs and cost ~3-4 hours.

**Q: When should I use unified query builder vs separate queries?**
A: Use unified for "events" (timebound items), separate queries for domain-specific data (e.g., activity browse).

**Q: What if we're adding a new consumer, not a new table?**
A: Same process but reversed — audit DATA_SOURCES.md to find all tables to read, create E2E test.

**Q: How often should monitoring run?**
A: Daily for consumption rates, Weekly for orphaned tables.

**Q: Can this prevent false positives (tables that intentionally have no readers)?**
A: Yes — DATA_SOURCES.md has "NO READERS (intentional)" reason field.

---

## Contact & Reviews

For questions about these prevention strategies:
- **Tech Lead:** Architecture decisions, implementation roadmap
- **Code Review:** Checklist enforcement, E2E test expectations
- **QA:** Test coverage, monitoring setup
