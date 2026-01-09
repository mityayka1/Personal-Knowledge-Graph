# Changelog

## [Unreleased] - feat/web-dashboard

### Added
- **Web Dashboard** (Nuxt 3 + shadcn-vue)
  - Entity management: list, view, create, edit, delete
  - Fact management: add/remove facts on entity detail page
  - Interaction list with pagination
  - Search page with hybrid search (FTS + vector)
  - Context generation page
  - Resolution page with entity linking
  - Interactions view on resolution page
  - Facts review page

- **API Endpoints**
  - `GET /interactions/by-identifier` - find interactions by identifier
  - `POST /entities/:id/facts` - add fact to entity
  - `DELETE /entities/:id/facts/:factId` - remove fact from entity

- **Unit Tests** (59 tests)
  - EntityService and EntityController
  - SearchService and SearchController
  - PendingResolutionService and PendingResolutionController
  - InteractionService and InteractionController

- **Telegram History Import**
  - Import messages from Telegram JSON export
  - Session grouping (4 hour gap threshold)
  - Participant extraction with metadata

- **Fact Extraction** (Claude CLI)
  - FactExtractionService with Claude CLI subprocess call
  - Token-optimized prompts with fact-extractor agent
  - Batch extraction for multiple messages
  - Haiku model for cost efficiency
  - 30 second timeout with graceful handling

### Technical
- Dialog component with ClientOnly + Teleport fix
- Jest configuration for pkg-core
- API proxy routes in Nuxt for backend integration
- fact-extractor.md subagent for structured extraction

---

## Commits

| Hash | Description |
|------|-------------|
| `6f17a90` | feat: Add fact extraction service with Claude CLI integration |
| `3969d88` | feat: Add interactions view to resolution page |
| `32e928a` | feat: Add fact management to entity detail page |
| `fdd7ee0` | test: Add unit tests for Entity, Search, and Resolution modules |
| `1ce44e5` | feat: Add entity edit page and interaction tests |
| `26c60b6` | feat: Add web dashboard and Telegram history import |
