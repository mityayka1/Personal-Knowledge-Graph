import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Activity } from '@pkg/entities';
import { LlmDedupService, DedupPair } from './llm-dedup.service';
import { DataQualityService } from '../data-quality/data-quality.service';

const BATCH_COSINE_THRESHOLD = 0.6;
const AUTO_MERGE_CONFIDENCE = 0.9;
const MAX_PAIRS_PER_RUN = 20;

@Injectable()
export class DedupBatchCleanupJob {
  private readonly logger = new Logger(DedupBatchCleanupJob.name);

  constructor(
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
    private readonly llmDedupService: LlmDedupService,
    @Optional()
    private readonly dataQualityService: DataQualityService,
  ) {}

  /**
   * Daily cron at 3:00 AM — find Activity pairs with high embedding similarity,
   * confirm via LLM, and auto-merge confirmed duplicates.
   */
  @Cron('0 3 * * *')
  async run(): Promise<{ activityMerged: number; pairsChecked: number }> {
    this.logger.log('Starting daily dedup batch cleanup...');

    try {
      const pairs = await this.findSimilarActivityPairs();

      if (pairs.length === 0) {
        this.logger.log('No similar activity pairs found');
        return { activityMerged: 0, pairsChecked: 0 };
      }

      this.logger.log(`Found ${pairs.length} activity pair(s) with similarity >= ${BATCH_COSINE_THRESHOLD}`);

      const dedupPairs: DedupPair[] = pairs.map((p) => ({
        newItem: { type: 'activity' as const, name: p.name_a },
        existingItem: { id: p.id_b, type: 'activity' as const, name: p.name_b },
      }));

      const decisions = await this.llmDedupService.decideBatch(dedupPairs);

      let merged = 0;
      for (let i = 0; i < decisions.length; i++) {
        const decision = decisions[i];
        const pair = pairs[i];

        if (decision.isDuplicate && decision.confidence >= AUTO_MERGE_CONFIDENCE) {
          if (!this.dataQualityService) {
            this.logger.warn('DataQualityService not available, skipping merge');
            continue;
          }

          try {
            await this.dataQualityService.mergeActivities(pair.id_a, [pair.id_b]);
            merged++;
            this.logger.log(
              `Auto-merged activities: "${pair.name_a}" + "${pair.name_b}" ` +
                `(confidence: ${decision.confidence.toFixed(2)})`,
            );
          } catch (error: any) {
            this.logger.warn(`Failed to merge ${pair.id_a} + ${pair.id_b}: ${error.message}`);
          }
        }
      }

      this.logger.log(`Daily dedup cleanup complete: merged=${merged}, checked=${pairs.length}`);
      return { activityMerged: merged, pairsChecked: pairs.length };
    } catch (error: any) {
      this.logger.error(`Daily dedup cleanup failed: ${error.message}`, error.stack);
      return { activityMerged: 0, pairsChecked: 0 };
    }
  }

  /**
   * Find Activity pairs where embedding cosine similarity >= threshold.
   * Uses self-join on activity table with pgvector distance operator.
   */
  private async findSimilarActivityPairs(): Promise<
    Array<{ id_a: string; name_a: string; id_b: string; name_b: string; similarity: number }>
  > {
    return this.activityRepo
      .createQueryBuilder('a')
      .select('a.id', 'id_a')
      .addSelect('a.name', 'name_a')
      .addSelect('b.id', 'id_b')
      .addSelect('b.name', 'name_b')
      .addSelect('1 - (a.embedding <=> b.embedding)', 'similarity')
      .innerJoin(Activity, 'b', 'a.id < b.id')
      .where('a.embedding IS NOT NULL')
      .andWhere('b.embedding IS NOT NULL')
      .andWhere('1 - (a.embedding <=> b.embedding) >= :threshold', { threshold: BATCH_COSINE_THRESHOLD })
      .orderBy('similarity', 'DESC')
      .limit(MAX_PAIRS_PER_RUN)
      .getRawMany();
  }
}
