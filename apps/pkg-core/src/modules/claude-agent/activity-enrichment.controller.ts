import { Controller, Post, Logger } from '@nestjs/common';
import { ActivityService } from '../activity/activity.service';
import { ClaudeAgentService } from './claude-agent.service';

/**
 * ActivityEnrichmentController — AI-обогащение описаний активностей.
 *
 * Размещён в ClaudeAgentModule (а не ActivityModule), чтобы избежать
 * circular dependency: ClaudeAgentModule уже импортирует ActivityModule.
 */
@Controller('activities')
export class ActivityEnrichmentController {
  private readonly logger = new Logger(ActivityEnrichmentController.name);

  constructor(
    private readonly activityService: ActivityService,
    private readonly claudeAgentService: ClaudeAgentService,
  ) {}

  /**
   * POST /activities/enrich-descriptions
   *
   * Находит активности без описания, генерирует описания через Claude AI
   * из доступного контекста (name, type, parent, client, tags, metadata.sourceQuote).
   */
  @Post('enrich-descriptions')
  async enrichDescriptions() {
    this.logger.log('Starting description enrichment for activities without descriptions');

    const activities = await this.activityService.findActivitiesWithoutDescriptions();

    if (activities.length === 0) {
      return { enriched: 0, total: 0, message: 'All activities already have descriptions' };
    }

    this.logger.log(`Found ${activities.length} activities without descriptions`);

    const BATCH_SIZE = 20;
    let enrichedCount = 0;
    const errors: Array<{ id: string; name: string; error: string }> = [];

    for (let i = 0; i < activities.length; i += BATCH_SIZE) {
      const batch = activities.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(activities.length / BATCH_SIZE);

      this.logger.log(`Processing batch ${batchNum}/${totalBatches} (${batch.length} activities)`);

      try {
        const activitiesList = batch.map((a) => {
          const meta = a.metadata as Record<string, unknown> | null;
          const sourceQuote = meta?.sourceQuote ? `\n  Цитата из источника: "${meta.sourceQuote}"` : '';
          const parent = a.parent ? `\n  Родитель: ${a.parent.name} (${a.parent.activityType})` : '';
          const client = a.clientEntity ? `\n  Клиент: ${a.clientEntity.name}` : '';
          const tags = a.tags?.length ? `\n  Теги: ${a.tags.join(', ')}` : '';
          return `- id: ${a.id}\n  Название: ${a.name}\n  Тип: ${a.activityType}\n  Статус: ${a.status}${parent}${client}${tags}${sourceQuote}`;
        }).join('\n\n');

        const prompt = `Сгенерируй описания для следующих активностей (проекты, задачи и т.д.).

Для каждой активности напиши краткое описание (1-3 предложения):
- Что это за проект/задача/направление
- Какова цель или суть
- Используй информацию из названия, типа, клиента, тегов и цитаты из источника

АКТИВНОСТИ:
${activitiesList}

Верни массив descriptions с id и description для каждой активности.`;

        const ENRICHMENT_SCHEMA = {
          type: 'object',
          properties: {
            descriptions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Activity UUID' },
                  description: { type: 'string', description: 'Generated description (1-3 sentences)' },
                },
                required: ['id', 'description'],
              },
            },
          },
          required: ['descriptions'],
        };

        const { data } = await this.claudeAgentService.call<{ descriptions: Array<{ id: string; description: string }> }>({
          mode: 'oneshot',
          taskType: 'description_enrichment',
          prompt,
          model: 'haiku',
          schema: ENRICHMENT_SCHEMA,
          maxTurns: 1,
          timeout: 60_000,
        });

        if (data?.descriptions) {
          for (const item of data.descriptions) {
            try {
              await this.activityService.update(item.id, { description: item.description });
              enrichedCount++;
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              errors.push({ id: item.id, name: 'unknown', error: errorMsg });
            }
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Batch ${batchNum} failed: ${errorMsg}`);
        for (const a of batch) {
          errors.push({ id: a.id, name: a.name, error: errorMsg });
        }
      }
    }

    const result = {
      enriched: enrichedCount,
      total: activities.length,
      errors: errors.length,
      errorDetails: errors.length > 0 ? errors : undefined,
    };

    this.logger.log(`Description enrichment complete: ${enrichedCount}/${activities.length} enriched, ${errors.length} errors`);
    return result;
  }
}
