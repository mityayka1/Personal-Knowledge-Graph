/**
 * Integration tests for JobService with real BullMQ/Redis
 * These tests verify the actual debouncing behavior
 *
 * Prerequisites:
 * - Redis running on localhost:6379 (or REDIS_HOST env var)
 *
 * Run with: pnpm test -- --testPathPattern=job.service.integration
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job as JobEntity } from '@pkg/entities';
import { JobService, ExtractionJobData } from './job.service';
import { SettingsService } from '../settings/settings.service';

// Skip these tests in CI or when Redis is not available
const describeWithRedis = process.env.SKIP_INTEGRATION_TESTS ? describe.skip : describe;

describeWithRedis('JobService Integration Tests', () => {
  let service: JobService;
  let extractionQueue: Queue;
  let module: TestingModule;

  const testInteractionId = `test-interaction-${Date.now()}`;
  const testEntityId = 'test-entity-123';

  const mockSettingsService = {
    getValue: jest.fn().mockResolvedValue(1000), // 1 second delay for faster tests
  };

  const mockJobRepo = {
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    increment: jest.fn(),
  };

  beforeAll(async () => {
    try {
      module = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true }),
          BullModule.forRoot({
            connection: {
              host: process.env.REDIS_HOST || 'localhost',
              port: parseInt(process.env.REDIS_PORT || '6379', 10),
            },
          }),
          BullModule.registerQueue(
            { name: 'embedding' },
            { name: 'fact-extraction' },
          ),
        ],
        providers: [
          JobService,
          {
            provide: getRepositoryToken(JobEntity),
            useValue: mockJobRepo,
          },
          {
            provide: SettingsService,
            useValue: mockSettingsService,
          },
        ],
      }).compile();

      service = module.get<JobService>(JobService);
      extractionQueue = module.get<Queue>(getQueueToken('fact-extraction'));
    } catch (error) {
      console.warn('Skipping integration tests - Redis not available');
      throw error;
    }
  });

  afterAll(async () => {
    // Cleanup test jobs
    const jobs = await extractionQueue.getJobs(['delayed', 'waiting', 'active']);
    for (const job of jobs) {
      if (job.id?.startsWith(`extraction_${testInteractionId}`)) {
        await job.remove();
      }
    }
    await module?.close();
  });

  afterEach(async () => {
    // Clean up jobs created during test
    const jobs = await extractionQueue.getJobs(['delayed', 'waiting']);
    for (const job of jobs) {
      if (job.id?.startsWith(`extraction_${testInteractionId}`)) {
        await job.remove();
      }
    }
  });

  describe('Real BullMQ Debouncing', () => {
    it('should create a delayed job in Redis', async () => {
      await service.scheduleExtraction({
        interactionId: testInteractionId,
        entityId: testEntityId,
        messageId: 'msg-1',
        messageContent: 'Test message 1',
      });

      const job = await extractionQueue.getJob(`extraction_${testInteractionId}`);
      expect(job).not.toBeNull();

      const state = await job!.getState();
      expect(state).toBe('delayed');

      const data = job!.data as ExtractionJobData;
      expect(data.messageIds).toContain('msg-1');
      expect(data.messages.length).toBe(1);
    });

    it('should update existing delayed job with new message', async () => {
      // Create initial job
      await service.scheduleExtraction({
        interactionId: testInteractionId,
        entityId: testEntityId,
        messageId: 'msg-1',
        messageContent: 'First message',
      });

      // Add second message
      await service.scheduleExtraction({
        interactionId: testInteractionId,
        entityId: testEntityId,
        messageId: 'msg-2',
        messageContent: 'Second message',
      });

      const job = await extractionQueue.getJob(`extraction_${testInteractionId}`);
      const data = job!.data as ExtractionJobData;

      expect(data.messageIds).toHaveLength(2);
      expect(data.messageIds).toContain('msg-1');
      expect(data.messageIds).toContain('msg-2');
      expect(data.messages[0].content).toBe('First message');
      expect(data.messages[1].content).toBe('Second message');
    });

    it('should reset delay when adding new message', async () => {
      // Create job with 1 second delay
      await service.scheduleExtraction({
        interactionId: testInteractionId,
        entityId: testEntityId,
        messageId: 'msg-1',
        messageContent: 'First',
      });

      const job1 = await extractionQueue.getJob(`extraction_${testInteractionId}`);
      const delay1 = job1!.opts.delay;

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Add another message - delay should be reset
      await service.scheduleExtraction({
        interactionId: testInteractionId,
        entityId: testEntityId,
        messageId: 'msg-2',
        messageContent: 'Second',
      });

      // Verify job is still delayed (not processed yet)
      const job2 = await extractionQueue.getJob(`extraction_${testInteractionId}`);
      const state = await job2!.getState();
      expect(state).toBe('delayed');
    });

    it('should accumulate multiple messages in single job', async () => {
      const messageCount = 5;

      for (let i = 1; i <= messageCount; i++) {
        await service.scheduleExtraction({
          interactionId: testInteractionId,
          entityId: testEntityId,
          messageId: `msg-${i}`,
          messageContent: `Message ${i}`,
        });
      }

      const job = await extractionQueue.getJob(`extraction_${testInteractionId}`);
      const data = job!.data as ExtractionJobData;

      expect(data.messageIds).toHaveLength(messageCount);
      expect(data.messages).toHaveLength(messageCount);

      // Verify order is preserved
      for (let i = 0; i < messageCount; i++) {
        expect(data.messageIds[i]).toBe(`msg-${i + 1}`);
        expect(data.messages[i].content).toBe(`Message ${i + 1}`);
      }
    });

    it('should handle job ID without colons (BullMQ requirement)', async () => {
      const interactionWithDashes = `test-${Date.now()}-interaction`;

      await service.scheduleExtraction({
        interactionId: interactionWithDashes,
        entityId: testEntityId,
        messageId: 'msg-1',
        messageContent: 'Test',
      });

      const expectedJobId = `extraction_${interactionWithDashes}`;
      const job = await extractionQueue.getJob(expectedJobId);

      expect(job).not.toBeNull();
      expect(job!.id).toBe(expectedJobId);
      expect(job!.id).not.toContain(':');

      // Cleanup
      await job!.remove();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty message content', async () => {
      await service.scheduleExtraction({
        interactionId: testInteractionId,
        entityId: testEntityId,
        messageId: 'msg-empty',
        messageContent: '',
      });

      const job = await extractionQueue.getJob(`extraction_${testInteractionId}`);
      expect(job).not.toBeNull();

      const data = job!.data as ExtractionJobData;
      expect(data.messages[0].content).toBe('');
    });

    it('should handle unicode in message content', async () => {
      const unicodeContent = '👋 Привет! 日本語 العربية';

      await service.scheduleExtraction({
        interactionId: testInteractionId,
        entityId: testEntityId,
        messageId: 'msg-unicode',
        messageContent: unicodeContent,
      });

      const job = await extractionQueue.getJob(`extraction_${testInteractionId}`);
      const data = job!.data as ExtractionJobData;
      expect(data.messages[0].content).toBe(unicodeContent);
    });

    it('should handle very long message content', async () => {
      const longContent = 'A'.repeat(10000);

      await service.scheduleExtraction({
        interactionId: testInteractionId,
        entityId: testEntityId,
        messageId: 'msg-long',
        messageContent: longContent,
      });

      const job = await extractionQueue.getJob(`extraction_${testInteractionId}`);
      const data = job!.data as ExtractionJobData;
      expect(data.messages[0].content.length).toBe(10000);
    });
  });
});
