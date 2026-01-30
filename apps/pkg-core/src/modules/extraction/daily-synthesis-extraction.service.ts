import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import { Activity, ActivityStatus } from '@pkg/entities';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';
import { SettingsService } from '../settings/settings.service';
import {
  DailySynthesisExtractionParams,
  DailySynthesisExtractionResult,
  DailySynthesisExtractionResponse,
  DAILY_SYNTHESIS_EXTRACTION_SCHEMA,
} from './daily-synthesis-extraction.types';

/**
 * DailySynthesisExtractionService — extracts structured data from /daily synthesis.
 *
 * This is Phase 2 of Jarvis Foundation:
 * 1. User runs /daily → gets summary text
 * 2. This service extracts: projects, tasks, commitments, relations
 * 3. Extracted data can be used to:
 *    - Suggest new Activity creation
 *    - Link mentions to existing activities
 *    - Create Commitments for tracking
 *    - Infer entity-activity relationships
 *
 * Uses oneshot mode with structured output (JSON Schema constrained decoding).
 */
@Injectable()
export class DailySynthesisExtractionService {
  private readonly logger = new Logger(DailySynthesisExtractionService.name);

  constructor(
    private readonly claudeAgentService: ClaudeAgentService,
    private readonly settingsService: SettingsService,
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
  ) {}

  /**
   * Extract structured data from daily synthesis text.
   *
   * @param params - Synthesis text and optional context
   * @returns Extracted projects, tasks, commitments, and inferred relations
   */
  async extract(
    params: DailySynthesisExtractionParams,
  ): Promise<DailySynthesisExtractionResult> {
    const startTime = Date.now();
    const { synthesisText, date, focusTopic, ownerEntityId } = params;

    this.logger.debug(
      `[daily-extraction] Starting extraction, text length: ${synthesisText.length}, ` +
        `date: ${date || 'today'}, focus: ${focusTopic || 'none'}`,
    );

    // Load existing activities for matching
    const existingActivities = await this.loadExistingActivities(ownerEntityId);
    const activityContext = this.formatActivityContext(existingActivities);

    // Build prompt
    const prompt = this.buildPrompt({
      synthesisText,
      date,
      focusTopic,
      activityContext,
    });

    // Get model from settings (default: sonnet for complex schema reliability)
    const model = await this.settingsService.getDailySynthesisModel();

    this.logger.debug(`[daily-extraction] Using model: ${model}`);

    // Call Claude with structured output
    // Note: maxTurns must be >= 2 when using outputFormat with json_schema
    // because Claude needs one turn to call StructuredOutput tool and another to complete
    const result = await this.claudeAgentService.call<DailySynthesisExtractionResponse>({
      mode: 'oneshot',
      taskType: 'daily_brief', // Reusing existing task type
      prompt,
      model,
      schema: DAILY_SYNTHESIS_EXTRACTION_SCHEMA,
      maxTurns: 5, // Complex schema may need more iterations
      timeout: 120000, // 2 minutes (large prompts need more time)
    });

    const durationMs = Date.now() - startTime;

    // Match extracted projects to existing activities
    const enrichedProjects = await this.matchProjectsToActivities(
      result.data.projects,
      existingActivities,
    );

    this.logger.log(
      `[daily-extraction] Completed in ${durationMs}ms: ` +
        `${enrichedProjects.length} projects, ${result.data.tasks.length} tasks, ` +
        `${result.data.commitments.length} commitments, ` +
        `${result.data.inferredRelations.length} relations`,
    );

    return {
      projects: enrichedProjects,
      tasks: result.data.tasks,
      commitments: result.data.commitments,
      inferredRelations: result.data.inferredRelations,
      extractionSummary: result.data.extractionSummary,
      tokensUsed: result.usage.inputTokens + result.usage.outputTokens,
      durationMs,
      extractedAt: new Date(),
    };
  }

  /**
   * Load existing activities for context and matching.
   */
  private async loadExistingActivities(ownerEntityId?: string): Promise<Activity[]> {
    const query = this.activityRepo
      .createQueryBuilder('a')
      .select(['a.id', 'a.name', 'a.activityType', 'a.status', 'a.clientEntityId'])
      .leftJoin('a.clientEntity', 'client')
      .addSelect(['client.name'])
      .where('a.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: [ActivityStatus.ARCHIVED, ActivityStatus.CANCELLED],
      })
      .orderBy('a.updatedAt', 'DESC')
      .limit(100);

    if (ownerEntityId) {
      query.andWhere('a.ownerEntityId = :ownerEntityId', { ownerEntityId });
    }

