import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EnrichmentQueueService } from './enrichment-queue.service';

describe('EnrichmentQueueService', () => {
  let service: EnrichmentQueueService;
  let mockQueue: jest.Mocked<Queue>;

  beforeEach(async () => {
    mockQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
      getWaitingCount: jest.fn().mockResolvedValue(5),
      getActiveCount: jest.fn().mockResolvedValue(2),
      getCompletedCount: jest.fn().mockResolvedValue(100),
      getFailedCount: jest.fn().mockResolvedValue(3),
    } as unknown as jest.Mocked<Queue>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnrichmentQueueService,
        {
          provide: getQueueToken('enrichment'),
          useValue: mockQueue,
        },
      ],
    }).compile();

    service = module.get<EnrichmentQueueService>(EnrichmentQueueService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('queueForEnrichment', () => {
    it('should add event to queue with correct job id', async () => {
      const eventId = 'event-123';

      await service.queueForEnrichment(eventId);

      expect(mockQueue.add).toHaveBeenCalledWith(
        'enrich-event',
        { eventId },
        { jobId: `enrich-${eventId}` },
      );
    });

    it('should add event to queue with delay when specified', async () => {
      const eventId = 'event-456';
      const delay = 5000;

      await service.queueForEnrichment(eventId, delay);

      expect(mockQueue.add).toHaveBeenCalledWith(
        'enrich-event',
        { eventId },
        { jobId: `enrich-${eventId}`, delay: 5000 },
      );
    });

    it('should not add delay when not specified', async () => {
      const eventId = 'event-789';

      await service.queueForEnrichment(eventId);

      expect(mockQueue.add).toHaveBeenCalledWith(
        'enrich-event',
        { eventId },
        expect.not.objectContaining({ delay: expect.anything() }),
      );
    });
  });

  describe('queueBatchForEnrichment', () => {
    it('should queue multiple events with staggered delays', async () => {
      const eventIds = ['event-1', 'event-2', 'event-3'];

      await service.queueBatchForEnrichment(eventIds);

      expect(mockQueue.add).toHaveBeenCalledTimes(3);

      // First event: no delay (0 is falsy, so no delay key added)
      expect(mockQueue.add).toHaveBeenNthCalledWith(
        1,
        'enrich-event',
        { eventId: 'event-1' },
        { jobId: 'enrich-event-1' },
      );

      // Second event: 1000ms delay
      expect(mockQueue.add).toHaveBeenNthCalledWith(
        2,
        'enrich-event',
        { eventId: 'event-2' },
        { jobId: 'enrich-event-2', delay: 1000 },
      );

      // Third event: 2000ms delay
      expect(mockQueue.add).toHaveBeenNthCalledWith(
        3,
        'enrich-event',
        { eventId: 'event-3' },
        { jobId: 'enrich-event-3', delay: 2000 },
      );
    });

    it('should add initial delay to staggered delays when specified', async () => {
      const eventIds = ['event-a', 'event-b'];
      const initialDelay = 3000;

      await service.queueBatchForEnrichment(eventIds, initialDelay);

      expect(mockQueue.add).toHaveBeenCalledTimes(2);

      // First event: initialDelay + 0 * 1000 = 3000ms
      expect(mockQueue.add).toHaveBeenNthCalledWith(
        1,
        'enrich-event',
        { eventId: 'event-a' },
        { jobId: 'enrich-event-a', delay: 3000 },
      );

      // Second event: initialDelay + 1 * 1000 = 4000ms
      expect(mockQueue.add).toHaveBeenNthCalledWith(
        2,
        'enrich-event',
        { eventId: 'event-b' },
        { jobId: 'enrich-event-b', delay: 4000 },
      );
    });

    it('should handle empty array', async () => {
      await service.queueBatchForEnrichment([]);

      expect(mockQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('getQueueStats', () => {
    it('should return queue statistics', async () => {
      const stats = await service.getQueueStats();

      expect(stats).toEqual({
        waiting: 5,
        active: 2,
        completed: 100,
        failed: 3,
      });
    });

    it('should call all queue stat methods', async () => {
      await service.getQueueStats();

      expect(mockQueue.getWaitingCount).toHaveBeenCalled();
      expect(mockQueue.getActiveCount).toHaveBeenCalled();
      expect(mockQueue.getCompletedCount).toHaveBeenCalled();
      expect(mockQueue.getFailedCount).toHaveBeenCalled();
    });

    it('should handle queue errors', async () => {
      mockQueue.getWaitingCount.mockRejectedValue(new Error('Queue unavailable'));

      await expect(service.getQueueStats()).rejects.toThrow('Queue unavailable');
    });
  });
});
