import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, In } from 'typeorm';
import { Activity, ActivityType, ActivityStatus } from '@pkg/entities';

/**
 * Result of finding the best match for a project name.
 */
export interface ProjectMatchResult {
  /** Matched activity (or null if no match above threshold) */
  activity: Activity | null;
  /** Whether a match was found above the threshold */
  matched: boolean;
  /** Best similarity score (0 if no candidates found) */
  similarity: number;
}

/**
 * A candidate activity with its similarity score.
 */
export interface ProjectCandidate {
  activity: Activity;
  similarity: number;
}

/**
 * Default activity types considered matchable projects.
 */
const DEFAULT_MATCHABLE_TYPES: ActivityType[] = [
  ActivityType.PROJECT,
  ActivityType.TASK,
  ActivityType.INITIATIVE,
];

/**
 * Statuses that exclude an activity from matching (terminal states).
 */
const EXCLUDED_STATUSES: ActivityStatus[] = [
  ActivityStatus.ARCHIVED,
  ActivityStatus.CANCELLED,
];

/**
 * Default similarity threshold for considering a match valid.
 */
const DEFAULT_THRESHOLD = 0.8;

/**
 * ProjectMatchingService -- prevents duplicate project creation
 * by finding existing activities that match a given name.
 *
 * Matching strategy:
 * 1. Exact match (case-insensitive) -- similarity = 1.0
 * 2. Fuzzy match via normalized Levenshtein distance
 * 3. Return best candidate if similarity >= threshold
 *
 * This service does NOT create activities. It only searches.
 * Creation responsibility remains with the calling code.
 */
