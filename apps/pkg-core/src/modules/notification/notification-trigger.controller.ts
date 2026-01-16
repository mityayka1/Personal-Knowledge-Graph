import { Controller, Post, Logger } from '@nestjs/common';
import { NotificationSchedulerService } from './notification-scheduler.service';

/**
 * Controller for manually triggering notification jobs.
 * Useful for testing and debugging.
 */
@Controller('notifications/trigger')
export class NotificationTriggerController {
  private readonly logger = new Logger(NotificationTriggerController.name);

  constructor(private schedulerService: NotificationSchedulerService) {}

  /**
   * Trigger high-priority event processing
   * POST /notifications/trigger/high-priority
   */
  @Post('high-priority')
  async triggerHighPriority(): Promise<{ success: boolean; message: string }> {
    this.logger.log('Manual trigger: high-priority events');
    await this.schedulerService.processHighPriorityEvents();
    return { success: true, message: 'High-priority events processed' };
  }

  /**
   * Trigger hourly digest
   * POST /notifications/trigger/hourly-digest
   */
  @Post('hourly-digest')
  async triggerHourlyDigest(): Promise<{ success: boolean; message: string }> {
    this.logger.log('Manual trigger: hourly digest');
    await this.schedulerService.sendHourlyDigest();
    return { success: true, message: 'Hourly digest sent' };
  }

  /**
   * Trigger daily digest
   * POST /notifications/trigger/daily-digest
   */
  @Post('daily-digest')
  async triggerDailyDigest(): Promise<{ success: boolean; message: string }> {
    this.logger.log('Manual trigger: daily digest');
    await this.schedulerService.sendDailyDigest();
    return { success: true, message: 'Daily digest sent' };
  }

  /**
   * Trigger morning brief
   * POST /notifications/trigger/morning-brief
   */
  @Post('morning-brief')
  async triggerMorningBrief(): Promise<{ success: boolean; message: string }> {
    this.logger.log('Manual trigger: morning brief');
    await this.schedulerService.sendMorningBrief();
    return { success: true, message: 'Morning brief sent' };
  }
}
