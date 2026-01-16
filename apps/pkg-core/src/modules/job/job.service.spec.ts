import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Repository } from 'typeorm';
import { Job as JobEntity, JobType, JobStatus } from '@pkg/entities';
import { Queue, Job } from 'bullmq';
import { JobService, ExtractionJobData } from './job.service';
import { SettingsService } from '../settings/settings.service';

describe('JobService', () => {
  let service: JobService;
  let jobRepo: jest.Mocked<Repository<JobEntity>>;
  let embeddingQueue: jest.Mocked<Queue>;
  let extractionQueue: jest.Mocked<Queue>;
  let settingsService: jest.Mocked<SettingsService>;

  const mockJobRepo = {
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    increment: jest.fn(),
  };

  const mockEmbeddingQueue = {
    add: jest.fn(),
  };

  const mockExtractionQueue = {
    add: jest.fn(),
    getJob: jest.fn(),
  };

  const mockSettingsService = {
    getValue: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobService,
        {
          provide: getRepositoryToken(JobEntity),
          useValue: mockJobRepo,
        },
        {
          provide: getQueueToken('embedding'),
          useValue: mockEmbeddingQueue,
        },
        {
          provide: getQueueToken('fact-extraction'),
          useValue: mockExtractionQueue,
        },
        {
          provide: SettingsService,
          useValue: mockSettingsService,
        },
      ],
    }).compile();

    service = module.get<JobService>(JobService);
    jobRepo = module.get(getRepositoryToken(JobEntity));
    embeddingQueue = module.get(getQueueToken('embedding'));
    extractionQueue = module.get(getQueueToken('fact-extraction'));
    settingsService = module.get(SettingsService);
  });

  describe('scheduleExtraction - Debouncing Logic', () => {
    const interactionId = 'interaction-123';
    const entityId = 'entity-456';
    const messageId = 'msg-789';
    const messageContent = 'Test message content';
    const expectedJobId = `extraction_${interactionId}`;
    const defaultDelay = 600000; // 10 minutes

    beforeEach(() => {
      mockSettingsService.getValue.mockResolvedValue(defaultDelay);
    });

    describe('when no existing job exists', () => {
      it('should create a new delayed extraction job', async () => {
        mockExtractionQueue.getJob.mockResolvedValue(null);

        await service.scheduleExtraction({
          interactionId,
          entityId,
          messageId,
          messageContent,
        });

        expect(mockExtractionQueue.getJob).toHaveBeenCalledWith(expectedJobId);
        expect(mockExtractionQueue.add).toHaveBeenCalledWith(
          'extract',
          expect.objectContaining({
            interactionId,
            entityId,
            messageIds: [messageId],
            messages: expect.arrayContaining([
              expect.objectContaining({
                id: messageId,
                content: messageContent,
              }),
            ]),
          }),
          expect.objectContaining({
            jobId: expectedJobId,
            delay: defaultDelay,
          }),
        );
      });

      it('should use custom delay from settings', async () => {
        const customDelay = 300000; // 5 minutes
        mockSettingsService.getValue.mockResolvedValue(customDelay);
        mockExtractionQueue.getJob.mockResolvedValue(null);

        await service.scheduleExtraction({
          interactionId,
          entityId,
          messageId,
          messageContent,
        });

        expect(mockExtractionQueue.add).toHaveBeenCalledWith(
          'extract',
          expect.anything(),
          expect.objectContaining({
            delay: customDelay,
          }),
        );
      });

      it('should use default delay when settings not configured', async () => {
        mockSettingsService.getValue.mockResolvedValue(null);
        mockExtractionQueue.getJob.mockResolvedValue(null);

        await service.scheduleExtraction({
          interactionId,
          entityId,
          messageId,
          messageContent,
        });

        expect(mockExtractionQueue.add).toHaveBeenCalledWith(
          'extract',
          expect.anything(),
          expect.objectContaining({
            delay: 600000, // default 10 minutes
          }),
        );
      });
    });

    describe('when existing job is in delayed state', () => {
      it('should update job data and reset delay', async () => {
        const existingMessageId = 'existing-msg-1';
        const existingData: ExtractionJobData = {
          interactionId,
          entityId,
          messageIds: [existingMessageId],
          messages: [
            { id: existingMessageId, content: 'Existing', timestamp: '2026-01-10T10:00:00Z', isOutgoing: false },
          ],
        };

        const mockJob = {
          data: existingData,
          getState: jest.fn().mockResolvedValue('delayed'),
          updateData: jest.fn().mockResolvedValue(undefined),
          changeDelay: jest.fn().mockResolvedValue(undefined),
        };

        mockExtractionQueue.getJob.mockResolvedValue(mockJob as unknown as Job);

        await service.scheduleExtraction({
          interactionId,
          entityId,
          messageId,
          messageContent,
        });

        expect(mockJob.getState).toHaveBeenCalled();
        expect(mockJob.updateData).toHaveBeenCalledWith(
          expect.objectContaining({
            messageIds: [existingMessageId, messageId],
            messages: expect.arrayContaining([
              expect.objectContaining({ id: existingMessageId }),
              expect.objectContaining({ id: messageId, content: messageContent }),
            ]),
          }),
        );
        expect(mockJob.changeDelay).toHaveBeenCalledWith(defaultDelay);
        expect(mockExtractionQueue.add).not.toHaveBeenCalled();
      });

      it('should append messages in order', async () => {
        const existingMessages = [
          { id: 'msg-1', content: 'First', timestamp: '2026-01-10T10:00:00Z', isOutgoing: false },
          { id: 'msg-2', content: 'Second', timestamp: '2026-01-10T10:01:00Z', isOutgoing: true },
        ];
        const existingData: ExtractionJobData = {
          interactionId,
          entityId,
          messageIds: ['msg-1', 'msg-2'],
          messages: existingMessages,
        };

        const mockJob = {
          data: existingData,
          getState: jest.fn().mockResolvedValue('delayed'),
          updateData: jest.fn().mockResolvedValue(undefined),
          changeDelay: jest.fn().mockResolvedValue(undefined),
        };

        mockExtractionQueue.getJob.mockResolvedValue(mockJob as unknown as Job);

        await service.scheduleExtraction({
          interactionId,
          entityId,
          messageId: 'msg-3',
          messageContent: 'Third',
        });

        expect(mockJob.updateData).toHaveBeenCalledWith(
          expect.objectContaining({
            messageIds: ['msg-1', 'msg-2', 'msg-3'],
            messages: expect.arrayContaining([
              expect.objectContaining({ id: 'msg-1' }),
              expect.objectContaining({ id: 'msg-2' }),
              expect.objectContaining({ id: 'msg-3', content: 'Third' }),
            ]),
          }),
        );
      });
    });

    describe('when existing job is NOT in delayed state', () => {
      describe('for completed or failed jobs', () => {
        const completedStates = ['completed', 'failed'];

        completedStates.forEach((state) => {
          it(`should remove and replace job when existing job is ${state}`, async () => {
            const mockJob = {
              data: { interactionId, entityId, messageIds: [], messages: [] },
              getState: jest.fn().mockResolvedValue(state),
              remove: jest.fn().mockResolvedValue(undefined),
            };

            mockExtractionQueue.getJob.mockResolvedValue(mockJob as unknown as Job);

            await service.scheduleExtraction({
              interactionId,
              entityId,
              messageId,
              messageContent,
            });

            expect(mockJob.remove).toHaveBeenCalled();
            expect(mockExtractionQueue.add).toHaveBeenCalledWith(
              'extract',
              expect.objectContaining({
                interactionId,
                entityId,
                messageIds: [messageId],
              }),
              expect.objectContaining({
                jobId: `extraction_${interactionId}`,
                delay: defaultDelay,
              }),
            );
          });
        });
      });

      describe('for active or waiting jobs', () => {
        const activeStates = ['active', 'waiting'];

        activeStates.forEach((state) => {
          it(`should create new job with timestamp suffix when existing job is ${state}`, async () => {
            const mockJob = {
              data: { interactionId, entityId, messageIds: [], messages: [] },
              getState: jest.fn().mockResolvedValue(state),
            };

            mockExtractionQueue.getJob.mockResolvedValue(mockJob as unknown as Job);

            const beforeTimestamp = Date.now();
            await service.scheduleExtraction({
              interactionId,
              entityId,
              messageId,
              messageContent,
            });
            const afterTimestamp = Date.now();

            expect(mockExtractionQueue.add).toHaveBeenCalledWith(
              'extract',
              expect.objectContaining({
                interactionId,
                entityId,
                messageIds: [messageId],
              }),
              expect.objectContaining({
                jobId: expect.stringMatching(new RegExp(`extraction_${interactionId}_\\d+`)),
                delay: defaultDelay,
              }),
            );

            // Verify timestamp is within expected range
            const addCall = mockExtractionQueue.add.mock.calls[0];
            const actualJobId = addCall[2].jobId;
            const timestampPart = parseInt(actualJobId.split('_').pop()!, 10);
            expect(timestampPart).toBeGreaterThanOrEqual(beforeTimestamp);
            expect(timestampPart).toBeLessThanOrEqual(afterTimestamp);
          });
        });
      });
    });

    describe('job ID format', () => {
      it('should use underscore separator instead of colon', async () => {
        mockExtractionQueue.getJob.mockResolvedValue(null);

        await service.scheduleExtraction({
          interactionId: 'uuid-with-dashes-123',
          entityId,
          messageId,
          messageContent,
        });

        expect(mockExtractionQueue.getJob).toHaveBeenCalledWith('extraction_uuid-with-dashes-123');
        expect(mockExtractionQueue.add).toHaveBeenCalledWith(
          'extract',
          expect.anything(),
          expect.objectContaining({
            jobId: 'extraction_uuid-with-dashes-123',
          }),
        );
      });

      it('should NOT contain colons in job ID', async () => {
        mockExtractionQueue.getJob.mockResolvedValue(null);

        await service.scheduleExtraction({
          interactionId,
          entityId,
          messageId,
          messageContent,
        });

        const addCall = mockExtractionQueue.add.mock.calls[0];
        const jobId = addCall[2].jobId;
        expect(jobId).not.toContain(':');
      });
    });

    describe('concurrent calls handling', () => {
      it('should handle race condition when job state changes between getJob and getState', async () => {
        // First call sees delayed job
        const mockJob1 = {
          data: { interactionId, entityId, messageIds: ['m1'], messages: [{ id: 'm1', content: 'a', timestamp: '' }] },
          getState: jest.fn().mockResolvedValue('delayed'),
          updateData: jest.fn().mockResolvedValue(undefined),
          changeDelay: jest.fn().mockResolvedValue(undefined),
        };

        // Second call sees job that became active
        const mockJob2 = {
          data: { interactionId, entityId, messageIds: ['m1'], messages: [] },
          getState: jest.fn().mockResolvedValue('active'),
        };

        mockExtractionQueue.getJob
          .mockResolvedValueOnce(mockJob1 as unknown as Job)
          .mockResolvedValueOnce(mockJob2 as unknown as Job);

        // First call - should update existing
        await service.scheduleExtraction({
          interactionId,
          entityId,
          messageId: 'm2',
          messageContent: 'Second message',
        });

        expect(mockJob1.updateData).toHaveBeenCalled();
        expect(mockExtractionQueue.add).not.toHaveBeenCalled();

        // Second call - should create new with timestamp
        await service.scheduleExtraction({
          interactionId,
          entityId,
          messageId: 'm3',
          messageContent: 'Third message',
        });

        expect(mockExtractionQueue.add).toHaveBeenCalledWith(
          'extract',
          expect.anything(),
          expect.objectContaining({
            jobId: expect.stringMatching(/extraction_.*_\d+/),
          }),
        );
      });
    });

    describe('settings integration', () => {
      it('should read extraction.extractDelayTime setting', async () => {
        mockExtractionQueue.getJob.mockResolvedValue(null);

        await service.scheduleExtraction({
          interactionId,
          entityId,
          messageId,
          messageContent,
        });

        expect(mockSettingsService.getValue).toHaveBeenCalledWith('extraction.extractDelayTime');
      });
    });
  });

  describe('createEmbeddingJob', () => {
    it('should create job record and add to queue', async () => {
      const messageId = 'msg-123';
      const content = 'Test content';
      const savedJob = {
        id: 'job-uuid',
        type: JobType.EMBEDDING,
        status: JobStatus.PENDING,
        payload: { messageId, content },
      };

      mockJobRepo.create.mockReturnValue(savedJob);
      mockJobRepo.save.mockResolvedValue(savedJob);

      const result = await service.createEmbeddingJob({ messageId, content });

      expect(mockJobRepo.create).toHaveBeenCalledWith({
        type: JobType.EMBEDDING,
        status: JobStatus.PENDING,
        payload: { messageId, content },
      });
      expect(mockJobRepo.save).toHaveBeenCalledWith(savedJob);
      expect(mockEmbeddingQueue.add).toHaveBeenCalledWith('generate', {
        jobId: 'job-uuid',
        messageId,
        content,
      });
      expect(result).toBe(savedJob);
    });
  });

  describe('updateStatus', () => {
    it('should update job status to PROCESSING with startedAt', async () => {
      const jobId = 'job-123';

      await service.updateStatus(jobId, JobStatus.PROCESSING);

      expect(mockJobRepo.update).toHaveBeenCalledWith(jobId, {
        status: JobStatus.PROCESSING,
        result: undefined,
        error: undefined,
        completedAt: undefined,
        startedAt: expect.any(Date),
      });
    });

    it('should update job status to COMPLETED with completedAt and result', async () => {
      const jobId = 'job-123';
      const result = { factsExtracted: 5 };

      await service.updateStatus(jobId, JobStatus.COMPLETED, result);

      expect(mockJobRepo.update).toHaveBeenCalledWith(jobId, {
        status: JobStatus.COMPLETED,
        result,
        error: undefined,
        completedAt: expect.any(Date),
        startedAt: undefined,
      });
    });

    it('should update job status to FAILED with completedAt and error', async () => {
      const jobId = 'job-123';
      const error = 'Something went wrong';

      await service.updateStatus(jobId, JobStatus.FAILED, undefined, error);

      expect(mockJobRepo.update).toHaveBeenCalledWith(jobId, {
        status: JobStatus.FAILED,
        result: undefined,
        error,
        completedAt: expect.any(Date),
        startedAt: undefined,
      });
    });
  });

  describe('incrementAttempts', () => {
    it('should increment attempts counter', async () => {
      const jobId = 'job-123';

      await service.incrementAttempts(jobId);

      expect(mockJobRepo.increment).toHaveBeenCalledWith({ id: jobId }, 'attempts', 1);
    });
  });
});
