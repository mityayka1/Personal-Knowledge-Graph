import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not } from 'typeorm';
import {
  ExtractedEvent,
  ExtractedEventStatus,
  ExtractedEventType,
  CommitmentType,
} from '@pkg/entities';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';
import { CommitmentService } from '../activity/commitment.service';
import { DataQualityService } from '../data-quality/data-quality.service';
import { ActivityService } from '../activity/activity.service';
import {
  CleanupOptions,
  CleanupResult,
  PhaseAResult,
  PhaseAClaudeResponse,
  PhaseBResult,
  PhaseBClaudeResponse,
  PhaseCResult,
  PhaseCClaudeResponse,
  PHASE_A_SCHEMA,
  PHASE_B_SCHEMA,
  PHASE_C_SCHEMA,
} from './event-cleanup.types';

/**
 * EventCleanupService — автоматическая очистка extracted events и активностей.
 *
 * 3 фазы:
 * A) Дедупликация событий — Claude группирует дубли, отклоняет шум
 * B) Привязка событий к активностям — Claude матчит events → activities, создаёт Commitments
 * C) Дедупликация активностей — Claude находит семантические дубли и шум
 */
@Injectable()
export class EventCleanupService {
  private readonly logger = new Logger(EventCleanupService.name);
  private runningPhase: string | null = null;

  constructor(
    @InjectRepository(ExtractedEvent)
    private readonly eventRepo: Repository<ExtractedEvent>,
    private readonly claudeAgentService: ClaudeAgentService,
    private readonly commitmentService: CommitmentService,
    private readonly dataQualityService: DataQualityService,
    private readonly activityService: ActivityService,
  ) {}

