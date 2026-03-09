import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EntityFact, FactType } from '@pkg/entities';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';
import { normalizeFactType, getFactCategory } from '../../common/utils/fact-validation';

interface ReclassificationDecision {
  factId: string;
  newType: string | null;
  reason: string;
}

const RECLASSIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          factId: { type: 'string', description: 'UUID of the fact' },
          newType: {
            type: ['string', 'null'],
            enum: [
              'position', 'company', 'department', 'specialization', 'skill',
              'education', 'role', 'birthday', 'location', 'family', 'hobby',
              'language', 'health', 'status', 'communication', 'preference',
              'inn', 'legal_address', null,
            ],
            description: 'New fact type or null if this is a temporary event, not a stable attribute',
          },
          reason: { type: 'string', description: 'Brief reason for the decision' },
        },
        required: ['factId', 'newType', 'reason'],
      },
    },
  },
  required: ['decisions'],
};

@Injectable()
export class ActivityFactReclassificationService {
  private readonly logger = new Logger(ActivityFactReclassificationService.name);

  constructor(
    @InjectRepository(EntityFact)
    private factRepo: Repository<EntityFact>,
    private claudeAgentService: ClaudeAgentService,
  ) {}

  async reclassify(): Promise<{
    total: number;
    reclassified: number;
    deleted: number;
    errors: number;
  }> {
    const activityFacts = await this.factRepo.find({
      where: { factType: 'activity' as any },
    });

    this.logger.log(`Found ${activityFacts.length} activity facts to reclassify`);

    let reclassified = 0;
    let deleted = 0;
    let errors = 0;
    const BATCH_SIZE = 50;

    for (let i = 0; i < activityFacts.length; i += BATCH_SIZE) {
      const batch = activityFacts.slice(i, i + BATCH_SIZE);
      try {
        const decisions = await this.classifyBatch(batch);

        for (const decision of decisions) {
          try {
            if (decision.newType === null) {
              await this.factRepo.softDelete(decision.factId);
              deleted++;
            } else {
              const validType = normalizeFactType(decision.newType);
              if (validType) {
                await this.factRepo.update(decision.factId, {
                  factType: validType,
                  category: getFactCategory(validType),
                });
                reclassified++;
              } else {
                this.logger.warn(`Invalid reclassification type: ${decision.newType} for fact ${decision.factId}`);
                errors++;
              }
            }
          } catch (err) {
            this.logger.error(`Error processing fact ${decision.factId}: ${err}`);
            errors++;
          }
        }

        this.logger.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: reclassified=${reclassified}, deleted=${deleted}`);
      } catch (err) {
        this.logger.error(`Batch error at offset ${i}: ${err}`);
        errors += batch.length;
      }
    }

    return { total: activityFacts.length, reclassified, deleted, errors };
  }

  private async classifyBatch(facts: EntityFact[]): Promise<ReclassificationDecision[]> {
    const factsText = facts.map(f =>
      `- id: ${f.id} | entity: ${f.entityId} | value: "${f.value}" | created: ${f.createdAt?.toISOString().split('T')[0]}`
    ).join('\n');

    const prompt = `Classify each fact below. A FACT is a STABLE ATTRIBUTE of a person/org (skill, hobby, position, status).
A TEMPORARY EVENT ("analyzed errors", "sent invoice", "had a meeting") is NOT a fact — set newType to null.

Allowed types: position, company, department, specialization, skill, education, role, birthday, location, family, hobby, language, health, status, communication, preference, inn, legal_address.

Facts to classify:
${factsText}`;

    const { data } = await this.claudeAgentService.call<{ decisions: ReclassificationDecision[] }>({
      mode: 'oneshot',
      taskType: 'fact_reclassification',
      prompt,
      schema: RECLASSIFICATION_SCHEMA,
      model: 'haiku',
    });

    return data?.decisions ?? [];
  }
}
