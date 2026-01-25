/**
 * Confidence thresholds for AI-based decisions.
 *
 * These thresholds are used across the system for:
 * - Subject resolution (auto-resolve vs require confirmation)
 * - Fact approval (auto-approve vs pending)
 * - Entity matching decisions
 */
export const CONFIDENCE_THRESHOLDS = {
  /**
   * Threshold for auto-resolving subjects and auto-approving facts.
   * If confidence >= this value AND conditions are met, no user confirmation needed.
   */
  AUTO_RESOLVE: 0.8,

  /**
   * High confidence - reliable but may need verification for critical decisions.
   */
  HIGH: 0.7,

  /**
   * Medium confidence - should be reviewed but likely correct.
   */
  MEDIUM: 0.5,

  /**
   * Low confidence - likely needs manual review or correction.
   */
  LOW: 0.3,
} as const;

export type ConfidenceLevel = keyof typeof CONFIDENCE_THRESHOLDS;

/**
 * Returns the confidence level name for a given confidence value.
 */
export function getConfidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence >= CONFIDENCE_THRESHOLDS.AUTO_RESOLVE) return 'AUTO_RESOLVE';
  if (confidence >= CONFIDENCE_THRESHOLDS.HIGH) return 'HIGH';
  if (confidence >= CONFIDENCE_THRESHOLDS.MEDIUM) return 'MEDIUM';
  return 'LOW';
}

/**
 * Bonus added to confidence when there's an exact name match.
 * Used in subject resolution to favor exact matches over partial.
 */
export const EXACT_MATCH_CONFIDENCE_BONUS = 0.2;