  /**
   * Run auto-cleanup with selected phases.
   */
  async autoCleanup(options: CleanupOptions): Promise<CleanupResult> {
    if (this.runningPhase) {
      throw new ConflictException(
        `Auto-cleanup already in progress: "${this.runningPhase}". Wait for it to finish.`,
      );
    }

    this.logger.log(`Starting auto-cleanup: phases=${options.phases.join(',')}, dryRun=${options.dryRun}`);

    const result: CleanupResult = { dryRun: options.dryRun };

    try {
      if (options.phases.includes('dedup')) {
        this.runningPhase = 'dedup';
        result.phaseA = await this.deduplicateEvents(options.dryRun);
      }

      if (options.phases.includes('match')) {
        this.runningPhase = 'match';
        result.phaseB = await this.matchEventsToActivities(options.dryRun);
      }

      if (options.phases.includes('activities')) {
        this.runningPhase = 'activities';
        result.phaseC = await this.deduplicateActivities(options.dryRun);
      }

      this.logger.log('Auto-cleanup complete');
      return result;
    } finally {
      this.runningPhase = null;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Phase A: Event Deduplication
  // ─────────────────────────────────────────────────────────────

  private async deduplicateEvents(dryRun: boolean): Promise<PhaseAResult> {
    this.logger.log('Phase A: Deduplicating events...');

    // Load non-rejected events
    const events = await this.eventRepo.find({
      where: {
        status: In([ExtractedEventStatus.EXPIRED, ExtractedEventStatus.CONFIRMED]),
      },
      order: { createdAt: 'ASC' },
    });

    if (events.length === 0) {
      return { totalEvents: 0, entitiesProcessed: 0, duplicatesRejected: 0, noiseRejected: 0, errors: [] };
    }

    // Group by entityId
    const byEntity = new Map<string, ExtractedEvent[]>();
    for (const event of events) {
      const key = event.entityId ?? 'no-entity';
      const group = byEntity.get(key) ?? [];
      group.push(event);
      byEntity.set(key, group);
    }

    const result: PhaseAResult = {
      totalEvents: events.length,
      entitiesProcessed: 0,
      duplicatesRejected: 0,
      noiseRejected: 0,
      errors: [],
    };

    const BATCH_SIZE = 30;

    for (const [entityId, entityEvents] of byEntity) {
      // Process in batches if entity has many events
      for (let i = 0; i < entityEvents.length; i += BATCH_SIZE) {
        const batch = entityEvents.slice(i, i + BATCH_SIZE);

        try {
          const eventsList = batch.map((e) => {
            const data = e.extractedData as Record<string, unknown>;
            const what = data?.what ?? data?.topic ?? data?.value ?? '';
            return `- id: ${e.id}\n  Тип: ${e.eventType}\n  Суть: ${what}\n  Цитата: "${e.sourceQuote ?? '—'}"\n  Дата: ${e.createdAt.toISOString().slice(0, 10)}\n  Confidence: ${e.confidence}`;
          }).join('\n\n');

          const prompt = `Проанализируй список извлечённых событий для одного контакта и найди:

1. **Дубликаты** — события об одном и том же (одна задача/обещание из разных сообщений). Выбери лучшее (самое информативное) как keepId, остальные в rejectIds.
2. **Шум** — события без полезной информации (служебные уведомления, бессмысленные фразы, "подтверждение использования инструмента" и т.п.)

СОБЫТИЯ:
${eventsList}

Если дубликатов и шума нет — верни пустые массивы.`;

          const { data } = await this.claudeAgentService.call<PhaseAClaudeResponse>({
            mode: 'oneshot',
            taskType: 'event_cleanup_dedup',
            prompt,
            model: 'haiku',
            schema: PHASE_A_SCHEMA,
            maxTurns: 10,
            timeout: 120_000,
          });

          if (data && !dryRun) {
            // Reject duplicates
            for (const group of data.duplicateGroups) {
              if (group.rejectIds.length > 0) {
                await this.eventRepo.update(
                  { id: In(group.rejectIds) },
                  { status: ExtractedEventStatus.REJECTED },
                );
                result.duplicatesRejected += group.rejectIds.length;
              }
            }

            // Reject noise
            if (data.noiseIds.length > 0) {
              await this.eventRepo.update(
                { id: In(data.noiseIds) },
                { status: ExtractedEventStatus.REJECTED },
              );
              result.noiseRejected += data.noiseIds.length;
            }
          } else if (data && dryRun) {
            // Count without applying
            for (const group of data.duplicateGroups) {
              result.duplicatesRejected += group.rejectIds.length;
            }
            result.noiseRejected += data.noiseIds.length;
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          result.errors.push({ entityId, error: errorMsg });
          this.logger.error(`Phase A batch error for entity ${entityId}: ${errorMsg}`);
        }
      }
      result.entitiesProcessed++;
    }

    this.logger.log(
      `Phase A complete: ${result.duplicatesRejected} duplicates, ${result.noiseRejected} noise rejected` +
      ` (${result.errors.length} errors, dryRun=${dryRun})`,
    );
    return result;
  }

  // ─────────────────────────────────────────────────────────────
  // Phase B: Event → Activity Matching
  // ─────────────────────────────────────────────────────────────

  private async matchEventsToActivities(dryRun: boolean): Promise<PhaseBResult> {
    this.logger.log('Phase B: Matching events to activities...');

    // Load surviving events (not rejected)
    const events = await this.eventRepo.find({
      where: {
        status: In([ExtractedEventStatus.EXPIRED, ExtractedEventStatus.CONFIRMED]),
        eventType: In([
          ExtractedEventType.TASK,
          ExtractedEventType.PROMISE_BY_ME,
          ExtractedEventType.PROMISE_BY_THEM,
          ExtractedEventType.MEETING,
        ]),
      },
      order: { createdAt: 'ASC' },
    });

    // Load all activities
    const { items: activities } = await this.activityService.findAll({ limit: 1000 });

    if (events.length === 0 || activities.length === 0) {
      return { totalEvents: events.length, matched: 0, unmatched: 0, commitmentsCreated: 0, errors: [] };
    }

    // Format activities context (sent with every batch)
    const activitiesContext = activities.map((a) => {
      const desc = a.description ? ` — ${a.description.slice(0, 100)}` : '';
      const client = a.clientEntity?.name ? ` (клиент: ${a.clientEntity.name})` : '';
      return `- id: ${a.id} | ${a.name}${client} [${a.activityType}, ${a.status}]${desc}`;
    }).join('\n');

    const result: PhaseBResult = {
      totalEvents: events.length,
      matched: 0,
      unmatched: 0,
      commitmentsCreated: 0,
      errors: [],
    };

    const BATCH_SIZE = 20;

    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const batch = events.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;

      try {
        const eventsList = batch.map((e) => {
          const data = e.extractedData as Record<string, unknown>;
          const what = data?.what ?? data?.topic ?? '';
          return `- id: ${e.id}\n  Тип: ${e.eventType}\n  Суть: ${what}\n  Цитата: "${e.sourceQuote ?? '—'}"`;
        }).join('\n\n');

        const prompt = `Для каждого события определи, к какому проекту или задаче оно относится.

АКТИВНОСТИ (проекты и задачи):
${activitiesContext}

СОБЫТИЯ:
${eventsList}

Правила:
- Если событие явно относится к активности — укажи activityId
- Если подходящей активности нет — activityId = null
- commitmentType: promise (обещание), request (просьба), agreement (договорённость), deadline (дедлайн), reminder (напоминание)
- Матчи должны быть по смыслу, не по формальному совпадению слов`;

        const { data } = await this.claudeAgentService.call<PhaseBClaudeResponse>({
          mode: 'oneshot',
          taskType: 'event_activity_match',
          prompt,
          model: 'haiku',
          schema: PHASE_B_SCHEMA,
          maxTurns: 10,
          timeout: 120_000,
        });

        if (data?.matches) {
          for (const match of data.matches) {
            if (match.activityId && match.activityId !== 'null') {
              result.matched++;

              if (!dryRun) {
                try {
                  // Find the event to get entityId for commitment
                  const event = batch.find((e) => e.id === match.eventId);
                  if (!event) continue;

                  const eventData = event.extractedData as Record<string, unknown>;
                  const title = (eventData?.what ?? eventData?.topic ?? event.sourceQuote ?? 'Unnamed') as string;

                  await this.commitmentService.create({
                    type: this.mapCommitmentType(match.commitmentType),
                    title: title.slice(0, 255),
                    fromEntityId: event.entityId!,
                    toEntityId: event.promiseToEntityId ?? event.entityId!,
                    activityId: match.activityId,
                    extractedEventId: event.id,
                    confidence: event.confidence,
                    metadata: {
                      autoLinkedBy: 'event_cleanup',
                      matchReason: match.reason,
                    },
                  });
                  result.commitmentsCreated++;
                } catch (err) {
                  const errorMsg = err instanceof Error ? err.message : String(err);
                  result.errors.push({ eventId: match.eventId, error: errorMsg });
                }
              }
            } else {
              result.unmatched++;
            }
          }
        }

        this.logger.debug(`Phase B batch ${batchNum}: processed ${batch.length} events`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Phase B batch ${batchNum} error: ${errorMsg}`);
        for (const e of batch) {
          result.errors.push({ eventId: e.id, error: errorMsg });
        }
      }
    }

    this.logger.log(
      `Phase B complete: ${result.matched} matched, ${result.unmatched} unmatched, ` +
      `${result.commitmentsCreated} commitments created (${result.errors.length} errors, dryRun=${dryRun})`,
    );
    return result;
  }

  // ─────────────────────────────────────────────────────────────
  // Phase C: Activity Semantic Deduplication
  // ─────────────────────────────────────────────────────────────

  private async deduplicateActivities(dryRun: boolean): Promise<PhaseCResult> {
    this.logger.log('Phase C: Deduplicating activities...');

    const { items: activities } = await this.activityService.findAll({ limit: 1000 });

    if (activities.length === 0) {
      return { totalActivities: 0, mergedGroups: 0, totalMerged: 0, archived: 0, errors: [] };
    }

    const result: PhaseCResult = {
      totalActivities: activities.length,
      mergedGroups: 0,
      totalMerged: 0,
      archived: 0,
      errors: [],
    };

    const BATCH_SIZE = 50;

    for (let i = 0; i < activities.length; i += BATCH_SIZE) {
      const batch = activities.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;

      try {
        const activitiesList = batch.map((a) => {
          const desc = a.description ? `\n  Описание: ${a.description.slice(0, 150)}` : '';
          const client = a.clientEntity?.name ? `\n  Клиент: ${a.clientEntity.name}` : '';
          const tags = a.tags?.length ? `\n  Теги: ${a.tags.join(', ')}` : '';
          return `- id: ${a.id}\n  Название: ${a.name}\n  Тип: ${a.activityType}\n  Статус: ${a.status}${client}${desc}${tags}`;
        }).join('\n\n');

        const prompt = `Проанализируй список активностей (проекты и задачи) и найди:

1. **Семантические дубли** — активности об одном и том же (одна тема, один проект, разные формулировки). Для каждой группы дублей выбери primaryId (самую полную/качественную активность), остальные в duplicateIds для merge.
2. **Шум** — бессмысленные активности для архивации (служебные, "Подтверждение использования инструмента", нерелевантные записи без полезной информации).

АКТИВНОСТИ:
${activitiesList}

Если дубликатов и шума нет — верни пустые массивы. Будь консервативен: сомневаешься — не мержи.`;

        const { data } = await this.claudeAgentService.call<PhaseCClaudeResponse>({
          mode: 'oneshot',
          taskType: 'activity_semantic_dedup',
          prompt,
          model: 'haiku',
          schema: PHASE_C_SCHEMA,
          maxTurns: 10,
          timeout: 120_000,
        });

        if (data && !dryRun) {
          // Merge duplicates
          for (const group of data.mergeGroups) {
            try {
              await this.dataQualityService.mergeActivities(group.primaryId, group.duplicateIds);
              result.mergedGroups++;
              result.totalMerged += group.duplicateIds.length;
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              result.errors.push({ activityId: group.primaryId, error: errorMsg });
            }
          }

          // Archive noise
          for (const archiveId of data.archiveIds) {
            try {
              await this.activityService.archive(archiveId);
              result.archived++;
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              result.errors.push({ activityId: archiveId, error: errorMsg });
            }
          }
        } else if (data && dryRun) {
          for (const group of data.mergeGroups) {
            result.mergedGroups++;
            result.totalMerged += group.duplicateIds.length;
          }
          result.archived += data.archiveIds.length;
        }

        this.logger.debug(`Phase C batch ${batchNum}: processed ${batch.length} activities`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Phase C batch ${batchNum} error: ${errorMsg}`);
        result.errors.push({ activityId: `batch-${batchNum}`, error: errorMsg });
      }
    }

    this.logger.log(
      `Phase C complete: ${result.mergedGroups} groups merged (${result.totalMerged} activities), ` +
      `${result.archived} archived (${result.errors.length} errors, dryRun=${dryRun})`,
    );
    return result;
  }

  // ─────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────

  private mapCommitmentType(type: string): CommitmentType {
    switch (type) {
      case 'promise': return CommitmentType.PROMISE;
      case 'request': return CommitmentType.REQUEST;
      case 'agreement': return CommitmentType.AGREEMENT;
      case 'deadline': return CommitmentType.DEADLINE;
      case 'reminder': return CommitmentType.REMINDER;
      default: return CommitmentType.PROMISE;
    }
  }
}
