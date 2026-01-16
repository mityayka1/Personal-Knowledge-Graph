import { Controller, Post, Get, Query, Param, Logger, ParseUUIDPipe } from '@nestjs/common';
import { NotificationSchedulerService } from './notification-scheduler.service';
import { NotificationService } from './notification.service';

/**
 * Controller for manually triggering notification jobs.
 * Useful for testing and debugging.
 */
@Controller('notifications/trigger')
export class NotificationTriggerController {
  private readonly logger = new Logger(NotificationTriggerController.name);

  constructor(
    private schedulerService: NotificationSchedulerService,
    private notificationService: NotificationService,
  ) {}

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

  /**
   * Debug: get pending events for digest
   * GET /notifications/trigger/debug-pending?priority=medium&limit=10
   */
  @Get('debug-pending')
  async debugPending(
    @Query('priority') priority: 'high' | 'medium' | 'low' = 'medium',
    @Query('limit') limit = '10',
  ): Promise<{ count: number; events: unknown[] }> {
    const events = await this.notificationService.getPendingEventsForDigest(
      priority,
      parseInt(limit, 10),
    );
    return {
      count: events.length,
      events: events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        confidence: e.confidence,
        status: e.status,
        notificationSentAt: e.notificationSentAt,
        extractedData: e.extractedData,
      })),
    };
  }

  /**
   * Send notification for a specific event (for testing)
   * POST /notifications/trigger/event/:eventId
   */
  @Post('event/:eventId')
  async triggerSingleEvent(
    @Param('eventId', ParseUUIDPipe) eventId: string,
  ): Promise<{ success: boolean; message: string }> {
    this.logger.log(`Manual trigger: single event notification for ${eventId}`);
    await this.notificationService.sendNotificationForEvent(eventId);
    return { success: true, message: `Notification sent for event ${eventId}` };
  }
}
