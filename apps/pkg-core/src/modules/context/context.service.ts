import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository, IsNull } from 'typeorm';
import {
  Message,
  InteractionSummary,
  EntityRelationshipProfile,
  EntityFact,
  TranscriptSegment,
} from '@pkg/entities';
import { ContextRequest, ContextResponse, SynthesizedContext, SearchResult } from '@pkg/shared';
import { EntityService } from '../entity/entity.service';
import { VectorService } from '../search/vector.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';
import { SchemaLoaderService } from '../claude-agent/schema-loader.service';

@Injectable()
export class ContextService {
  private readonly logger = new Logger(ContextService.name);
  private readonly schema: object;

  // Tier boundaries in days (configurable via ConfigService)
  private readonly HOT_TIER_DAYS: number;
  private readonly WARM_TIER_DAYS: number;

  constructor(
    @InjectRepository(Message)
    private messageRepo: Repository<Message>,
    @InjectRepository(InteractionSummary)
    private summaryRepo: Repository<InteractionSummary>,
    @InjectRepository(EntityRelationshipProfile)
    private profileRepo: Repository<EntityRelationshipProfile>,
    @InjectRepository(EntityFact)
    private factRepo: Repository<EntityFact>,
    @InjectRepository(TranscriptSegment)
    private segmentRepo: Repository<TranscriptSegment>,
    private entityService: EntityService,
    private vectorService: VectorService,
    private embeddingService: EmbeddingService,
    private claudeAgentService: ClaudeAgentService,
    private schemaLoader: SchemaLoaderService,
    private configService: ConfigService,
  ) {
    // Load tier boundaries from config (with defaults)
    this.HOT_TIER_DAYS = this.configService.get<number>('context.hotTierDays', 7);
    this.WARM_TIER_DAYS = this.configService.get<number>('context.warmTierDays', 90);
    // Load schema using SchemaLoaderService
    this.schema = this.schemaLoader.load('context', this.getInlineSchema());
  }