    return query.getMany();
  }

  /**
   * Format existing activities for prompt context.
   */
  private formatActivityContext(activities: Activity[]): string {
    if (activities.length === 0) {
      return 'Нет известных активностей.';
    }

    const grouped: Record<string, Activity[]> = {};
    for (const a of activities) {
      const type = a.activityType;
      if (!grouped[type]) grouped[type] = [];
      grouped[type].push(a);
    }

    const lines: string[] = [];
    for (const [type, items] of Object.entries(grouped)) {
      lines.push(`\n${type.toUpperCase()}:`);
      for (const a of items.slice(0, 10)) {
        const client = a.clientEntity ? ` (клиент: ${a.clientEntity.name})` : '';
        lines.push(`  - ${a.name}${client} [${a.status}] (id: ${a.id})`);
      }
      if (items.length > 10) {
        lines.push(`  ... и ещё ${items.length - 10}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Build prompt for extraction.
   */
  private buildPrompt(params: {
    synthesisText: string;
    date?: string;
    focusTopic?: string;
    activityContext: string;
  }): string {
    const { synthesisText, date, focusTopic, activityContext } = params;

    const dateStr = date || new Date().toISOString().split('T')[0];
    const focusLine = focusTopic ? `\nФокус: "${focusTopic}"` : '';

    return `
Ты — ассистент по извлечению структурированных данных из daily-отчёта.

══════════════════════════════════════════
ЗАДАЧА
══════════════════════════════════════════

Проанализируй daily-отчёт за ${dateStr}${focusLine} и извлеки:

1. **ПРОЕКТЫ** — любые упоминания проектов, инициатив, дел над которыми ведётся работа
   - Если проект похож на существующий — установи isNew: false и укажи existingActivityId
   - Если это новый проект — установи isNew: true
   - Извлеки упомянутых участников и клиента

2. **ЗАДАЧИ** — конкретные действия, TODO, что нужно сделать
   - Определи статус: pending (нужно сделать), in_progress (в работе), done (сделано)
   - Если задача привязана к проекту — укажи projectName
   - Если есть дедлайн — укажи в формате ISO 8601

3. **ОБЯЗАТЕЛЬСТВА** — обещания, договорённости, напоминания
   - Определи кто кому что обещал
   - "self" означает владельца системы (автора отчёта)
   - Типы: promise (обещал сделать), request (просьба от другого), agreement (взаимная договорённость)

4. **СВЯЗИ** — кто с кем работает, кто клиент, кто ответственный
   - project_member: человек участвует в проекте
   - works_on: человек работает над задачей
   - client_of: клиент проекта
   - responsible_for: ответственный за направление

══════════════════════════════════════════
СУЩЕСТВУЮЩИЕ АКТИВНОСТИ (для сопоставления)
══════════════════════════════════════════
${activityContext}

══════════════════════════════════════════
DAILY-ОТЧЁТ ДЛЯ АНАЛИЗА
══════════════════════════════════════════
${synthesisText}

══════════════════════════════════════════
ПРАВИЛА ИЗВЛЕЧЕНИЯ
══════════════════════════════════════════

1. confidence — оценка уверенности от 0 до 1:
   - 0.9+ — явное упоминание с деталями
   - 0.7-0.9 — понятно из контекста
   - 0.5-0.7 — предположение/инференс
   - < 0.5 — не извлекай

2. sourceQuote — короткая цитата из текста (до 100 символов), подтверждающая извлечение

3. При сопоставлении с существующими активностями:
   - Используй fuzzy matching по названию
   - Учитывай контекст (клиент, участники)
   - Если совпадение > 80% — это существующая активность

4. Для self — используй строку "self", не пытайся угадать имя владельца

Заполни все обязательные поля JSON Schema.
`;
  }

  /**
   * Match extracted projects to existing activities.
   */
  private async matchProjectsToActivities(
    projects: DailySynthesisExtractionResponse['projects'],
    existingActivities: Activity[],
  ): Promise<DailySynthesisExtractionResponse['projects']> {
    return projects.map((project) => {
      // If already matched by LLM, keep it
      if (project.existingActivityId) {
        return project;
      }

      // Try fuzzy matching by name
      const normalizedName = project.name.toLowerCase().trim();
      const match = existingActivities.find((a) => {
        const existingName = a.name.toLowerCase().trim();
        return (
          existingName === normalizedName ||
          existingName.includes(normalizedName) ||
          normalizedName.includes(existingName)
        );
      });

      if (match) {
        return {
          ...project,
          isNew: false,
          existingActivityId: match.id,
        };
      }

      return project;
    });
  }
}
