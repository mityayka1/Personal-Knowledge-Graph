import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import { Activity, ActivityStatus, PendingApproval } from '@pkg/entities';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';
import { SettingsService } from '../settings/settings.service';
import {
  DailySynthesisExtractionParams,
  DailySynthesisExtractionResult,
  DailySynthesisExtractionResponse,
  ExtractedProject,
  DAILY_SYNTHESIS_EXTRACTION_SCHEMA,
} from './daily-synthesis-extraction.types';
import { DraftExtractionService, DraftExtractionResult } from './draft-extraction.service';
import { ProjectMatchingService } from './project-matching.service';
import { PendingApprovalService } from '../pending-approval/pending-approval.service';
import { VAGUE_PATTERNS } from './extraction-quality.constants';

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

  /** Threshold above which we consider a project match strong enough to skip creation */
  private static readonly MATCH_THRESHOLD = 0.8;

  constructor(
    private readonly claudeAgentService: ClaudeAgentService,
    private readonly settingsService: SettingsService,
    private readonly projectMatchingService: ProjectMatchingService,
    private readonly pendingApprovalService: PendingApprovalService,
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
    @Optional()
    @Inject(forwardRef(() => DraftExtractionService))
    private readonly draftExtractionService: DraftExtractionService | null,
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

    // Filter out low-quality project extractions before matching
    const filteredProjects = this.filterLowQualityProjects(result.data.projects);

    // Match extracted projects to existing activities
    const enrichedProjects = await this.matchProjectsToActivities(
      filteredProjects,
      existingActivities,
    );

    // Filter out low-quality tasks and commitments
    const filteredTasks = this.filterLowQualityTasks(result.data.tasks);
    const filteredCommitments = this.filterLowQualityCommitments(result.data.commitments);

    this.logger.log(
      `[daily-extraction] Completed in ${durationMs}ms: ` +
        `${enrichedProjects.length} projects (${result.data.projects.length - enrichedProjects.length} filtered), ` +
        `${filteredTasks.length} tasks (${result.data.tasks.length - filteredTasks.length} filtered), ` +
        `${filteredCommitments.length} commitments (${result.data.commitments.length - filteredCommitments.length} filtered), ` +
        `${result.data.inferredRelations.length} relations`,
    );

    return {
      projects: enrichedProjects,
      tasks: filteredTasks,
      commitments: filteredCommitments,
      inferredRelations: result.data.inferredRelations,
      extractionSummary: result.data.extractionSummary,
      tokensUsed: result.usage.inputTokens + result.usage.outputTokens,
      durationMs,
      extractedAt: new Date(),
    };
  }

  /**
   * Extract structured data and immediately create draft entities with pending approvals.
   *
   * This is the new Draft Entities + PendingApproval flow that replaces the Redis carousel.
   * Instead of storing extraction results in Redis for carousel navigation,
   * we create DRAFT entities in the database with PendingApproval records.
   *
   * Flow:
   * 1. Call extract() to get projects/tasks/commitments from synthesis
   * 2. Pass results to DraftExtractionService.createDrafts()
   * 3. Return batchId and approvals for Telegram UI
   *
   * @param params - Extraction parameters
   * @param messageRef - Telegram message reference for updates (e.g., "telegram:chat:123:msg:456")
   * @param sourceInteractionId - Optional interaction ID for tracking
   * @returns Extraction result combined with draft creation result
   */
  async extractAndSave(
    params: DailySynthesisExtractionParams,
    messageRef?: string,
    sourceInteractionId?: string,
  ): Promise<{
    extraction: DailySynthesisExtractionResult;
    drafts: DraftExtractionResult;
  }> {
    if (!this.draftExtractionService) {
      throw new Error('DraftExtractionService not available');
    }

    if (!params.ownerEntityId) {
      throw new Error('ownerEntityId is required for extractAndSave');
    }

    // 1. Extract structured data from synthesis
    const extraction = await this.extract(params);

    // 2. Create drafts + pending approvals
    const drafts = await this.draftExtractionService.createDrafts({
      ownerEntityId: params.ownerEntityId,
      facts: [],
      projects: extraction.projects,
      tasks: extraction.tasks,
      commitments: extraction.commitments,
      inferredRelations: extraction.inferredRelations,
      sourceInteractionId,
      messageRef,
      synthesisDate: params.date,
      focusTopic: params.focusTopic,
    });

    this.logger.log(
      `[daily-extraction] extractAndSave complete: ` +
        `batch=${drafts.batchId}, ` +
        `${drafts.counts.projects} projects, ${drafts.counts.tasks} tasks, ` +
        `${drafts.counts.commitments} commitments, ${drafts.counts.relations} relations created as drafts`,
    );

    return { extraction, drafts };
  }

  /**
   * Get pending approvals for a batch.
   * Used by Telegram adapter to display approval UI.
   */
  async getPendingApprovalsForBatch(batchId: string): Promise<PendingApproval[]> {
    const { items } = await this.pendingApprovalService.list({ batchId });
    this.logger.debug(
      `[daily-extraction] getPendingApprovalsForBatch(${batchId}): ${items.length} approvals`,
    );
    return items;
  }

  /**
   * Load existing activities for context and matching.
   */
  private async loadExistingActivities(ownerEntityId?: string): Promise<Activity[]> {
    // Two-tier: confirmed activities first (active/completed), then recent drafts
    const addOwnerFilter = (qb: ReturnType<Repository<Activity>['createQueryBuilder']>) => {
      if (ownerEntityId) {
        qb.andWhere('a.ownerEntityId = :ownerEntityId', { ownerEntityId });
      }
      return qb;
    };

    const baseSelect = ['a.id', 'a.name', 'a.activityType', 'a.status', 'a.clientEntityId', 'a.description', 'a.tags'];

    const [activeActivities, recentDrafts] = await Promise.all([
      addOwnerFilter(
        this.activityRepo
          .createQueryBuilder('a')
          .select(baseSelect)
          .leftJoin('a.clientEntity', 'client')
          .addSelect(['client.name'])
          .where('a.status NOT IN (:...excludedStatuses)', {
            excludedStatuses: [ActivityStatus.ARCHIVED, ActivityStatus.CANCELLED, ActivityStatus.DRAFT],
          }),
      )
        .orderBy('a.updatedAt', 'DESC')
        .limit(80)
        .getMany(),
      addOwnerFilter(
        this.activityRepo
          .createQueryBuilder('a')
          .select(baseSelect)
          .leftJoin('a.clientEntity', 'client')
          .addSelect(['client.name'])
          .where('a.status = :draft', { draft: ActivityStatus.DRAFT }),
      )
        .orderBy('a.updatedAt', 'DESC')
        .limit(20)
        .getMany(),
    ]);

    // Merge, deduplicate
    const seenIds = new Set<string>();
    const merged: Activity[] = [];
    for (const a of [...activeActivities, ...recentDrafts]) {
      if (!seenIds.has(a.id)) {
        seenIds.add(a.id);
        merged.push(a);
      }
    }
    return merged;
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
      for (const a of items.slice(0, 20)) {
        const client = a.clientEntity ? ` (клиент: ${a.clientEntity.name})` : '';
        const tags = a.tags?.length ? ` [теги: ${a.tags.join(', ')}]` : '';
        const desc = a.description ? `\n      ${a.description}` : '';
        lines.push(`  - ${a.name}${client} [${a.status}] (id: ${a.id})${tags}${desc}`);
      }
      if (items.length > 20) {
        lines.push(`  ... и ещё ${items.length - 20}`);
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

1. **ПРОЕКТЫ** — упоминания проектов, инициатив, дел над которыми ведётся работа
   - Если проект похож на существующий — установи isNew: false и укажи existingActivityId
   - Если это новый проект — установи isNew: true
   - Извлеки упомянутых участников и клиента
   - ОБЯЗАТЕЛЬНО добавь description (2-3 предложения): что это за проект, какова его цель, что конкретно делается
   - Добавь priority, deadline, tags где доступны

2. **ЗАДАЧИ** — конкретные действия, TODO, что нужно сделать
   - Определи статус: pending (нужно сделать), in_progress (в работе), done (сделано)
   - Если задача привязана к проекту — укажи projectName
   - Если есть дедлайн — укажи в формате ISO 8601

   **НЕ извлекай как задачу если:**
   - Нет конкретного объекта действия ("оплатить что-нибудь", "сделать что-то")
   - Нет определённости по времени И контексту ("когда надо будет", "когда-нибудь")
   - title должен отвечать на вопрос "ЧТО ИМЕННО сделать?"

3. **ОБЯЗАТЕЛЬСТВА** — обещания, договорённости, напоминания
   - Определи кто кому что обещал
   - "self" означает владельца системы (автора отчёта)
   - Типы: promise (обещал сделать), request (просьба от другого), agreement (взаимная договорённость)
   - Если обязательство связано с проектом — укажи projectName

   **КРИТЕРИИ КАЧЕСТВА ОБЯЗАТЕЛЬСТВ — НЕ извлекай если:**
   - Нет конкретного действия или объекта ("написать что-то", "сделать кое-что")
   - Фраза полностью неопределённая без привязки к проекту, срокам или контексту
   - Это просто размышление вслух ("может попробую", "не знаю, посмотрим")
   - what должен содержать конкретику: ЧТО именно, КОМУ, или В РАМКАХ ЧЕГО

4. **СВЯЗИ** — кто с кем работает, кто клиент, кто ответственный
   - project_member: человек участвует в проекте
   - works_on: человек работает над задачей
   - client_of: клиент проекта
   - responsible_for: ответственный за направление

══════════════════════════════════════════
КРИТЕРИИ ИЗВЛЕЧЕНИЯ ПРОЕКТОВ
══════════════════════════════════════════

Проект ДОЛЖЕН удовлетворять хотя бы 3 из 5 индикаторов:
1. **Duration (hasDuration)** — работа охватывает несколько дней/недель/месяцев
2. **Structure (hasStructure)** — есть под-задачи, этапы или вехи
3. **Deliverable (hasDeliverable)** — есть конкретный результат (документ, продукт, событие)
4. **Team (hasTeam)** — вовлечены несколько людей
5. **Explicit context (hasExplicitContext)** — явно упомянуто как "проект", "работа", "инициатива"

НЕ извлекай как проекты:
- Разовые покупки ("купить молоко", "заказать оборудование")
- Простые напоминания ("позвонить завтра")
- Одношаговые задачи без командного участия
- Общие темы без конкретных действий

Для каждого проекта заполни projectIndicators с boolean значениями для каждого критерия.

**description ОБЯЗАТЕЛЬНО** — опиши суть проекта своими словами на основе контекста из отчёта.
Хорошее описание: "Разработка системы мониторинга для клиента X. Включает бэкенд на Node.js и дашборд. Текущий этап — интеграция с API клиента."
Плохое описание: "Проект" или "Работа над проектом"

Также извлеки: priority, deadline, tags где доступны.

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

5. Для commitments: если обязательство явно связано с проектом или задачей, укажи projectName

Заполни все обязательные поля JSON Schema.
`;
  }

  /**
   * Filter out low-quality project extractions.
   * Projects with low confidence or insufficient indicators are removed.
   *
   * Note: The prompt asks Claude for 3/5 indicators, but code accepts 2/5 as a safety net.
   * This intentional relaxation accounts for LLM extraction inaccuracies.
   */
  private filterLowQualityProjects(projects: ExtractedProject[]): ExtractedProject[] {
    return projects.filter((project) => {
      // Minimum confidence threshold
      if (project.confidence < 0.6) {
        this.logger.debug(
          `[daily-extraction] Filtered project "${project.name}": low confidence ${project.confidence}`,
        );
        return false;
      }

      // Check project indicators (need at least 2 of 5)
      if (project.projectIndicators) {
        const indicatorCount = Object.values(project.projectIndicators).filter(Boolean).length;
        if (indicatorCount < 2) {
          this.logger.debug(
            `[daily-extraction] Filtered project "${project.name}": only ${indicatorCount}/5 indicators`,
          );
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Filter out low-quality task extractions.
   * Tasks with vague titles, low confidence, or no actionable content are removed.
   */
  private filterLowQualityTasks(
    tasks: DailySynthesisExtractionResponse['tasks'],
  ): DailySynthesisExtractionResponse['tasks'] {
    return tasks.filter((task) => {
      const title = task.title.trim();

      if (task.confidence < 0.7) {
        this.logger.debug(
          `[daily-extraction] Filtered task "${title}": low confidence ${task.confidence}`,
        );
        return false;
      }

      if (title.length < 10) {
        this.logger.debug(
          `[daily-extraction] Filtered task "${title}": title too short (${title.length} chars)`,
        );
        return false;
      }

      const hasVagueWord = VAGUE_PATTERNS.some((pattern) => pattern.test(title));
      if (hasVagueWord) {
        const hasAnchor = task.projectName || task.deadline;
        if (!hasAnchor) {
          this.logger.debug(
            `[daily-extraction] Filtered task "${title}": vague content without project/deadline anchor`,
          );
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Filter out low-quality commitment extractions.
   * Commitments with vague titles, low confidence, or no actionable content are removed.
   */
  private filterLowQualityCommitments(
    commitments: DailySynthesisExtractionResponse['commitments'],
  ): DailySynthesisExtractionResponse['commitments'] {
    return commitments.filter((commitment) => {
      const what = commitment.what.trim();

      if (commitment.confidence < 0.7) {
        this.logger.debug(
          `[daily-extraction] Filtered commitment "${what}": low confidence ${commitment.confidence}`,
        );
        return false;
      }

      if (what.length < 10) {
        this.logger.debug(
          `[daily-extraction] Filtered commitment "${what}": title too short (${what.length} chars)`,
        );
        return false;
      }

      const hasVagueWord = VAGUE_PATTERNS.some((pattern) => pattern.test(what));
      if (hasVagueWord) {
        const hasAnchor = commitment.projectName || commitment.deadline;
        if (!hasAnchor) {
          this.logger.debug(
            `[daily-extraction] Filtered commitment "${what}": vague content without project/deadline anchor`,
          );
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Match extracted projects to existing activities using ProjectMatchingService.
   *
   * Uses Levenshtein-based fuzzy matching (threshold 0.8) instead of simple
   * substring includes() to avoid false positives (e.g. "PKG" matching "PKG Dashboard").
   * Projects that don't match strongly are left for DraftExtractionService.createDrafts()
   * which has even more sophisticated matching with client/tags/description boosts.
   */
  private async matchProjectsToActivities(
    projects: DailySynthesisExtractionResponse['projects'],
    existingActivities: Activity[],
  ): Promise<DailySynthesisExtractionResponse['projects']> {
    const results: DailySynthesisExtractionResponse['projects'] = [];

    for (const project of projects) {
      // If already matched by LLM, keep it
      if (project.existingActivityId) {
        results.push(project);
        continue;
      }

      // Use ProjectMatchingService for fuzzy Levenshtein matching
      const match = this.projectMatchingService.findBestMatchInList(
        project.name,
        existingActivities,
      );

      if (match && match.similarity >= DailySynthesisExtractionService.MATCH_THRESHOLD) {
        this.logger.debug(
          `[daily-extraction] Matched project "${project.name}" → ` +
            `"${match.activity.name}" (similarity: ${match.similarity.toFixed(3)})`,
        );
        results.push({
          ...project,
          isNew: false,
          existingActivityId: match.activity.id,
        });
      } else {
        results.push(project);
      }
    }

    return results;
  }
}
