import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  EntityRelationshipProfile,
  InteractionSummary,
  EntityRecord,
  EntityFact,
  RelationshipType,
  CommunicationFrequency,
  RelationshipMilestone,
  KeyDecision,
  OpenActionItem,
} from '@pkg/entities';
import { ClaudeCliService } from '../claude-cli/claude-cli.service';
import { SchemaLoaderService } from '../claude-cli/schema-loader.service';

// Result from Claude CLI profile aggregation
interface ProfileAggregationResult {
  relationshipType: RelationshipType;
  communicationFrequency: CommunicationFrequency;
  relationshipSummary: string;
  relationshipTimeline: string | null;
  milestones: RelationshipMilestone[];
  keyDecisions: KeyDecision[];
  openActionItems: OpenActionItem[];
}

// Aggregated stats from summaries
interface AggregatedStats {
  totalInteractions: number;
  totalMessages: number;
  firstInteractionDate: Date;
  lastMeaningfulContact: Date;
  coverageStart: Date;
  coverageEnd: Date;
  topTopics: string[];
  highImportanceDecisions: Array<{
    date: string;
    description: string;
    quote?: string | null;
  }>;
  openActionItems: Array<{
    description: string;
    owner: 'self' | 'them' | 'both';
  }>;
}

@Injectable()
export class EntityProfileService {
  private readonly logger = new Logger(EntityProfileService.name);
  private readonly schema: object;

  constructor(
    @InjectRepository(EntityRelationshipProfile)
    private profileRepo: Repository<EntityRelationshipProfile>,
    @InjectRepository(InteractionSummary)
    private summaryRepo: Repository<InteractionSummary>,
    @InjectRepository(EntityRecord)
    private entityRepo: Repository<EntityRecord>,
    @InjectRepository(EntityFact)
    private factRepo: Repository<EntityFact>,
    private claudeCliService: ClaudeCliService,
    private schemaLoader: SchemaLoaderService,
    @InjectQueue('entity-profile')
    private profileQueue: Queue,
  ) {
    this.schema = this.schemaLoader.load('profile', this.getInlineSchema());
  }

  /**
   * Weekly cron job: schedule profile aggregation for entities with old interactions
   * Runs every Sunday at 04:00 Moscow time
   */
  @Cron('0 4 * * 0', { timeZone: 'Europe/Moscow' })
  async scheduleWeeklyProfileUpdate(): Promise<void> {
    this.logger.log('Starting weekly profile aggregation scheduling...');

    // Find entities with interactions older than 90 days that need profile update
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90);

    // Get entities that have summaries but no profile or outdated profile
    const entities = await this.entityRepo
      .createQueryBuilder('e')
      .innerJoin('interaction_participants', 'ip', 'ip.entity_id = e.id')
      .innerJoin('interactions', 'i', 'i.id = ip.interaction_id')
      .innerJoin('interaction_summaries', 's', 's.interaction_id = i.id')
      .where('i.ended_at < :cutoff', { cutoff: cutoffDate })
      // NOTE: PostgreSQL-specific INTERVAL syntax. This project is PostgreSQL-only (see ARCHITECTURE.md)
      .andWhere(`(
        NOT EXISTS (
          SELECT 1 FROM entity_relationship_profiles p WHERE p.entity_id = e.id
        )
        OR EXISTS (
          SELECT 1 FROM entity_relationship_profiles p
          WHERE p.entity_id = e.id
          AND p.updated_at < NOW() - INTERVAL '30 days'
        )
      )`)
      .groupBy('e.id')
      .having('COUNT(DISTINCT s.id) >= 3') // At least 3 summarized interactions
      .orderBy('MAX(i.ended_at)', 'DESC')
      .limit(10)
      .getMany();

    for (const entity of entities) {
      await this.profileQueue.add('aggregate', {
        entityId: entity.id,
      }, {
        attempts: 2,
        backoff: { type: 'exponential', delay: 120000 },
      });
    }

