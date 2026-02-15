/**
 * FusionAction enum for the extraction pipeline.
 *
 * Re-exports from fact-fusion.constants.ts to maintain single source of truth.
 * This file exists in the extraction module for discoverability and follows
 * the task specification for Smart Fusion integration.
 *
 * Actions:
 * - CREATE:    New fact, no duplicates found
 * - SKIP:      Exact duplicate, nothing to do
 * - CONFIRM:   Same info from new source, boost confidence
 * - SUPERSEDE: New value replaces old (more specific/recent)
 * - ENRICH:    Complementary info, merge into richer fact
 * - CONFLICT:  Contradictory, requires human review
 * - COEXIST:   Both valid (different time periods)
 */
export { FusionAction } from '../entity/entity-fact/fact-fusion.constants';

/**
 * Extended fusion actions specific to the extraction pipeline.
 * Adds CREATE and SKIP which are pipeline-level decisions (not LLM fusion decisions).
 */
export enum ExtractionFusionAction {
  /** New fact -- no duplicates found in the system */
  CREATE = 'create',
  /** Exact duplicate -- skip entirely */
  SKIP = 'skip',
  /** Confirmation -- same info, boost confidence */
  CONFIRM = 'confirm',
  /** Replacement -- new value supersedes old */
  SUPERSEDE = 'supersede',
  /** Enrichment -- complementary info merged */
  ENRICH = 'enrich',
  /** Conflict -- contradictory, needs human review */
  CONFLICT = 'conflict',
  /** Coexist -- both valid (different periods) */
  COEXIST = 'coexist',
}