@Injectable()
export class ProjectMatchingService {
  /**
   * Normalize a project/activity name for comparison.
   *
   * Removes:
   * - Cost/amount annotations in parentheses, e.g. "(424.39₽)", "(1.5M RUB)"
   * - Leading/trailing whitespace
   * - Trailing punctuation
   * - Collapses multiple spaces into one
   *
   * Keeps the meaningful part of the name for matching.
   */
  static normalizeName(name: string): string {
    return name
      .trim()
      .toLowerCase()
      .replace(
        /\s*\([^)]*(?:₽|руб|rub|тыс|млн|usd|eur|\$|k\b|m\b)[^)]*\)/gi,
        '',
      )
      .replace(/\s+/g, ' ')
      .replace(/[.,;:!]+$/, '')
      .trim();
  }
  private readonly logger = new Logger(ProjectMatchingService.name);

  constructor(
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
  ) {}

  /**
   * Find the best matching existing activity for a given project name.
   *
   * Searches among active (non-archived, non-cancelled) activities
   * owned by the specified owner. Returns the best match if its
   * similarity score meets or exceeds the threshold.
   *
   * @returns ProjectMatchResult with matched=true if a match is found,
   *          or matched=false with activity=null if no match meets the threshold.
   */
  async findBestMatch(params: {
    name: string;
    ownerEntityId: string;
    activityType?: ActivityType;
    clientEntityId?: string;
    threshold?: number;
  }): Promise<ProjectMatchResult> {
    const threshold = params.threshold ?? DEFAULT_THRESHOLD;

    const candidates = await this.findCandidates({
      name: params.name,
      ownerEntityId: params.ownerEntityId,
      activityType: params.activityType,
      limit: 1,
    });

    if (candidates.length === 0) {
      this.logger.debug(
        `No candidates found for "${params.name}" (owner: ${params.ownerEntityId})`,
      );
      return { activity: null, matched: false, similarity: 0 };
    }

    const best = candidates[0];

    if (best.similarity >= threshold) {
      this.logger.log(
        `Matched "${params.name}" -> "${best.activity.name}" ` +
          `(similarity: ${best.similarity.toFixed(3)}, threshold: ${threshold})`,
      );
      return {
        activity: best.activity,
        matched: true,
        similarity: best.similarity,
      };
    }

    this.logger.debug(
      `Best candidate for "${params.name}" is "${best.activity.name}" ` +
        `(similarity: ${best.similarity.toFixed(3)}) but below threshold ${threshold}`,
    );
    return { activity: null, matched: false, similarity: best.similarity };
  }

  /**
   * Find candidate activities that could match the given name.
   *
   * Searches among activities of specified types (default: PROJECT, TASK, INITIATIVE)
   * with non-terminal statuses, owned by the given owner.
   * Each candidate is scored by normalized Levenshtein similarity.
   * Results are sorted by similarity descending.
   *
   * @returns Array of candidates sorted by similarity (highest first).
   */
  async findCandidates(params: {
    name: string;
    ownerEntityId: string;
    activityType?: ActivityType;
    limit?: number;
  }): Promise<ProjectCandidate[]> {
    const { name, ownerEntityId, activityType, limit = 10 } = params;

    // Determine which activity types to search
    const types = activityType ? [activityType] : DEFAULT_MATCHABLE_TYPES;

    // Fetch active activities for this owner with matching types
    const activities = await this.activityRepo.find({
      where: {
        ownerEntityId,
        activityType: In(types),
        status: Not(In(EXCLUDED_STATUSES)),
      },
      select: ['id', 'name', 'activityType', 'status', 'clientEntityId', 'lastActivityAt', 'description', 'tags'],
      order: { lastActivityAt: { direction: 'DESC', nulls: 'LAST' } },
    });

    if (activities.length === 0) {
      return [];
    }

    // Score each activity against the input name (normalized to strip cost annotations etc.)
    const normalizedName = ProjectMatchingService.normalizeName(name);
    const scored: ProjectCandidate[] = activities.map((activity) => ({
      activity,
      similarity: this.calculateSimilarity(
        normalizedName,
        ProjectMatchingService.normalizeName(activity.name),
      ),
    }));

    // Sort by similarity descending, then by lastActivityAt for ties
    scored.sort((a, b) => b.similarity - a.similarity);

    // Return top N candidates
    const result = scored.slice(0, limit);

    this.logger.debug(
      `Found ${activities.length} candidates for "${name}", ` +
        `top match: "${result[0]?.activity.name}" (${result[0]?.similarity.toFixed(3)})`,
    );

    return result;
  }

  /**
   * Find the best matching activity from an in-memory list (no DB query).
   *
   * Useful when activities are already loaded (e.g. in DailySynthesisExtraction).
   * Returns the best candidate with its similarity score, or null if no match.
   */
  findBestMatchInList(
    name: string,
    activities: Activity[],
  ): { activity: Activity; similarity: number } | null {
    if (activities.length === 0) return null;

    const normalizedName = ProjectMatchingService.normalizeName(name);
    let bestActivity: Activity | null = null;
    let bestSimilarity = 0;

    for (const activity of activities) {
      const similarity = this.calculateSimilarity(
        normalizedName,
        ProjectMatchingService.normalizeName(activity.name),
      );
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestActivity = activity;
      }
    }

    return bestActivity ? { activity: bestActivity, similarity: bestSimilarity } : null;
  }

  /**
   * Calculate similarity between two strings using normalized Levenshtein distance.
   *
   * Returns a value in [0, 1] where:
   * - 1.0 means the strings are identical (case-insensitive)
   * - 0.0 means the strings are completely different
   *
   * The formula is: 1 - (levenshteinDistance(a, b) / max(a.length, b.length))
   *
   * Special cases:
   * - Both empty strings -> 1.0
   * - One empty string -> 0.0
   */
  calculateSimilarity(a: string, b: string): number {
    const strA = a.toLowerCase();
    const strB = b.toLowerCase();

    if (strA === strB) return 1.0;
    if (strA.length === 0 || strB.length === 0) return 0.0;

    const distance = this.levenshteinDistance(strA, strB);
    const maxLen = Math.max(strA.length, strB.length);

    return 1 - distance / maxLen;
  }

  /**
   * Compute the Levenshtein distance between two strings.
   *
   * Uses the classic dynamic programming approach with O(min(m,n)) space
   * optimization (single row + previous row).
   */
  private levenshteinDistance(a: string, b: string): number {
    // Optimize: ensure `a` is the shorter string for space efficiency
    if (a.length > b.length) {
      [a, b] = [b, a];
    }

    const m = a.length;
    const n = b.length;

    // Edge cases
    if (m === 0) return n;

    // Use two rows for DP: previous and current
    let prevRow = new Array<number>(m + 1);
    let currRow = new Array<number>(m + 1);

    // Initialize first row: distance from empty string to a[0..j]
    for (let j = 0; j <= m; j++) {
      prevRow[j] = j;
    }

    for (let i = 1; i <= n; i++) {
      currRow[0] = i;

      for (let j = 1; j <= m; j++) {
        const cost = a[j - 1] === b[i - 1] ? 0 : 1;
        currRow[j] = Math.min(
          prevRow[j] + 1,      // deletion
          currRow[j - 1] + 1,  // insertion
          prevRow[j - 1] + cost, // substitution
        );
      }

      // Swap rows
      [prevRow, currRow] = [currRow, prevRow];
    }

    // Result is in prevRow after the last swap
    return prevRow[m];
  }
}
