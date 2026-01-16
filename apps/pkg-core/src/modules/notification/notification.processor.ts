import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  NotificationJobData,
  NotificationJobType,
  NotificationJobResult,
} from './notification-job.types';
import { NotificationService } from './notification.service';
import { DigestService } from './digest.service';

/**
 * BullMQ processor for notification jobs.
 * Handles sending notifications with built-in retry logic.
 */
@Processor('notification')
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    private notificationService: NotificationService,
    private digestService: DigestService,
  ) {
    super();
  }

  async process(job: Job<NotificationJobData>): Promise<NotificationJobResult> {
    const { type } = job.data;

    this.logger.log(`Processing notification job ${job.id} (${type})`);

    try {
      switch (type) {
        case NotificationJobType.SINGLE_EVENT:
          return this.processSingleEvent(job);

        case NotificationJobType.MORNING_BRIEF:
          return this.processMorningBrief(job);

        case NotificationJobType.HOURLY_DIGEST:
          return this.processHourlyDigest(job);

        case NotificationJobType.DAILY_DIGEST:
          return this.processDailyDigest(job);

        default:
          throw new Error(`Unknown notification job type: ${type}`);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Notification job ${job.id} failed: ${message}`);
      throw error;
    }
  }

  private async processSingleEvent(
    job: Job<NotificationJobData>,
  ): Promise<NotificationJobResult> {
    if (job.data.type !== NotificationJobType.SINGLE_EVENT) {
      throw new Error('Invalid job data for single event');
    }

    const { eventId } = job.data;
    await this.notificationService.sendNotificationForEvent(eventId);

    this.logger.log(`Single event notification sent for ${eventId}`);
    return { success: true, eventId };
  }

  private async processMorningBrief(
    _job: Job<NotificationJobData>,
  ): Promise<NotificationJobResult> {
    await this.digestService.sendMorningBrief();

    this.logger.log('Morning brief sent');
    return { success: true };
  }

  private async processHourlyDigest(
    job: Job<NotificationJobData>,
  ): Promise<NotificationJobResult> {
    if (job.data.type !== NotificationJobType.HOURLY_DIGEST) {
      throw new Error('Invalid job data for hourly digest');
    }

    const { eventIds } = job.data;

    // If eventIds provided, send specific events; otherwise let digest service decide
    if (eventIds && eventIds.length > 0) {
      await this.notificationService.sendDigestForEvents(eventIds, 'hourly');
      this.logger.log(`Hourly digest sent for ${eventIds.length} events`);
      return { success: true, eventIds };
    }

    await this.digestService.sendHourlyDigest();
    this.logger.log('Hourly digest sent');
    return { success: true };
  }

  private async processDailyDigest(
    job: Job<NotificationJobData>,
  ): Promise<NotificationJobResult> {
    if (job.data.type !== NotificationJobType.DAILY_DIGEST) {
      throw new Error('Invalid job data for daily digest');
    }

    const { eventIds } = job.data;

    if (eventIds && eventIds.length > 0) {
      await this.notificationService.sendDigestForEvents(eventIds, 'daily');
      this.logger.log(`Daily digest sent for ${eventIds.length} events`);
      return { success: true, eventIds };
    }

    await this.digestService.sendDailyDigest();
    this.logger.log('Daily digest sent');
    return { success: true };
  }
}
