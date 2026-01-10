import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Job, JobType, JobStatus } from '@pkg/entities';
import { SettingsService } from '../settings/settings.service';

export interface ExtractionJobData {
  interactionId: string;
  entityId: string;
  messageIds: string[];
  messages: Array<{
    id: string;
    content: string;
    timestamp: string;
  }>;
}

@Injectable()
export class JobService {
  private readonly logger = new Logger(JobService.name);

  constructor(
    @InjectRepository(Job)
    private jobRepo: Repository<Job>,
    @InjectQueue('embedding')
    private embeddingQueue: Queue,
    @InjectQueue('fact-extraction')
    private extractionQueue: Queue,
    private settingsService: SettingsService,
  ) {}

  async createEmbeddingJob(data: { messageId: string; content: string }) {
    // Create job record
    const job = this.jobRepo.create({
      type: JobType.EMBEDDING,
      status: JobStatus.PENDING,
      payload: data,
    });

    const savedJob = await this.jobRepo.save(job);

    // Add to BullMQ queue
    await this.embeddingQueue.add('generate', {
      jobId: savedJob.id,
      ...data,
    });

    return savedJob;
  }

  async updateStatus(id: string, status: JobStatus, result?: any, error?: string) {
    await this.jobRepo.update(id, {
      status,
      result,
      error,
      completedAt: status === JobStatus.COMPLETED || status === JobStatus.FAILED
        ? new Date()
        : undefined,
      startedAt: status === JobStatus.PROCESSING ? new Date() : undefined,
    });
  }

  async incrementAttempts(id: string) {
    await this.jobRepo.increment({ id }, 'attempts', 1);
  }

  /**
   * Schedule fact extraction with debouncing.
   * If a delayed job exists for this interaction, update it and reset the delay.
   * Otherwise, create a new delayed job.
   */
  async scheduleExtraction(params: {
    interactionId: string;
    entityId: string;
    messageId: string;
    messageContent: string;
  }): Promise<void> {
    const { interactionId, entityId, messageId, messageContent } = params;
    const jobId = `extraction:${interactionId}`;

    const delayMs = await this.settingsService.getValue<number>(
      'extraction.extractDelayTime',
    ) ?? 600000; // 10 minutes default

    const existingJob = await this.extractionQueue.getJob(jobId);

    if (existingJob) {
      const state = await existingJob.getState();

      if (state === 'delayed') {
        // ATOMIC update via BullMQ API
        const currentData = existingJob.data as ExtractionJobData;
        await existingJob.updateData({
          ...currentData,
          messageIds: [...currentData.messageIds, messageId],
          messages: [...currentData.messages, {
            id: messageId,
            content: messageContent,
            timestamp: new Date().toISOString(),
          }],
        });
        await existingJob.changeDelay(delayMs); // Reset delay
        this.logger.debug(`Updated extraction job ${jobId} with message ${messageId}`);
        return;
      }

      // Job exists but not in delayed state (active, waiting, completed, failed)
      // DON'T remove manually — BullMQ will clean up via queue settings
      // Create NEW job with timestamp suffix for uniqueness
      const uniqueJobId = `extraction:${interactionId}:${Date.now()}`;
      await this.extractionQueue.add('extract', {
        interactionId,
        entityId,
        messageIds: [messageId],
        messages: [{
          id: messageId,
          content: messageContent,
          timestamp: new Date().toISOString(),
        }],
      } as ExtractionJobData, {
        jobId: uniqueJobId,
        delay: delayMs,
      });
      this.logger.debug(`Created new extraction job ${uniqueJobId} (existing ${jobId} in state ${state})`);
      return;
    }

    // Create new job
    await this.extractionQueue.add('extract', {
      interactionId,
      entityId,
      messageIds: [messageId],
      messages: [{
        id: messageId,
        content: messageContent,
        timestamp: new Date().toISOString(),
      }],
    } as ExtractionJobData, {
      jobId,
      delay: delayMs,
    });
    this.logger.debug(`Created extraction job ${jobId} with delay ${delayMs}ms`);
  }
}
