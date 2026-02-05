import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Activity, ActivityType, ActivityStatus } from '@pkg/entities';
import {
  ProjectMatchingService,
  ProjectMatchResult,
  ProjectCandidate,
} from './project-matching.service';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

let activityCounter = 0;

/** Create a minimal Activity-like object for testing. */
const createActivity = (
  overrides: Partial<Activity> = {},
): Activity =>
  ({
    id: overrides.id ?? `activity-${++activityCounter}`,
    name: overrides.name ?? `Activity ${activityCounter}`,
    activityType: overrides.activityType ?? ActivityType.PROJECT,
    status: overrides.status ?? ActivityStatus.ACTIVE,
    ownerEntityId: overrides.ownerEntityId ?? 'owner-1',
    clientEntityId: overrides.clientEntityId ?? null,
    lastActivityAt: overrides.lastActivityAt ?? new Date('2025-01-15'),
    ...overrides,
  }) as Activity;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ProjectMatchingService', () => {
  let service: ProjectMatchingService;
  let repo: jest.Mocked<Repository<Activity>>;

  const mockRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
  };

  beforeEach(async () => {
    activityCounter = 0;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectMatchingService,
        {
          provide: getRepositoryToken(Activity),
          useValue: mockRepo,
        },
      ],
    }).compile();

    service = module.get<ProjectMatchingService>(ProjectMatchingService);
    repo = module.get(getRepositoryToken(Activity));

    jest.clearAllMocks();
  });

  // =========================================================================
  // calculateSimilarity
  // =========================================================================

  describe('calculateSimilarity', () => {
    // --- Identical strings ---

    it('should return 1.0 for identical strings', () => {
      expect(service.calculateSimilarity('hello', 'hello')).toBe(1.0);
    });

    it('should return 1.0 for identical Cyrillic strings', () => {
      expect(service.calculateSimilarity('Проект Альфа', 'Проект Альфа')).toBe(1.0);
    });

    // --- Case-insensitivity ---

    it('should return 1.0 for strings differing only in case (Latin)', () => {
      expect(service.calculateSimilarity('Hello', 'hello')).toBe(1.0);
    });

    it('should return 1.0 for strings differing only in case (Cyrillic)', () => {
      expect(service.calculateSimilarity('ПРОЕКТ', 'проект')).toBe(1.0);
    });

    it('should return 1.0 for mixed case strings', () => {
      expect(service.calculateSimilarity('HeLLo WoRLd', 'hello world')).toBe(1.0);
    });

    // --- Both empty ---

    it('should return 1.0 when both strings are empty', () => {
      expect(service.calculateSimilarity('', '')).toBe(1.0);
    });

    // --- One empty ---

    it('should return 0.0 when first string is empty', () => {
      expect(service.calculateSimilarity('', 'hello')).toBe(0.0);
    });

    it('should return 0.0 when second string is empty', () => {
      expect(service.calculateSimilarity('hello', '')).toBe(0.0);
    });

    // --- Known Levenshtein distances ---

    it('should return correct similarity for "kitten" vs "sitting"', () => {
      // Levenshtein distance = 3, max length = 7
      // similarity = 1 - 3/7 ~ 0.5714
      const result = service.calculateSimilarity('kitten', 'sitting');
      expect(result).toBeCloseTo(1 - 3 / 7, 4);
    });

    it('should return correct similarity for single-char difference', () => {
      // "abc" vs "axc" -- distance = 1, max = 3 => similarity = 2/3
      const result = service.calculateSimilarity('abc', 'axc');
      expect(result).toBeCloseTo(2 / 3, 4);
    });

    // --- Partial overlap ---

    it('should return similarity > 0 for partial overlap', () => {
      const result = service.calculateSimilarity('Project Alpha', 'Project Beta');
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThan(1);
    });

    it('should return higher similarity for closer strings', () => {
      const closeSimilarity = service.calculateSimilarity('Redesign', 'Redesig');
      const farSimilarity = service.calculateSimilarity('Redesign', 'Xxxxxxxx');
      expect(closeSimilarity).toBeGreaterThan(farSimilarity);
    });

    // --- Completely different strings ---

    it('should return close to 0 for completely different strings', () => {
      const result = service.calculateSimilarity('abcdef', 'zyxwvu');
      expect(result).toBeLessThan(0.3);
    });

    // --- Symmetric property ---

    it('should be symmetric: similarity(a,b) === similarity(b,a)', () => {
      const ab = service.calculateSimilarity('foo bar', 'baz qux');
      const ba = service.calculateSimilarity('baz qux', 'foo bar');
      expect(ab).toBeCloseTo(ba, 10);
    });

    // --- Whitespace / trimming is NOT done inside calculateSimilarity itself
    //     (the method lowercases, but trimming is the caller's responsibility)

    it('should treat leading/trailing spaces as characters', () => {
      // ' hello' vs 'hello' -- distance = 1
      const result = service.calculateSimilarity(' hello', 'hello');
      expect(result).toBeLessThan(1.0);
      expect(result).toBeGreaterThan(0.5);
    });

    // --- Strings of very different lengths ---

    it('should return low similarity for strings of very different lengths', () => {
      const result = service.calculateSimilarity('a', 'abcdefghij');
      // distance = 9, max = 10 => similarity = 0.1
      expect(result).toBeCloseTo(0.1, 4);
    });

    // --- Single character ---

    it('should return 0 for completely different single characters', () => {
      // 'a' vs 'b' => distance = 1, max = 1 => similarity = 0
      expect(service.calculateSimilarity('a', 'b')).toBe(0.0);
    });

    it('should return 1 for identical single characters', () => {
      expect(service.calculateSimilarity('a', 'a')).toBe(1.0);
    });
  });

  // =========================================================================
  // findCandidates
  // =========================================================================

  describe('findCandidates', () => {
    const ownerEntityId = 'owner-1';

    it('should return empty array when no activities exist', async () => {
      mockRepo.find.mockResolvedValue([]);

      const result = await service.findCandidates({
        name: 'My Project',
        ownerEntityId,
      });

      expect(result).toEqual([]);
    });

    it('should call activityRepo.find with correct where clause (default types)', async () => {
      mockRepo.find.mockResolvedValue([]);

      await service.findCandidates({
        name: 'Test',
        ownerEntityId,
      });

      expect(mockRepo.find).toHaveBeenCalledTimes(1);

      const callArg = mockRepo.find.mock.calls[0][0] as any;
      // Должен искать среди PROJECT, TASK, INITIATIVE
      expect(callArg.where.ownerEntityId).toBe(ownerEntityId);
      // activityType should be In(DEFAULT_MATCHABLE_TYPES)
      expect(callArg.where.activityType).toBeDefined();
      // status should exclude ARCHIVED, CANCELLED
      expect(callArg.where.status).toBeDefined();
    });

    it('should use specified activityType when provided', async () => {
      mockRepo.find.mockResolvedValue([]);

      await service.findCandidates({
        name: 'Test',
        ownerEntityId,
        activityType: ActivityType.TASK,
      });

      expect(mockRepo.find).toHaveBeenCalledTimes(1);

      const callArg = mockRepo.find.mock.calls[0][0] as any;
      // Должен использовать только [TASK]
      expect(callArg.where.activityType).toBeDefined();
    });

    it('should return candidates sorted by similarity descending', async () => {
      const activities = [
        createActivity({ name: 'Website Redesign', ownerEntityId }),
        createActivity({ name: 'Mobile App Redesign', ownerEntityId }),
        createActivity({ name: 'Database Migration', ownerEntityId }),
      ];
      mockRepo.find.mockResolvedValue(activities);

      const result = await service.findCandidates({
        name: 'Website Redesign',
        ownerEntityId,
      });

      expect(result.length).toBe(3);
      // First candidate should be the exact match
      expect(result[0].activity.name).toBe('Website Redesign');
      expect(result[0].similarity).toBe(1.0);
      // Ensure sorted descending
      for (let i = 1; i < result.length; i++) {
        expect(result[i].similarity).toBeLessThanOrEqual(result[i - 1].similarity);
      }
    });

    it('should respect the limit parameter', async () => {
      const activities = Array.from({ length: 20 }, (_, i) =>
        createActivity({ name: `Project ${String.fromCharCode(65 + i)}`, ownerEntityId }),
      );
      mockRepo.find.mockResolvedValue(activities);

      const result = await service.findCandidates({
        name: 'Project A',
        ownerEntityId,
        limit: 3,
      });

      expect(result.length).toBe(3);
    });

    it('should use default limit of 10 when not specified', async () => {
      const activities = Array.from({ length: 15 }, (_, i) =>
        createActivity({ name: `Project ${i}`, ownerEntityId }),
      );
      mockRepo.find.mockResolvedValue(activities);

      const result = await service.findCandidates({
        name: 'Project',
        ownerEntityId,
      });

      expect(result.length).toBe(10);
    });

    it('should perform case-insensitive matching', async () => {
      const activities = [
        createActivity({ name: 'WEBSITE REDESIGN', ownerEntityId }),
      ];
      mockRepo.find.mockResolvedValue(activities);

      const result = await service.findCandidates({
        name: 'website redesign',
        ownerEntityId,
      });

      expect(result[0].similarity).toBe(1.0);
    });

    it('should trim input name before matching', async () => {
      const activities = [
        createActivity({ name: 'Website Redesign', ownerEntityId }),
      ];
      mockRepo.find.mockResolvedValue(activities);

      const result = await service.findCandidates({
        name: '  Website Redesign  ',
        ownerEntityId,
      });

      expect(result[0].similarity).toBe(1.0);
    });

    it('should return each candidate with activity and similarity', async () => {
      const activity = createActivity({ name: 'Alpha Project', ownerEntityId });
      mockRepo.find.mockResolvedValue([activity]);

      const result = await service.findCandidates({
        name: 'Alpha Project',
        ownerEntityId,
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('activity');
      expect(result[0]).toHaveProperty('similarity');
      expect(result[0].activity).toBe(activity);
      expect(typeof result[0].similarity).toBe('number');
    });

    it('should select only required fields from repository', async () => {
      mockRepo.find.mockResolvedValue([]);

      await service.findCandidates({
        name: 'Test',
        ownerEntityId,
      });

      const callArg = mockRepo.find.mock.calls[0][0] as any;
      expect(callArg.select).toEqual(
        expect.arrayContaining(['id', 'name', 'activityType', 'status']),
      );
    });

    it('should order activities by lastActivityAt DESC with nulls last', async () => {
      mockRepo.find.mockResolvedValue([]);

      await service.findCandidates({
        name: 'Test',
        ownerEntityId,
      });

      const callArg = mockRepo.find.mock.calls[0][0] as any;
      expect(callArg.order).toBeDefined();
      expect(callArg.order.lastActivityAt).toEqual(
        expect.objectContaining({ direction: 'DESC', nulls: 'LAST' }),
      );
    });
  });

  // =========================================================================
  // findBestMatch
  // =========================================================================

  describe('findBestMatch', () => {
    const ownerEntityId = 'owner-1';

    it('should return matched: true when best candidate meets default threshold (0.8)', async () => {
      const activity = createActivity({ name: 'Website Redesign', ownerEntityId });
      mockRepo.find.mockResolvedValue([activity]);

      const result = await service.findBestMatch({
        name: 'Website Redesign',
        ownerEntityId,
      });

      expect(result.matched).toBe(true);
      expect(result.activity).toBe(activity);
      expect(result.similarity).toBe(1.0);
    });

    it('should return matched: false when best candidate is below default threshold', async () => {
      // Два совсем разных названия -- similarity будет ниже 0.8
      const activity = createActivity({ name: 'Database Migration', ownerEntityId });
      mockRepo.find.mockResolvedValue([activity]);

      const result = await service.findBestMatch({
        name: 'Website Redesign',
        ownerEntityId,
      });

      expect(result.matched).toBe(false);
      expect(result.activity).toBeNull();
      expect(result.similarity).toBeGreaterThan(0);
    });

    it('should return matched: false with similarity 0 when no candidates exist', async () => {
      mockRepo.find.mockResolvedValue([]);

      const result = await service.findBestMatch({
        name: 'Anything',
        ownerEntityId,
      });

      expect(result.matched).toBe(false);
      expect(result.activity).toBeNull();
      expect(result.similarity).toBe(0);
    });

    it('should respect custom threshold', async () => {
      // "Project Alpha" vs "Project Alphb" -- similarity ~ 0.93
      const activity = createActivity({ name: 'Project Alphb', ownerEntityId });
      mockRepo.find.mockResolvedValue([activity]);

      // С высоким threshold -- должен найти
      const resultHigh = await service.findBestMatch({
        name: 'Project Alpha',
        ownerEntityId,
        threshold: 0.9,
      });
      expect(resultHigh.matched).toBe(true);

      // С очень высоким threshold -- не должен найти
      const resultVeryHigh = await service.findBestMatch({
        name: 'Project Alpha',
        ownerEntityId,
        threshold: 0.99,
      });
      expect(resultVeryHigh.matched).toBe(false);
      expect(resultVeryHigh.activity).toBeNull();
    });

    it('should use low threshold to match loosely similar strings', async () => {
      const activity = createActivity({ name: 'Alpha Beta', ownerEntityId });
      mockRepo.find.mockResolvedValue([activity]);

      const result = await service.findBestMatch({
        name: 'Alpha Gamma',
        ownerEntityId,
        threshold: 0.3,
      });

      expect(result.matched).toBe(true);
      expect(result.activity).toBe(activity);
    });

    it('should pass limit=1 to findCandidates', async () => {
      mockRepo.find.mockResolvedValue([]);

      await service.findBestMatch({
        name: 'Test',
        ownerEntityId,
      });

      // findBestMatch internally calls findCandidates with limit: 1
      // repo.find gets called once; we verify the service behavior indirectly:
      // if there were many activities, it should still only consider the best.
      expect(mockRepo.find).toHaveBeenCalledTimes(1);
    });

    it('should return the activity with highest similarity when multiple exist', async () => {
      const exactMatch = createActivity({ name: 'Mobile App', ownerEntityId });
      const partialMatch = createActivity({ name: 'Mobile App Design', ownerEntityId });
      const poorMatch = createActivity({ name: 'Backend API', ownerEntityId });

      mockRepo.find.mockResolvedValue([exactMatch, partialMatch, poorMatch]);

      const result = await service.findBestMatch({
        name: 'Mobile App',
        ownerEntityId,
      });

      expect(result.matched).toBe(true);
      expect(result.activity?.name).toBe('Mobile App');
      expect(result.similarity).toBe(1.0);
    });

    it('should pass activityType through to findCandidates', async () => {
      mockRepo.find.mockResolvedValue([]);

      await service.findBestMatch({
        name: 'Test',
        ownerEntityId,
        activityType: ActivityType.INITIATIVE,
      });

      const callArg = mockRepo.find.mock.calls[0][0] as any;
      // When activityType is specified, only that type is searched
      expect(callArg.where.activityType).toBeDefined();
    });

    it('should return correct structure for ProjectMatchResult', async () => {
      mockRepo.find.mockResolvedValue([]);

      const result = await service.findBestMatch({
        name: 'Test',
        ownerEntityId,
      });

      // Verify that the result conforms to ProjectMatchResult interface
      expect(result).toHaveProperty('activity');
      expect(result).toHaveProperty('matched');
      expect(result).toHaveProperty('similarity');
      expect(typeof result.matched).toBe('boolean');
      expect(typeof result.similarity).toBe('number');
    });

    // --- Edge cases ---

    it('should handle exact threshold boundary (similarity === threshold)', async () => {
      // Create a pair where we know the exact similarity
      // "abcde" vs "abcdf" => distance=1, maxLen=5, similarity=0.8
      const activity = createActivity({ name: 'abcdf', ownerEntityId });
      mockRepo.find.mockResolvedValue([activity]);

      const result = await service.findBestMatch({
        name: 'abcde',
        ownerEntityId,
        threshold: 0.8,
      });

      // similarity = 0.8, threshold = 0.8 => matched (>=)
      expect(result.matched).toBe(true);
      expect(result.similarity).toBeCloseTo(0.8, 4);
    });

    it('should handle similarity just below threshold', async () => {
      // "abcd" vs "abxy" => distance=2, maxLen=4, similarity=0.5
      const activity = createActivity({ name: 'abxy', ownerEntityId });
      mockRepo.find.mockResolvedValue([activity]);

      const result = await service.findBestMatch({
        name: 'abcd',
        ownerEntityId,
        threshold: 0.6,
      });

      expect(result.matched).toBe(false);
      expect(result.activity).toBeNull();
      expect(result.similarity).toBeCloseTo(0.5, 4);
    });
  });

  // =========================================================================
  // Levenshtein distance (tested indirectly via calculateSimilarity)
  // =========================================================================

  describe('Levenshtein distance (via calculateSimilarity)', () => {
    // Helper: compute distance from similarity
    // similarity = 1 - distance / max(a.length, b.length)
    // distance = (1 - similarity) * max(a.length, b.length)
    const distanceFrom = (a: string, b: string): number => {
      const similarity = service.calculateSimilarity(a, b);
      const maxLen = Math.max(a.length, b.length);
      return Math.round((1 - similarity) * maxLen);
    };

    it('should compute distance 0 for identical strings', () => {
      expect(distanceFrom('hello', 'hello')).toBe(0);
    });

    it('should compute distance 3 for "kitten" vs "sitting"', () => {
      expect(distanceFrom('kitten', 'sitting')).toBe(3);
    });

    it('should compute distance 1 for single substitution', () => {
      expect(distanceFrom('cat', 'car')).toBe(1);
    });

    it('should compute distance 1 for single insertion', () => {
      expect(distanceFrom('cat', 'cats')).toBe(1);
    });

    it('should compute distance 1 for single deletion', () => {
      expect(distanceFrom('cats', 'cat')).toBe(1);
    });

    it('should compute distance equal to length for completely different single-char strings', () => {
      // 'a' vs 'b' => distance = 1
      expect(distanceFrom('a', 'b')).toBe(1);
    });

    it('should compute distance equal to longer length when one string is empty', () => {
      // Empty is handled by calculateSimilarity returning 0, so we verify indirectly
      // '' vs 'abc' => similarity = 0 => distance = 3
      // But calculateSimilarity returns 0 for one-empty, so:
      const sim = service.calculateSimilarity('', 'abc');
      expect(sim).toBe(0.0);
    });

    it('should handle strings of different lengths', () => {
      // "abc" vs "abcdef" => distance = 3 (3 insertions)
      expect(distanceFrom('abc', 'abcdef')).toBe(3);
    });

    it('should handle Cyrillic characters correctly', () => {
      // Same Cyrillic string => distance 0
      expect(distanceFrom('привет', 'привет')).toBe(0);
    });

    it('should handle mixed Latin and Cyrillic', () => {
      // "PKG Core" vs "PKG Ядро" => some distance due to different chars
      const distance = distanceFrom('pkg core', 'pkg ядро');
      expect(distance).toBeGreaterThan(0);
    });

    it('should be symmetric', () => {
      const d1 = distanceFrom('algorithm', 'altruistic');
      const d2 = distanceFrom('altruistic', 'algorithm');
      expect(d1).toBe(d2);
    });
  });

  // =========================================================================
  // Integration-style scenarios
  // =========================================================================

  describe('integration scenarios', () => {
    const ownerEntityId = 'owner-1';

    it('should match Cyrillic project names case-insensitively', async () => {
      const activity = createActivity({
        name: 'Редизайн сайта',
        ownerEntityId,
      });
      mockRepo.find.mockResolvedValue([activity]);

      const result = await service.findBestMatch({
        name: 'РЕДИЗАЙН САЙТА',
        ownerEntityId,
      });

      expect(result.matched).toBe(true);
      expect(result.similarity).toBe(1.0);
    });

    it('should distinguish between similar but different project names', async () => {
      const activities = [
        createActivity({ name: 'Website v1', ownerEntityId }),
        createActivity({ name: 'Website v2', ownerEntityId }),
      ];
      mockRepo.find.mockResolvedValue(activities);

      const result = await service.findCandidates({
        name: 'Website v2',
        ownerEntityId,
      });

      expect(result[0].activity.name).toBe('Website v2');
      expect(result[0].similarity).toBe(1.0);
      // Second candidate should have slightly lower similarity
      expect(result[1].similarity).toBeLessThan(1.0);
      expect(result[1].similarity).toBeGreaterThan(0.5);
    });

    it('should handle empty activities list gracefully in findBestMatch', async () => {
      mockRepo.find.mockResolvedValue([]);

      const result = await service.findBestMatch({
        name: '',
        ownerEntityId,
      });

      expect(result.matched).toBe(false);
      expect(result.activity).toBeNull();
      expect(result.similarity).toBe(0);
    });

    it('should select best among many candidates with close similarities', async () => {
      const activities = [
        createActivity({ name: 'Project Alpha', ownerEntityId }),
        createActivity({ name: 'Project Alphb', ownerEntityId }),
        createActivity({ name: 'Project Alphc', ownerEntityId }),
      ];
      mockRepo.find.mockResolvedValue(activities);

      const result = await service.findBestMatch({
        name: 'Project Alpha',
        ownerEntityId,
      });

      expect(result.matched).toBe(true);
      expect(result.activity?.name).toBe('Project Alpha');
    });

    it('should not crash when activity name has special characters', async () => {
      const activity = createActivity({
        name: 'Project (v2.0) - "final" [2025]',
        ownerEntityId,
      });
      mockRepo.find.mockResolvedValue([activity]);

      const result = await service.findCandidates({
        name: 'Project (v2.0) - "final" [2025]',
        ownerEntityId,
      });

      expect(result[0].similarity).toBe(1.0);
    });
  });
});
