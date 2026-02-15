import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TopicalSegment, SegmentStatus } from '@pkg/entities';
import { PackingService } from './packing.service';
import { SettingsService } from '../settings/settings.service';

/**
 * PackingJobService — weekly cron job for auto-packing segments into KnowledgePacks.
 *
 * Runs every Sunday at 03:00 Moscow time.
 * For each Activity with >= MIN_SEGMENTS packable segments,
 * calls PackingService.packByActivity() to synthesize consolidated knowledge.
 *
 * Phase E: Knowledge Segmentation & Packing
 */
@Injectable()
export class PackingJobService {
  private readonly logger = new Logger(PackingJobService.name);
  private isRunning = false;

  /** Minimum packable segments per activity to justify a Claude call */
  private static readonly MIN_SEGMENTS = 2;

  constructor(
    @InjectRepository(TopicalSegment)
    private readonly segmentRepo: Repository<TopicalSegment>,
    private readonly packingService: PackingService,
    private readonly settingsService: SettingsService,
  ) {}

  /**
   * Weekly cron: pack segments into KnowledgePacks.
   * Runs Sunday 03:00 Moscow time.
   */
  @Cron('0 3 * * 0', { name: 'packing-job', timeZone: 'Europe/Moscow' })
  async handleCron(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('[packing-job] Already running, skipping');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      // Check feature flag
      const enabled = await this.settingsService.getValue<boolean>('packing.autoEnabled');
      if (enabled === false) {
        this.logger.log('[packing-job] Disabled via packing.autoEnabled setting, skipping');
        return;
      }

      this.logger.log('[packing-job] Starting weekly packing job');

      // Find distinct activities with packable segments and their counts
      const activityRows = await this.segmentRepo
        .createQueryBuilder('s')
        .select('s.activity_id', 'activityId')
        .addSelect('COUNT(*)::int', 'segmentCount')
        .where('s.activity_id IS NOT NULL')
        .andWhere('s.status IN (:...statuses)', {
          statuses: [SegmentStatus.ACTIVE, SegmentStatus.CLOSED],
        })
        .groupBy('s.activity_id')
        .getRawMany<{ activityId: string; segmentCount: number }>();

      // Filter by minimum threshold
      const eligible = activityRows.filter(
        (r) => r.segmentCount >= PackingJobService.MIN_SEGMENTS,
      );
      const skipped = activityRows.length - eligible.length;

      this.logger.log(
        `[packing-job] Found ${activityRows.length} activities with packable segments ` +
        `(${eligible.length} eligible, ${skipped} skipped < ${PackingJobService.MIN_SEGMENTS} segments)`,
      );

      // Log orphan segments (no activityId) — they need manual linking
      const orphanCount = await this.segmentRepo
        .createQueryBuilder('s')
        .where('s.activity_id IS NULL')
        .andWhere('s.status IN (:...statuses)', {
          statuses: [SegmentStatus.ACTIVE, SegmentStatus.CLOSED],
        })
        .getCount();

      if (orphanCount > 0) {
        this.logger.warn(
          `[packing-job] ${orphanCount} orphan segments without activityId — need manual linking`,
        );
      }

      // Pack each eligible activity
      let totalSegmentsPacked = 0;
      let totalTokensUsed = 0;
      let successCount = 0;
      let errorCount = 0;

      for (const { activityId } of eligible) {
        try {
          const result = await this.packingService.packByActivity({ activityId });

          totalSegmentsPacked += result.segmentCount;
          totalTokensUsed += result.tokensUsed;
          successCount++;

          this.logger.log(
            `[packing-job] Packed activity=${activityId}: ` +
            `segments=${result.segmentCount}, tokens=${result.tokensUsed}`,
          );
        } catch (error: unknown) {
          errorCount++;
          const err = error instanceof Error ? error : new Error(String(error));
          this.logger.error(
            `[packing-job] Failed to pack activity=${activityId}: ${err.message}`,
            err.stack,
          );
        }
      }

      const durationMs = Date.now() - startTime;

      this.logger.log(
        `[packing-job] Completed in ${durationMs}ms: ` +
        `activities=${successCount}/${eligible.length}, ` +
        `segments=${totalSegmentsPacked}, ` +
        `tokens=${totalTokensUsed}, ` +
        `errors=${errorCount}`,
      );
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `[packing-job] Fatal error: ${err.message}`,
        err.stack,
      );
    } finally {
      this.isRunning = false;
    }
  }
}
