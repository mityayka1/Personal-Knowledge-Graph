import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ExtractedEvent,
  ExtractedEventType,
  ExtractedEventStatus,
  Message,
} from '@pkg/entities';
import { ContextEnrichmentService } from './context-enrichment.service';

// Mock ClaudeAgentService to avoid ESM import issues
const mockClaudeAgentService = {
  call: jest.fn(),
};

jest.mock('../claude-agent/claude-agent.service', () => ({
  ClaudeAgentService: jest.fn().mockImplementation(() => mockClaudeAgentService),
}));

// Mock SearchService
const mockSearchService = {
  search: jest.fn(),
};

jest.mock('../search/search.service', () => ({
  SearchService: jest.fn().mockImplementation(() => mockSearchService),
}));

// Import after mocks
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';
import { SearchService } from '../search/search.service';

describe('ContextEnrichmentService', () => {
  let service: ContextEnrichmentService;
  let extractedEventRepo: jest.Mocked<Repository<ExtractedEvent>>;

  // Abstract event that needs enrichment (e.g., "приступлю к задаче")
  const mockAbstractEvent: Partial<ExtractedEvent> = {
    id: 'abstract-event-id',
    sourceMessageId: 'msg-123',
    entityId: 'entity-456',
    eventType: ExtractedEventType.PROMISE_BY_ME,
    extractedData: { what: 'приступить к задаче' },
    sourceQuote: 'приступлю к задаче',
    confidence: 0.85,
    status: ExtractedEventStatus.PENDING,
    needsContext: false,
    linkedEventId: null,
    enrichmentData: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Concrete candidate event (e.g., "подготовить отчёт Q4")
  const mockCandidateEvent: Partial<ExtractedEvent> = {
    id: 'candidate-event-id',
    sourceMessageId: 'msg-100',
    entityId: 'entity-456',
    eventType: ExtractedEventType.TASK,
    extractedData: { what: 'подготовить отчёт Q4' },
    sourceQuote: 'подготовь отчёт Q4 до конца недели',
    confidence: 0.9,
    status: ExtractedEventStatus.PENDING,
    needsContext: false,
    linkedEventId: null,
    enrichmentData: null,
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContextEnrichmentService,
        {
          provide: getRepositoryToken(ExtractedEvent),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            update: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Message),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: ClaudeAgentService,
          useValue: mockClaudeAgentService,
        },
        {
          provide: SearchService,
          useValue: mockSearchService,
        },
      ],
    }).compile();

    service = module.get<ContextEnrichmentService>(ContextEnrichmentService);
    extractedEventRepo = module.get(getRepositoryToken(ExtractedEvent));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('enrichEvent', () => {
    it('should link abstract event to concrete event when context is found', async () => {
      // Setup: search returns related messages
      mockSearchService.search.mockResolvedValue({
        results: [
          {
            id: 'msg-100',
            content: 'Нужно подготовить отчёт Q4 до конца недели',
            timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
          },
        ],
      });

      // Setup: find candidate events
      extractedEventRepo.find.mockResolvedValue([mockCandidateEvent as ExtractedEvent]);

      // Setup: LLM synthesis finds the link
      mockClaudeAgentService.call.mockResolvedValue({
        data: {
          contextFound: true,
          linkedEventId: 'candidate-event-id',
          synthesis: 'Речь идёт о задаче "подготовить отчёт Q4"',
          confidence: 0.9,
        },
        usage: { inputTokens: 200, outputTokens: 100, totalCostUsd: 0.002 },
        run: { id: 'run-1' } as any,
      });

      const result = await service.enrichEvent(mockAbstractEvent as ExtractedEvent);

      // Verify search was called with correct parameters
      expect(mockSearchService.search).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.any(String),
          entityId: 'entity-456',
          searchType: 'hybrid',
          limit: 20, // ENRICHMENT_CONFIG.MAX_RELATED_MESSAGES
        }),
      );

      // Verify candidate events were searched
      expect(extractedEventRepo.find).toHaveBeenCalled();

      // Verify LLM was called for synthesis
      expect(mockClaudeAgentService.call).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'oneshot',
          taskType: 'context_enrichment',
          model: 'sonnet', // ENRICHMENT_CONFIG.MODEL
        }),
      );

      // Verify result
      expect(result.success).toBe(true);
      expect(result.linkedEventId).toBe('candidate-event-id');
      expect(result.needsContext).toBe(false);
      expect(result.enrichmentData.synthesis).toBe('Речь идёт о задаче "подготовить отчёт Q4"');
      expect(result.enrichmentData.enrichmentSuccess).toBe(true);
    });

    it('should set needsContext=true when no context found in history', async () => {
      // Setup: search returns no messages
      mockSearchService.search.mockResolvedValue({
        results: [],
      });

      // Setup: no candidate events
      extractedEventRepo.find.mockResolvedValue([]);

      const result = await service.enrichEvent(mockAbstractEvent as ExtractedEvent);

      // LLM should NOT be called when there's nothing to synthesize
      expect(mockClaudeAgentService.call).not.toHaveBeenCalled();

      // Verify result indicates context is needed
      expect(result.success).toBe(true);
      expect(result.linkedEventId).toBeUndefined();
      expect(result.needsContext).toBe(true);
      expect(result.enrichmentData.enrichmentFailureReason).toContain('не найден');
    });

    it('should set needsContext=true when LLM cannot determine context', async () => {
      // Setup: some messages found but ambiguous
      mockSearchService.search.mockResolvedValue({
        results: [
          {
            id: 'msg-200',
            content: 'Обсуждали несколько задач на встрече',
            timestamp: new Date().toISOString(),
          },
        ],
      });

      extractedEventRepo.find.mockResolvedValue([]);

      // LLM indicates context not found with low confidence
      mockClaudeAgentService.call.mockResolvedValue({
        data: {
          contextFound: false,
          synthesis: 'Не удалось определить, о какой задаче идёт речь',
          confidence: 0.2,
        },
        usage: { inputTokens: 150, outputTokens: 80, totalCostUsd: 0.0015 },
        run: { id: 'run-2' } as any,
      });

      const result = await service.enrichEvent(mockAbstractEvent as ExtractedEvent);

      expect(result.success).toBe(true);
      expect(result.needsContext).toBe(true);
      expect(result.enrichmentData.enrichmentSuccess).toBe(false);
    });

    it('should validate linkedEventId against candidate events', async () => {
      mockSearchService.search.mockResolvedValue({
        results: [{ id: 'msg-100', content: 'test', timestamp: new Date().toISOString() }],
      });

      extractedEventRepo.find.mockResolvedValue([mockCandidateEvent as ExtractedEvent]);

      // LLM returns invalid linkedEventId (not in candidates)
      mockClaudeAgentService.call.mockResolvedValue({
        data: {
          contextFound: true,
          linkedEventId: 'invalid-uuid-not-in-candidates',
          synthesis: 'Some synthesis',
          confidence: 0.8,
        },
        usage: { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.001 },
        run: { id: 'run-3' } as any,
      });

      const result = await service.enrichEvent(mockAbstractEvent as ExtractedEvent);

      // linkedEventId should be undefined because it wasn't in candidates
      expect(result.linkedEventId).toBeUndefined();
      expect(result.success).toBe(true);
    });

    it('should handle LLM errors gracefully', async () => {
      mockSearchService.search.mockResolvedValue({
        results: [{ id: 'msg-100', content: 'test', timestamp: new Date().toISOString() }],
      });

      extractedEventRepo.find.mockResolvedValue([]);

      mockClaudeAgentService.call.mockRejectedValue(new Error('LLM timeout'));

      const result = await service.enrichEvent(mockAbstractEvent as ExtractedEvent);

      // LLM errors are caught and handled gracefully within synthesizeContext
      // The service returns a fallback synthesis result, not a failure
      expect(result.success).toBe(true);
      expect(result.needsContext).toBe(true);
      // The fallback synthesis indicates context wasn't found
      expect(result.enrichmentData.enrichmentSuccess).toBe(false);
    });

    it('should handle search errors gracefully', async () => {
      mockSearchService.search.mockRejectedValue(new Error('Search service unavailable'));

      extractedEventRepo.find.mockResolvedValue([]);

      const result = await service.enrichEvent(mockAbstractEvent as ExtractedEvent);

      // Should still succeed but with needsContext=true
      expect(result.success).toBe(true);
      expect(result.needsContext).toBe(true);
    });
  });

  describe('applyEnrichmentResult', () => {
    it('should update event with enrichment data', async () => {
      extractedEventRepo.update.mockResolvedValue({ affected: 1 } as any);

      const enrichmentResult = {
        success: true,
        linkedEventId: 'candidate-event-id',
        needsContext: false,
        enrichmentData: {
          keywords: ['задача', 'отчёт'],
          relatedMessageIds: ['msg-100'],
          candidateEventIds: ['candidate-event-id'],
          synthesis: 'Речь о подготовке отчёта',
          enrichmentSuccess: true,
          enrichedAt: new Date().toISOString(),
        },
      };

      await service.applyEnrichmentResult('abstract-event-id', enrichmentResult);

      expect(extractedEventRepo.update).toHaveBeenCalledWith('abstract-event-id', {
        linkedEventId: 'candidate-event-id',
        needsContext: false,
        enrichmentData: enrichmentResult.enrichmentData,
      });
    });

    it('should set linkedEventId to null when not provided', async () => {
      extractedEventRepo.update.mockResolvedValue({ affected: 1 } as any);

      const enrichmentResult = {
        success: true,
        needsContext: true,
        enrichmentData: {
          keywords: ['задача'],
          relatedMessageIds: [],
          candidateEventIds: [],
          enrichmentSuccess: false,
          enrichmentFailureReason: 'Контекст не найден',
          enrichedAt: new Date().toISOString(),
        },
      };

      await service.applyEnrichmentResult('abstract-event-id', enrichmentResult);

      expect(extractedEventRepo.update).toHaveBeenCalledWith('abstract-event-id', {
        linkedEventId: null,
        needsContext: true,
        enrichmentData: enrichmentResult.enrichmentData,
      });
    });
  });

  describe('keyword extraction', () => {
    it('should extract keywords from event data and source quote', async () => {
      const eventWithRichData: Partial<ExtractedEvent> = {
        ...mockAbstractEvent,
        extractedData: { what: 'подготовить презентацию' },
        sourceQuote: 'нужно подготовить презентацию для клиента',
      };

      mockSearchService.search.mockResolvedValue({ results: [] });
      extractedEventRepo.find.mockResolvedValue([]);

      await service.enrichEvent(eventWithRichData as ExtractedEvent);

      // Verify search was called with keywords from both what and sourceQuote
      expect(mockSearchService.search).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringMatching(/подготовить|презентацию|клиента/i),
        }),
      );
    });

    it('should filter stop words and short words', async () => {
      const eventWithStopWords: Partial<ExtractedEvent> = {
        ...mockAbstractEvent,
        extractedData: { what: 'это нужно для проекта' },
        sourceQuote: 'это нужно сделать для большого проекта',
      };

      mockSearchService.search.mockResolvedValue({ results: [] });
      extractedEventRepo.find.mockResolvedValue([]);

      await service.enrichEvent(eventWithStopWords as ExtractedEvent);

      // Verify search query doesn't contain stop words like "это", "для"
      const searchCall = mockSearchService.search.mock.calls[0][0];
      expect(searchCall.query).not.toMatch(/\bэто\b/);
      expect(searchCall.query).not.toMatch(/\bдля\b/);
    });
  });

  describe('event without entityId', () => {
    it('should skip candidate event search when entityId is null', async () => {
      const eventWithoutEntity: Partial<ExtractedEvent> = {
        ...mockAbstractEvent,
        entityId: null,
      };

      mockSearchService.search.mockResolvedValue({ results: [] });
      extractedEventRepo.find.mockResolvedValue([]);

      await service.enrichEvent(eventWithoutEntity as ExtractedEvent);

      // Should still search messages but not candidate events
      expect(mockSearchService.search).toHaveBeenCalled();
      // Candidate event search should return empty (entityId check)
      expect(extractedEventRepo.find).not.toHaveBeenCalled();
    });
  });
});
