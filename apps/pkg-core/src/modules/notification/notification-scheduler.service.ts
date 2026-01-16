import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationService } from './notification.service';
import { DigestService } from './digest.service';

@Injectable()
export class NotificationSchedulerService {
  private readonly logger = new Logger(NotificationSchedulerService.name);

  constructor(
    private notificationService: NotificationService,
    private digestService: DigestService,
  ) {}

  /**
   * Every 5 minutes: process high-priority pending events
   * High priority events are sent immediately as individual notifications
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async processHighPriorityEvents(): Promise<void> {
    this.logger.debug('Processing high-priority events...');
    try {
      const count = await this.notificationService.processHighPriorityEvents();
      if (count > 0) {
        this.logger.log(`Processed ${count} high-priority events`);
      }
    } catch (error) {
      this.logger.error('Failed to process high-priority events:', error);
    }
  }

  /**
   * Every hour at minute 0: send hourly digest
   * Contains medium-priority events that don't need immediate attention
   */
  @Cron(CronExpression.EVERY_HOUR)
  async sendHourlyDigest(): Promise<void> {
    this.logger.debug('Sending hourly digest...');
    try {
      await this.digestService.sendHourlyDigest();
    } catch (error) {
      this.logger.error('Failed to send hourly digest:', error);
    }
  }

  /**
   * 21:00 Moscow time: send daily digest
   * Summarizes all remaining pending events for the day
   */
  @Cron('0 21 * * *', { timeZone: 'Europe/Moscow' })
  async sendDailyDigest(): Promise<void> {
    this.logger.log('Sending daily digest...');
    try {
      await this.digestService.sendDailyDigest();
    } catch (error) {
      this.logger.error('Failed to send daily digest:', error);
    }
  }

  /**
   * 08:00 Moscow time: send morning brief
   * Overview of today's schedule, pending items, and reminders
   */
  @Cron('0 8 * * *', { timeZone: 'Europe/Moscow' })
  async sendMorningBrief(): Promise<void> {
    this.logger.log('Sending morning brief...');
    try {
      await this.digestService.sendMorningBrief();
    } catch (error) {
      this.logger.error('Failed to send morning brief:', error);
    }
  }

  /**
   * 03:00 daily: expire old pending events
   * Events that haven't been confirmed/rejected after 7 days are marked as expired
   */
  @Cron('0 3 * * *')
  async expireOldEvents(): Promise<void> {
    this.logger.debug('Expiring old pending events...');
    try {
      const count = await this.notificationService.expireOldPendingEvents(7);
      if (count > 0) {
        this.logger.log(`Expired ${count} old pending events`);
      }
    } catch (error) {
      this.logger.error('Failed to expire old events:', error);
    }
  }
}