  async generateContext(request: ContextRequest): Promise<ContextResponse> {
    const { entityId, taskHint } = request;
    const now = new Date();

    // 1. Fetch entity with facts
    const entity = await this.entityService.findOne(entityId);

    // Skip context generation for bot entities
    if (entity.isBot) {
      this.logger.debug(`Entity ${entityId} is a bot, returning minimal context`);
      return {
        entityId: entity.id,
        entityName: entity.name,
        contextMarkdown: `## ${entity.name}\n\n*Это бот. Контекст взаимодействий не генерируется.*`,
        tokenCount: 20,
        sources: {
          hotMessagesCount: 0,
          hotSegmentsCount: 0,
          warmSummariesCount: 0,
          coldDecisionsCount: 0,
          relevantChunksCount: 0,
          factsIncluded: 0,
        },
        generatedAt: new Date().toISOString(),
      };
    }

    // 2. PERMANENT tier: Get current facts
    const facts = await this.factRepo.find({
      where: { entityId, validUntil: IsNull() },
      order: { createdAt: 'DESC' },
    });

    // 3. HOT tier: Recent messages and transcript segments (< 7 days)
    const hotCutoff = new Date(now.getTime() - this.HOT_TIER_DAYS * 24 * 60 * 60 * 1000);
    const hotMessages = await this.getHotMessages(entityId, hotCutoff);
    const hotSegments = await this.getHotSegments(entityId, hotCutoff);

    // 4. WARM tier: Summaries (7-90 days)
    const warmCutoff = new Date(now.getTime() - this.WARM_TIER_DAYS * 24 * 60 * 60 * 1000);
    const warmSummaries = await this.getWarmSummaries(entityId, warmCutoff, hotCutoff);

    // 5. COLD tier: Entity profile
    const profile = await this.profileRepo.findOne({ where: { entityId } });

    // 6. RELEVANT: Vector search for task_hint
    let relevantChunks: SearchResult[] = [];
    if (taskHint) {
      relevantChunks = await this.getRelevantChunks(taskHint, entityId);
    }

    // 7. Build prompt for Claude synthesis
    const prompt = this.buildSynthesisPrompt({
      entity,
      facts,
      hotMessages,
      hotSegments,
      warmSummaries,
      profile,
      relevantChunks,
      taskHint,
    });

    // 8. Call Claude for synthesis
    let synthesizedContext: SynthesizedContext | undefined;
    try {
      const { data } = await this.claudeAgentService.call<SynthesizedContext>({
        mode: 'oneshot',
        taskType: 'context_synthesis',
        prompt,
        schema: this.schema,
        model: 'sonnet',
        referenceType: 'entity',
        referenceId: entityId,
      });
      synthesizedContext = data;
    } catch (error) {
      this.logger.error(`Context synthesis failed for entity ${entityId}`, error);
      // Fall back to basic context without synthesis
    }

    // 9. Build context markdown
    const contextMarkdown = this.buildContextMarkdown({
      entity,
      facts,
      profile,
      synthesizedContext,
    });

    // 10. Build response
    return {
      entityId: entity.id,
      entityName: entity.name,
      contextMarkdown,
      synthesizedContext,
      tokenCount: this.estimateTokens(contextMarkdown),
      sources: {
        hotMessagesCount: hotMessages.length,
        hotSegmentsCount: hotSegments.length,
        warmSummariesCount: warmSummaries.length,
        coldDecisionsCount: profile?.keyDecisions?.length || 0,
        relevantChunksCount: relevantChunks.length,
        factsIncluded: facts.length,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Get HOT tier: Recent messages from/to entity
   * Includes both incoming and outgoing messages from interactions where entity is a participant
   */
  private async getHotMessages(entityId: string, since: Date): Promise<Message[]> {
    // Use JOIN through interaction_participants to get ALL messages from conversations with this entity
    // This includes both incoming messages FROM entity and outgoing messages TO entity
    return this.messageRepo
      .createQueryBuilder('m')
      .innerJoin('m.interaction', 'i')
      .innerJoin('i.participants', 'ip')
      .where('ip.entity_id = :entityId', { entityId })
      .andWhere('m.timestamp > :since', { since })
      .andWhere('m.is_archived = :isArchived', { isArchived: false })
      .orderBy('m.timestamp', 'DESC')
      .take(50)
      .getMany();
  }

  /**
   * Get HOT tier: Recent transcript segments from calls with entity
   */
  private async getHotSegments(entityId: string, since: Date): Promise<TranscriptSegment[]> {
    // Using raw query to avoid TypeORM QueryBuilder issues with complex joins
    const segments = await this.segmentRepo.query(
      `SELECT ts.* FROM transcript_segments ts
       INNER JOIN interactions i ON i.id = ts.interaction_id
       INNER JOIN interaction_participants ip ON ip.interaction_id = i.id
       WHERE ip.entity_id = $1 AND ts.created_at > $2
       ORDER BY ts.start_time DESC
       LIMIT 30`,
      [entityId, since],
    );
    return segments;
  }

  /**
   * Get WARM tier: Summaries from 7-90 days
   */
  private async getWarmSummaries(
    entityId: string,
    since: Date,
    until: Date,
  ): Promise<InteractionSummary[]> {
    // Using raw query to avoid TypeORM QueryBuilder issues with complex joins
    const summaries = await this.summaryRepo.query(
      `SELECT s.* FROM interaction_summaries s
       INNER JOIN interactions i ON i.id = s.interaction_id
       INNER JOIN interaction_participants ip ON ip.interaction_id = i.id
       WHERE ip.entity_id = $1 AND s.created_at BETWEEN $2 AND $3
       ORDER BY s.created_at DESC
       LIMIT 10`,
      [entityId, since, until],
    );
    return summaries;
  }

  /**
   * Get RELEVANT: Vector search for task_hint
   */
  private async getRelevantChunks(taskHint: string, entityId: string): Promise<SearchResult[]> {
    try {
      const embedding = await this.embeddingService.generate(taskHint);
      return this.vectorService.search(embedding, entityId, undefined, 5);
    } catch (error) {
      this.logger.warn(`Vector search failed for task_hint: ${error}`);
      return [];
    }
  }

  /**
   * Build prompt for Claude context synthesis
   */
  private buildSynthesisPrompt(params: {
    entity: { id: string; name: string; type: string; organization?: { name: string } | null };
    facts: EntityFact[];
    hotMessages: Message[];
    hotSegments: TranscriptSegment[];
    warmSummaries: InteractionSummary[];
    profile: EntityRelationshipProfile | null;
    relevantChunks: SearchResult[];
    taskHint?: string;
  }): string {
    const { entity, facts, hotMessages, hotSegments, warmSummaries, profile, relevantChunks, taskHint } = params;

    const sections: string[] = [];

    // Entity header
    sections.push(`## Entity
- Имя: ${entity.name}
- Тип: ${entity.type}
${entity.organization ? `- Организация: ${entity.organization.name}` : ''}`);

    // Task hint (if provided)
    if (taskHint) {
      sections.push(`\n## Task Hint
${taskHint}`);
    }

    // PERMANENT: Facts
    const factsSection = facts.length > 0
      ? facts.map(f => `- ${f.factType}: ${f.value || f.valueDate || 'N/A'}`).join('\n')
      : '(нет известных фактов)';
    sections.push(`\n## PERMANENT: Facts
${factsSection}`);

    // COLD: Relationship Profile
    if (profile) {
      const milestonesList = (profile.milestones || [])
        .slice(0, 3)
        .map(m => `  - ${m.date}: ${m.title}`)
        .join('\n');
      const decisionsList = (profile.keyDecisions || [])
        .slice(0, 5)
        .map(d => `  - ${d.date}: ${d.description}`)
        .join('\n');

      sections.push(`\n## COLD: Relationship Profile
- Type: ${profile.relationshipType}
- Frequency: ${profile.communicationFrequency}
- Summary: ${profile.relationshipSummary}
- Milestones:
${milestonesList || '  (нет)'}
- Key Decisions:
${decisionsList || '  (нет)'}`);
    }

    // WARM: Recent Summaries
    if (warmSummaries.length > 0) {
      const summariesSection = warmSummaries.map(s => {
        const decisions = (s.decisions || [])
          .filter(d => d.importance === 'high')
          .map(d => `  - [${d.importance}] ${d.description}`)
          .join('\n');
        return `### ${s.createdAt.toISOString().split('T')[0]}
Summary: ${s.summaryText}
Key Points: ${(s.keyPoints || []).join(', ')}
${decisions ? `Decisions:\n${decisions}` : ''}`;
      }).join('\n\n');

      sections.push(`\n## WARM: Recent Summaries (7-90 дней)
${summariesSection}`);
    }

    // HOT: Recent Messages
    if (hotMessages.length > 0) {
      const messagesSection = hotMessages
        .slice(0, 20)
        .reverse()
        .map(m => {
          const timestamp = m.timestamp.toISOString().split('T')[0];
          const sender = m.isOutgoing ? 'Я' : entity.name;
          return `[${timestamp}] ${sender}: ${(m.content || '(медиа)').slice(0, 200)}`;
        })
        .join('\n');

      sections.push(`\n## HOT: Recent Messages (< 7 дней)
${messagesSection}`);
    }

    // HOT: Recent Call Transcripts
    if (hotSegments.length > 0) {
      const segmentsSection = hotSegments
        .slice(0, 15)
        .reverse()
        .map(s => {
          const timestamp = s.createdAt.toISOString().split('T')[0];
          const speaker = s.speakerLabel === 'self' ? 'Я' : entity.name;
          return `[${timestamp}] ${speaker}: ${(s.content || '').slice(0, 200)}`;
        })
        .join('\n');

      sections.push(`\n## HOT: Recent Call Transcripts (< 7 дней)
${segmentsSection}`);
    }

    // RELEVANT: Task-related chunks
    if (relevantChunks.length > 0) {
      const chunksSection = relevantChunks
        .map(c => `[${c.timestamp}] ${c.content.slice(0, 200)}`)
        .join('\n');

      sections.push(`\n## RELEVANT: Task-related Chunks
${chunksSection}`);
    }

    // Task
    sections.push(`\n## Задача
Создай компактный контекст для подготовки к общению согласно JSON схеме.`);

    return sections.join('\n');
  }

  /**
   * Build final context markdown
   */
  private buildContextMarkdown(params: {
    entity: { id: string; name: string; type: string; organization?: { name: string } | null; notes?: string | null };
    facts: EntityFact[];
    profile: EntityRelationshipProfile | null;
    synthesizedContext?: SynthesizedContext;
  }): string {
    const { entity, facts, profile, synthesizedContext } = params;
    const sections: string[] = [];

    // Header
    sections.push(`## Контекст: ${entity.name}`);
    sections.push('');

    // Synthesized context (if available)
    if (synthesizedContext) {
      sections.push(`### Статус`);
      sections.push(synthesizedContext.currentStatus);
      sections.push('');

      if (synthesizedContext.recentContext.length > 0) {
        sections.push('### Актуальное');
        synthesizedContext.recentContext.forEach((item: string) => {
          sections.push(`- ${item}`);
        });
        sections.push('');
      }

      if (synthesizedContext.keyFacts.length > 0) {
        sections.push('### Ключевые факты');
        synthesizedContext.keyFacts.forEach((fact: string) => {
          sections.push(`- ${fact}`);
        });
        sections.push('');
      }

      if (synthesizedContext.recommendations.length > 0) {
        sections.push('### Рекомендации');
        synthesizedContext.recommendations.forEach((rec: string) => {
          sections.push(`- ${rec}`);
        });
        sections.push('');
      }
    } else {
      // Fallback: Basic context without synthesis
      sections.push(`**Тип:** ${entity.type}`);
      if (entity.organization) {
        sections.push(`**Организация:** ${entity.organization.name}`);
      }
      if (entity.notes) {
        sections.push(`**Заметки:** ${entity.notes}`);
      }
      sections.push('');

      // Facts
      if (facts.length > 0) {
        sections.push('### Факты');
        facts.forEach(fact => {
          const value = fact.valueDate
            ? new Date(fact.valueDate).toLocaleDateString('ru-RU')
            : fact.value;
          sections.push(`- **${fact.factType}:** ${value}`);
        });
        sections.push('');
      }

      // Profile summary
      if (profile) {
        sections.push('### Отношения');
        sections.push(`- **Тип:** ${profile.relationshipType}`);
        sections.push(`- **Частота:** ${profile.communicationFrequency}`);
        sections.push(profile.relationshipSummary);
        sections.push('');
      }
    }

    return sections.join('\n');
  }

  /**
   * Estimate token count
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Inline schema fallback
   */
  private getInlineSchema(): object {
    return {
      type: 'object',
      properties: {
        currentStatus: { type: 'string', minLength: 10 },
        recentContext: { type: 'array', items: { type: 'string' } },
        keyFacts: { type: 'array', items: { type: 'string' } },
        recommendations: { type: 'array', items: { type: 'string' } },
      },
      required: ['currentStatus', 'recentContext', 'keyFacts', 'recommendations'],
    };
  }
}
