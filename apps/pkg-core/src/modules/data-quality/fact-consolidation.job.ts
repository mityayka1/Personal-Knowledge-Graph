import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { EntityFact, FactType } from '@pkg/entities';
import { FactFusionService } from '../entity/entity-fact/fact-fusion.service';
import { FusionAction } from '../entity/entity-fact/fact-fusion.constants';
import { getFactCategory } from '../../common/utils/fact-validation';

@Injectable()
export class FactConsolidationJob {
  private readonly logger = new Logger(FactConsolidationJob.name);

  constructor(
    @InjectRepository(EntityFact)
    private factRepo: Repository<EntityFact>,
    private factFusionService: FactFusionService,
  ) {}

  /**
   * Weekly consolidation: Sunday 4:00 AM
   * 1. Find duplicates by entity + factType (embedding similarity > 0.75)
   * 2. Smart Fusion for each pair
   * 3. Remove low-confidence facts
   */
  @Cron('0 4 * * 0')
  async consolidate(): Promise<{
    duplicatesFound: number;
    merged: number;
    lowConfidenceRemoved: number;
  }> {
    this.logger.log('Starting weekly fact consolidation');
    let duplicatesFound = 0;
    let merged = 0;
    let lowConfidenceRemoved = 0;

    const entityIds: { entity_id: string }[] = await this.factRepo.query(
      `SELECT DISTINCT entity_id FROM entity_facts WHERE deleted_at IS NULL`,
    );

    for (const { entity_id: entityId } of entityIds) {
      const facts = await this.factRepo.find({
        where: { entityId, validUntil: IsNull() },
        order: { createdAt: 'DESC' },
      });

      const byType = new Map<string, EntityFact[]>();
      for (const fact of facts) {
        const group = byType.get(fact.factType) || [];
        group.push(fact);
        byType.set(fact.factType, group);
      }

      const deprecatedIds = new Set<string>();

      for (const [, typeFacts] of byType) {
        if (typeFacts.length < 2) continue;

        for (let i = 0; i < typeFacts.length; i++) {
          const a = typeFacts[i];
          if (deprecatedIds.has(a.id)) continue;

          for (let j = i + 1; j < typeFacts.length; j++) {
            const b = typeFacts[j];
            if (deprecatedIds.has(b.id)) continue;

            if (a.embedding && b.embedding) {
              const similarity = this.cosineSimilarity(a.embedding, b.embedding);
              if (similarity > 0.75) {
                duplicatesFound++;
                try {
                  const decision = await this.factFusionService.decideFusion(
                    a,
                    b.value || '',
                    b.source,
                  );
                  const factType = b.factType as FactType;
                  await this.factFusionService.applyDecision(a, {
                    type: factType,
                    value: b.value || '',
                    source: b.source,
                    category: getFactCategory(factType),
                  }, decision, entityId);

                  if (decision.action === FusionAction.SUPERSEDE ||
                      decision.action === FusionAction.ENRICH) {
                    merged++;
                  }
                  if (decision.action === FusionAction.SUPERSEDE) {
                    deprecatedIds.add(a.id);
                  }
                } catch (err) {
                  this.logger.warn(`Fusion failed for facts ${a.id} / ${b.id}: ${err}`);
                }
              }
            }
          }
        }
      }

      const lowConf = facts.filter(f => (f.confidence ?? 1) < 0.3);
      for (const fact of lowConf) {
        await this.factRepo.softDelete(fact.id);
        lowConfidenceRemoved++;
      }
    }

    this.logger.log(
      `Consolidation complete: duplicates=${duplicatesFound}, merged=${merged}, ` +
      `lowConfRemoved=${lowConfidenceRemoved}`,
    );

    return { duplicatesFound, merged, lowConfidenceRemoved };
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
