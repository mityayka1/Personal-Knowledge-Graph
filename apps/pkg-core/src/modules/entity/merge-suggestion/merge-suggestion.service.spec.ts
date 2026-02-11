import { MergeSuggestionService } from './merge-suggestion.service';

describe('MergeSuggestionService', () => {
  let service: MergeSuggestionService;

  const mockEntityRepo = {
    query: jest.fn(),
    findOne: jest.fn(),
  };
  const mockIdentifierRepo = {
    find: jest.fn().mockResolvedValue([]),
  };
  const mockFactRepo = {};
  const mockDismissedRepo = {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };
  const mockDataSource = {
    transaction: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();

    service = new MergeSuggestionService(
      mockEntityRepo as any,
      mockIdentifierRepo as any,
      mockFactRepo as any,
      mockDismissedRepo as any,
      mockDataSource as any,
    );
  });

  describe('getSuggestions', () => {
    it('should return empty when no suggestions from either strategy', async () => {
      // Both strategies return no rows
      mockEntityRepo.query.mockResolvedValue([]);

      const result = await service.getSuggestions();

      expect(result.groups).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should return orphan Telegram suggestions', async () => {
      // First call: orphan telegram suggestions
      mockEntityRepo.query.mockResolvedValueOnce([
        {
          orphan_id: 'orphan-1',
          orphan_name: 'Telegram 12345',
          orphan_created_at: new Date('2025-01-01'),
          telegram_user_id: '12345',
          primary_id: 'primary-1',
          primary_name: 'Иван',
          primary_type: 'person',
          primary_profile_photo: null,
          total_groups: '1',
        },
      ]);
      // Second call: identifier-based suggestions (none)
      mockEntityRepo.query.mockResolvedValueOnce([]);
      // Message counts batch
      mockEntityRepo.query.mockResolvedValueOnce([
        { entity_id: 'orphan-1', count: '5' },
      ]);

      const result = await service.getSuggestions();

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].reason).toBe('orphaned_telegram_id');
      expect(result.groups[0].primaryEntity.name).toBe('Иван');
      expect(result.groups[0].candidates[0].name).toBe('Telegram 12345');
    });

    it('should return identifier-based suggestions (username match)', async () => {
      // First call: orphan telegram suggestions (none)
      mockEntityRepo.query.mockResolvedValueOnce([]);
      // Second call: identifier-based suggestions
      mockEntityRepo.query.mockResolvedValueOnce([
        {
          candidate_id: 'candidate-1',
          candidate_name: 'vasunya91',
          candidate_created_at: new Date('2025-02-01'),
          matched_value: 'vasunya91',
          primary_id: 'primary-aleksandra',
          primary_name: 'Александра',
          primary_type: 'person',
          primary_profile_photo: null,
          total_groups: '1',
        },
      ]);
      // Message counts batch for identifier-based
      mockEntityRepo.query.mockResolvedValueOnce([]);

      mockIdentifierRepo.find.mockResolvedValue([
        {
          entityId: 'primary-aleksandra',
          id: 'ident-1',
          identifierType: 'telegram_username',
          identifierValue: 'vasunya91',
        },
      ]);

      const result = await service.getSuggestions();

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].reason).toBe('shared_identifier');
      expect(result.groups[0].primaryEntity.name).toBe('Александра');
      expect(result.groups[0].candidates[0].name).toBe('vasunya91');
      expect(result.groups[0].primaryEntity.identifiers).toEqual([
        expect.objectContaining({ identifierType: 'telegram_username', identifierValue: 'vasunya91' }),
      ]);
    });

    it('should combine and dedup groups from both strategies', async () => {
      // Orphan suggestions: primary-1 with one orphan
      mockEntityRepo.query.mockResolvedValueOnce([
        {
          orphan_id: 'orphan-1',
          orphan_name: 'Telegram 99999',
          orphan_created_at: new Date('2025-01-01'),
          telegram_user_id: '99999',
          primary_id: 'primary-1',
          primary_name: 'Пётр',
          primary_type: 'person',
          primary_profile_photo: null,
          total_groups: '1',
        },
      ]);
      // Identifier-based: same primary-1 with a username candidate
      mockEntityRepo.query.mockResolvedValueOnce([
        {
          candidate_id: 'candidate-username',
          candidate_name: 'petr_dev',
          candidate_created_at: new Date('2025-02-01'),
          matched_value: 'petr_dev',
          primary_id: 'primary-1',
          primary_name: 'Пётр',
          primary_type: 'person',
          primary_profile_photo: null,
          total_groups: '1',
        },
      ]);
      // Message counts batches (2 calls — one per strategy)
      mockEntityRepo.query.mockResolvedValueOnce([{ entity_id: 'orphan-1', count: '3' }]);
      mockEntityRepo.query.mockResolvedValueOnce([{ entity_id: 'candidate-username', count: '0' }]);

      mockIdentifierRepo.find.mockResolvedValue([
        {
          entityId: 'primary-1',
          id: 'ident-1',
          identifierType: 'telegram_username',
          identifierValue: 'petr_dev',
        },
      ]);

      const result = await service.getSuggestions();

      // Should merge into single group for primary-1
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].primaryEntity.id).toBe('primary-1');
      // Both candidates under same group
      expect(result.groups[0].candidates).toHaveLength(2);
      const candidateNames = result.groups[0].candidates.map((c) => c.name);
      expect(candidateNames).toContain('Telegram 99999');
      expect(candidateNames).toContain('petr_dev');
    });
  });
});