    this.logger.log(`Scheduled ${entities.length} entities for profile aggregation`);
  }

  /**
   * Process profile aggregation for a single entity
   */
  async processProfileAggregation(entityId: string): Promise<EntityRelationshipProfile | null> {
    // Fetch entity with organization
    const entity = await this.entityRepo.findOne({
      where: { id: entityId },
      relations: ['organization'],
    });

    if (!entity) {
      throw new Error(`Entity ${entityId} not found`);
    }

    // Fetch all interaction summaries for this entity
    const summaries = await this.summaryRepo
      .createQueryBuilder('s')
      .innerJoin('interactions', 'i', 'i.id = s.interaction_id')
      .innerJoin('interaction_participants', 'ip', 'ip.interaction_id = i.id')
      .where('ip.entity_id = :entityId', { entityId })
      .orderBy('i.started_at', 'ASC')
      .getMany();

    if (summaries.length < 3) {
      this.logger.debug(`Entity ${entityId} has < 3 summaries, skipping profile aggregation`);
      return null;
    }

    // Fetch entity facts
    const facts = await this.factRepo.find({
      where: { entityId, validUntil: IsNull() }, // Only current facts
      order: { createdAt: 'DESC' },
    });

    // Aggregate stats from summaries
    const aggregated = this.aggregateSummaries(summaries);

    // Build prompt for Claude
    const prompt = this.buildProfilePrompt(entity, facts, summaries, aggregated);

    // Call Claude CLI
    const { data, run } = await this.claudeCliService.call<ProfileAggregationResult>({
      taskType: 'profile_aggregation',
      agentName: 'profile-aggregator',
      prompt,
      schema: this.schema,
      model: 'sonnet',
      referenceType: 'entity',
      referenceId: entityId,
    });

    // Prepare profile data
    const profileData: Partial<EntityRelationshipProfile> = {
      entityId,
      relationshipType: data.relationshipType,
      communicationFrequency: data.communicationFrequency,
      relationshipSummary: data.relationshipSummary,
      relationshipTimeline: data.relationshipTimeline,
      firstInteractionDate: aggregated.firstInteractionDate,
      lastMeaningfulContact: aggregated.lastMeaningfulContact,
      totalInteractions: aggregated.totalInteractions,
      totalMessages: aggregated.totalMessages,
      topTopics: aggregated.topTopics,
      milestones: data.milestones,
      keyDecisions: data.keyDecisions,
      openActionItems: data.openActionItems,
      summarizedInteractionsCount: summaries.length,
      coverageStart: aggregated.coverageStart,
      coverageEnd: aggregated.coverageEnd,
      modelVersion: run.model,
    };

    // Save or update profile
    let profile = await this.profileRepo.findOne({ where: { entityId } });

    if (profile) {
      // Update existing profile with explicitly selected fields
      await this.profileRepo.update(profile.id, {
        relationshipType: profileData.relationshipType,
        communicationFrequency: profileData.communicationFrequency,
        relationshipSummary: profileData.relationshipSummary,
        relationshipTimeline: profileData.relationshipTimeline,
        firstInteractionDate: profileData.firstInteractionDate,
        lastMeaningfulContact: profileData.lastMeaningfulContact,
        totalInteractions: profileData.totalInteractions,
        totalMessages: profileData.totalMessages,
        topTopics: profileData.topTopics,
        milestones: profileData.milestones,
        keyDecisions: profileData.keyDecisions,
        openActionItems: profileData.openActionItems,
        summarizedInteractionsCount: profileData.summarizedInteractionsCount,
        coverageStart: profileData.coverageStart,
        coverageEnd: profileData.coverageEnd,
        modelVersion: profileData.modelVersion,
      });
      profile = await this.profileRepo.findOne({ where: { id: profile.id } });
    } else {
      profile = await this.profileRepo.save(this.profileRepo.create(profileData as EntityRelationshipProfile));
    }

    this.logger.log(
      `Aggregated profile for entity ${entityId} (${entity.name}): ` +
      `${summaries.length} summaries → ${data.relationshipType}, ` +
      `${data.milestones.length} milestones, ${data.keyDecisions.length} decisions`
    );

    return profile;
  }

  /**
   * Aggregate stats from interaction summaries
   */
  private aggregateSummaries(summaries: InteractionSummary[]): AggregatedStats {
    const totalMessages = summaries.reduce((sum, s) => sum + (s.messageCount || 0), 0);

    // Extract dates from first and last summaries
    const dates = summaries.map(s => s.createdAt).sort((a, b) => a.getTime() - b.getTime());

    // Collect all key points for topic analysis
    const allKeyPoints = summaries.flatMap(s => s.keyPoints || []);
    const topTopics = this.extractTopTopics(allKeyPoints);

    // Collect HIGH importance decisions
    const highImportanceDecisions = summaries
      .flatMap(s => (s.decisions || [])
        .filter(d => d.importance === 'high')
        .map(d => ({
          date: d.date || s.createdAt.toISOString().split('T')[0],
          description: d.description,
          quote: d.quote,
        }))
      );

    // Collect open action items
    const openActionItems = summaries
      .flatMap(s => (s.actionItems || [])
        .filter(a => a.status === 'open')
        .map(a => ({
          description: a.description,
          owner: a.owner,
        }))
      );

    return {
      totalInteractions: summaries.length,
      totalMessages,
      firstInteractionDate: dates[0] || new Date(),
      lastMeaningfulContact: dates[dates.length - 1] || new Date(),
      coverageStart: dates[0] || new Date(),
      coverageEnd: dates[dates.length - 1] || new Date(),
      topTopics,
      highImportanceDecisions,
      openActionItems,
    };
  }

  /**
   * Extract top topics from key points using simple frequency analysis
   */
  private extractTopTopics(keyPoints: string[]): string[] {
    // Simple word frequency for Russian text
    const wordFreq = new Map<string, number>();
    const stopWords = new Set([
      'и', 'в', 'на', 'с', 'по', 'для', 'что', 'как', 'это', 'от', 'к',
      'а', 'о', 'но', 'из', 'у', 'за', 'так', 'же', 'или', 'бы', 'не',
    ]);

    for (const point of keyPoints) {
      const words = point.toLowerCase().split(/\s+/);
      for (const word of words) {
        if (word.length > 3 && !stopWords.has(word)) {
          wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
        }
      }
    }

    // Get top 5 words as topics
    return Array.from(wordFreq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
  }

  /**
   * Build prompt for profile aggregation
   */
  private buildProfilePrompt(
    entity: EntityRecord,
    facts: EntityFact[],
    summaries: InteractionSummary[],
    aggregated: AggregatedStats,
  ): string {
    // Format facts
    const factsSection = facts.length > 0
      ? facts.map(f => `- ${f.factType}: ${f.value || f.valueDate || 'N/A'}`).join('\n')
      : '(нет известных фактов)';

    // Format summaries
    const summariesSection = summaries.map((s, i) => {
      const decisionsStr = (s.decisions || [])
        .map(d => `  - [${d.importance}] ${d.description}`)
        .join('\n');
      const actionsStr = (s.actionItems || [])
        .map(a => `  - [${a.status}] ${a.description} (${a.owner})`)
        .join('\n');

      return `### Interaction ${i + 1} (${s.createdAt.toISOString().split('T')[0]})
Summary: ${s.summaryText}
Key Points: ${(s.keyPoints || []).join(', ')}
Tone: ${s.tone || 'neutral'}
Decisions:
${decisionsStr || '  (нет)'}
Action Items:
${actionsStr || '  (нет)'}`;
    }).join('\n\n');

    return `## Entity
- Имя: ${entity.name}
- Тип: ${entity.type}
${entity.organization ? `- Организация: ${entity.organization.name}` : ''}

## Известные факты
${factsSection}

## Статистика
- Всего взаимодействий: ${aggregated.totalInteractions}
- Всего сообщений: ${aggregated.totalMessages}
- Первый контакт: ${aggregated.firstInteractionDate.toISOString().split('T')[0]}
- Последний контакт: ${aggregated.lastMeaningfulContact.toISOString().split('T')[0]}

## История взаимодействий (от старых к новым)

${summariesSection}

## Задача
Создай агрегированный профиль отношений согласно JSON схеме.`;
  }

  /**
   * Inline schema fallback
   */
  private getInlineSchema(): object {
    return {
      type: 'object',
      properties: {
        relationshipType: {
          type: 'string',
          enum: ['client', 'partner', 'colleague', 'friend', 'acquaintance', 'vendor', 'other'],
        },
        communicationFrequency: {
          type: 'string',
          enum: ['daily', 'weekly', 'monthly', 'quarterly', 'rare'],
        },
        relationshipSummary: { type: 'string', minLength: 10 },
        relationshipTimeline: { type: ['string', 'null'] },
        milestones: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['date', 'title', 'description'],
          },
        },
        keyDecisions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string' },
              description: { type: 'string' },
              quote: { type: ['string', 'null'] },
            },
            required: ['date', 'description'],
          },
        },
        openActionItems: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              owner: { type: 'string', enum: ['self', 'them', 'both'] },
            },
            required: ['description', 'owner'],
          },
        },
      },
      required: [
        'relationshipType',
        'communicationFrequency',
        'relationshipSummary',
        'milestones',
        'keyDecisions',
        'openActionItems',
      ],
    };
  }
}
