/**
 * Notification job types for BullMQ queue.
 */

export enum NotificationJobType {
  /** Send notification for a single extracted event */
  SINGLE_EVENT = 'single_event',
  /** Send morning brief with day's schedule */
  MORNING_BRIEF = 'morning_brief',
  /** Send hourly digest of medium-priority events */
  HOURLY_DIGEST = 'hourly_digest',
  /** Send daily digest of remaining events */
  DAILY_DIGEST = 'daily_digest',
}

export interface BaseNotificationJobData {
  type: NotificationJobType;
  /** ISO timestamp when job was created (for debugging) */
  createdAt: string;
}

export interface SingleEventNotificationJobData extends BaseNotificationJobData {
  type: NotificationJobType.SINGLE_EVENT;
  /** Event ID to notify about */
  eventId: string;
}

export interface MorningBriefNotificationJobData extends BaseNotificationJobData {
  type: NotificationJobType.MORNING_BRIEF;
}

export interface DigestNotificationJobData extends BaseNotificationJobData {
  type: NotificationJobType.HOURLY_DIGEST | NotificationJobType.DAILY_DIGEST;
  /** Event IDs to include in digest */
  eventIds: string[];
}

export type NotificationJobData =
  | SingleEventNotificationJobData
  | MorningBriefNotificationJobData
  | DigestNotificationJobData;

export interface NotificationJobResult {
  success: boolean;
  /** Event ID(s) that were processed */
  eventId?: string;
  eventIds?: string[];
  /** Error message if failed */
  error?: string;
}
