import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, IsNull } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import {
  Message,
  InteractionSummary,
  EntityRelationshipProfile,
  EntityFact,
} from '@pkg/entities';
import { ContextRequest, ContextResponse, SynthesizedContext, SearchResult } from '@pkg/shared';
import { EntityService } from '../entity/entity.service';
import { VectorService } from '../search/vector.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { ClaudeCliService } from '../claude-cli/claude-cli.service';

@Injectable()
export class ContextService {
  private readonly logger = new Logger(ContextService.name);
  private readonly schema: object;

  // Tier boundaries in days
  private readonly HOT_TIER_DAYS = 7;
  private readonly WARM_TIER_DAYS = 90;

  constructor(
    @InjectRepository(Message)
    private messageRepo: Repository<Message>,
    @InjectRepository(InteractionSummary)
    private summaryRepo: Repository<InteractionSummary>,
    @InjectRepository(EntityRelationshipProfile)
    private profileRepo: Repository<EntityRelationshipProfile>,
    @InjectRepository(EntityFact)
    private factRepo: Repository<EntityFact>,
    private entityService: EntityService,
    private vectorService: VectorService,
    private embeddingService: EmbeddingService,
    private claudeCliService: ClaudeCliService,
  ) {
    // Load schema from file
    const schemaPath = path.join(
      process.cwd(), '..', '..', 'claude-workspace', 'schemas', 'context-schema.json'
    );
    try {
      this.schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    } catch {
      this.logger.warn('Could not load context schema from file, using inline schema');
      this.schema = this.getInlineSchema();
    }
  }

  async generateContext(request: ContextRequest): Promise<ContextResponse> {
    const { entityId, taskHint, maxTokens = 4000 } = request;
    const now = new Date();

    // 1. Fetch entity with facts
    const entity = await this.entityService.findOne(entityId);

    // 2. PERMANENT tier: Get current facts
    const facts = await this.factRepo.find({
      where: { entityId, validUntil: IsNull() },
      order: { createdAt: 'DESC' },
    });

    // 3. HOT tier: Recent messages (< 7 days)
    const hotCutoff = new Date(now.getTime() - this.HOT_TIER_DAYS * 24 * 60 * 60 * 1000);
    const hotMessages = await this.getHotMessages(entityId, hotCutoff);

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
      warmSummaries,
      profile,
      relevantChunks,
      taskHint,
    });

    // 8. Call Claude for synthesis
    let synthesizedContext: SynthesizedContext | undefined;
    try {
      const { data } = await this.claudeCliService.call<SynthesizedContext>({
        taskType: 'context_synthesis',
        agentName: 'context-synthesizer',
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
        warmSummariesCount: warmSummaries.length,
        coldDecisionsCount: profile?.keyDecisions?.length || 0,
        relevantChunksCount: relevantChunks.length,
        factsIncluded: facts.length,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Get HOT tier: Recent messages from entity
   */
  private async getHotMessages(entityId: string, since: Date): Promise<Message[]> {
    return this.messageRepo.find({
      where: [
        { senderEntityId: entityId, timestamp: MoreThan(since), isArchived: false },
      ],
      order: { timestamp: 'DESC' },
      take: 50,
    });
  }

  /**
   * Get WARM tier: Summaries from 7-90 days
   */
  private async getWarmSummaries(
    entityId: string,
    since: Date,
    until: Date,
  ): Promise<InteractionSummary[]> {
    return this.summaryRepo
      .createQueryBuilder('s')
      .innerJoin('interactions', 'i', 'i.id = s.interaction_id')
      .innerJoin('interaction_participants', 'ip', 'ip.interaction_id = i.id')
      .where('ip.entity_id = :entityId', { entityId })
      .andWhere('s.created_at BETWEEN :since AND :until', { since, until })
      .orderBy('s.created_at', 'DESC')
      .limit(10)
      .getMany();
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
    warmSummaries: InteractionSummary[];
    profile: EntityRelationshipProfile | null;
    relevantChunks: SearchResult[];
    taskHint?: string;
  }): string {
    const { entity, facts, hotMessages, warmSummaries, profile, relevantChunks, taskHint } = params;

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
