import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import {
  KnowledgePack,
  PackType,
  PackStatus,
  TopicalSegment,
  SegmentStatus,
} from '@pkg/entities';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';
import { SegmentationService } from './segmentation.service';
import {
  PackByActivityParams,
  PackByEntityParams,
  PackByPeriodParams,
  PackingResult,
  PackingSynthesisResponse,
  PACKING_SYNTHESIS_SCHEMA,
} from './packing.types';

/**
 * PackingService — consolidates TopicalSegments into KnowledgePacks.
 *
 * Responsibilities:
 * - Loads packable segments (ACTIVE/CLOSED) by activity, entity, or period
 * - Synthesizes consolidated knowledge via Claude (oneshot mode)
 * - Creates KnowledgePack records
 * - Marks packed segments as PACKED with knowledgePackId reference
 * - Handles pack supersession when re-packing
 *
 * Phase E: Knowledge Segmentation & Packing
 */
@Injectable()
export class PackingService {
  private readonly logger = new Logger(PackingService.name);

  /** Segment statuses eligible for packing */
  private static readonly PACKABLE_STATUSES = [
    SegmentStatus.ACTIVE,
    SegmentStatus.CLOSED,
  ];

  /** Max agentic turns for synthesis Claude call */
  private static readonly SYNTHESIS_MAX_TURNS = 5;

  /** Timeout for synthesis Claude call (ms) — 3 minutes for large synthesis */
  private static readonly SYNTHESIS_TIMEOUT_MS = 180_000;

  constructor(
    @InjectRepository(KnowledgePack)
    private readonly packRepo: Repository<KnowledgePack>,
    @InjectRepository(TopicalSegment)
    private readonly segmentRepo: Repository<TopicalSegment>,
    private readonly segmentationService: SegmentationService,
    private readonly claudeAgentService: ClaudeAgentService,
    private readonly dataSource: DataSource,
  ) {}

  // ─────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────

  /**
   * Pack segments related to a specific Activity into a KnowledgePack.
   *
   * Loads all ACTIVE/CLOSED segments for the given activityId,
   * synthesizes a consolidated summary via Claude, creates
   * a KnowledgePack, and marks segments as PACKED.
   */
  async packByActivity(params: PackByActivityParams): Promise<PackingResult> {
    const { activityId, title } = params;

    this.logger.log(`[packing] Starting packByActivity: activityId=${activityId}`);

    // Load packable segments for this activity
    const segments = await this.loadSegmentsByActivity(activityId);
    this.ensureSegmentsAvailable(segments, `activity ${activityId}`);

    // Load message content for synthesis
    const segmentData = await this.loadSegmentDataForSynthesis(segments);

    // Synthesize via Claude
    const { synthesis, tokensUsed, durationMs } = await this.synthesize(segmentData);

    // Build period bounds from segments
    const { periodStart, periodEnd } = this.computePeriodBounds(segments);

    // Collect all participant IDs across segments
    const participantIds = this.collectParticipantIds(segments);

    // Supersede existing ACTIVE packs for this activity
    await this.supersedeExistingPacks(PackType.ACTIVITY, { activityId });

    // Create KnowledgePack
    const pack = await this.createPack({
      title: title || synthesis.suggestedTitle,
      packType: PackType.ACTIVITY,
      activityId,
      entityId: null,
      periodStart,
      periodEnd,
      synthesis,
      segments,
      participantIds,
    });

    // Mark segments as packed
    await this.markSegmentsAsPacked(segments, pack.id);

    this.logger.log(
      `[packing] packByActivity complete: packId=${pack.id}, ` +
      `segments=${segments.length}, duration=${durationMs}ms`,
    );

    return {
      pack,
      segmentCount: segments.length,
      totalMessageCount: segments.reduce((sum, s) => sum + s.messageCount, 0),
      tokensUsed,
      durationMs,
    };
  }

  /**
   * Pack segments where a given entity is the primary participant.
   *
   * Useful for building consolidated knowledge about interactions
   * with a specific person or organization.
   */
  async packByEntity(params: PackByEntityParams): Promise<PackingResult> {
    const { entityId, title } = params;

    this.logger.log(`[packing] Starting packByEntity: entityId=${entityId}`);

    // Load packable segments for this entity
    const segments = await this.loadSegmentsByEntity(entityId);
    this.ensureSegmentsAvailable(segments, `entity ${entityId}`);

    const segmentData = await this.loadSegmentDataForSynthesis(segments);
    const { synthesis, tokensUsed, durationMs } = await this.synthesize(segmentData);
    const { periodStart, periodEnd } = this.computePeriodBounds(segments);
    const participantIds = this.collectParticipantIds(segments);

    // Supersede existing ACTIVE packs for this entity
    await this.supersedeExistingPacks(PackType.ENTITY, { entityId });

    const pack = await this.createPack({
      title: title || synthesis.suggestedTitle,
      packType: PackType.ENTITY,
      activityId: null,
      entityId,
      periodStart,
      periodEnd,
      synthesis,
      segments,
      participantIds,
    });

    await this.markSegmentsAsPacked(segments, pack.id);

    this.logger.log(
      `[packing] packByEntity complete: packId=${pack.id}, ` +
      `segments=${segments.length}, duration=${durationMs}ms`,
    );

    return {
      pack,
      segmentCount: segments.length,
      totalMessageCount: segments.reduce((sum, s) => sum + s.messageCount, 0),
      tokensUsed,
      durationMs,
    };
  }

  /**
   * Pack all segments in a chat for a given time period.
   *
   * Filters by chatId and date range (startedAt >= startDate AND endedAt <= endDate).
   */
  async packByPeriod(params: PackByPeriodParams): Promise<PackingResult> {
    const { chatId, startDate, endDate, title } = params;

    this.logger.log(
      `[packing] Starting packByPeriod: chatId=${chatId}, ` +
      `${startDate.toISOString()} - ${endDate.toISOString()}`,
    );

    // Load packable segments for this chat and period
    const segments = await this.loadSegmentsByPeriod(chatId, startDate, endDate);
    this.ensureSegmentsAvailable(segments, `chat ${chatId} period`);

    const segmentData = await this.loadSegmentDataForSynthesis(segments);
    const { synthesis, tokensUsed, durationMs } = await this.synthesize(segmentData);
    const participantIds = this.collectParticipantIds(segments);

    const pack = await this.createPack({
      title: title || synthesis.suggestedTitle,
      packType: PackType.PERIOD,
      activityId: null,
      entityId: null,
      periodStart: startDate,
      periodEnd: endDate,
      synthesis,
      segments,
      participantIds,
    });

    await this.markSegmentsAsPacked(segments, pack.id);

    this.logger.log(
      `[packing] packByPeriod complete: packId=${pack.id}, ` +
      `segments=${segments.length}, duration=${durationMs}ms`,
    );

    return {
      pack,
      segmentCount: segments.length,
      totalMessageCount: segments.reduce((sum, s) => sum + s.messageCount, 0),
      tokensUsed,
      durationMs,
    };
  }

  /**
   * Mark a pack as SUPERSEDED.
   *
   * Used when re-packing after new segments are added for the same scope.
   * The old pack is marked SUPERSEDED with a reference to the new pack.
   *
   * @param packId - ID of the pack to supersede
   * @param supersededById - ID of the new pack that replaces this one (optional)
   */
  async supersedePack(packId: string, supersededById?: string): Promise<KnowledgePack> {
    const pack = await this.segmentationService.findOnePack(packId);

    if (pack.status === PackStatus.SUPERSEDED) {
      this.logger.warn(`[packing] Pack ${packId} is already superseded`);
      return pack;
    }

    await this.packRepo.update(packId, {
      status: PackStatus.SUPERSEDED,
      supersededById: supersededById || null,
    });

    // Release segments that were packed into this pack so they can be re-packed
    await this.segmentRepo
      .createQueryBuilder()
      .update(TopicalSegment)
      .set({
        status: SegmentStatus.CLOSED,
        knowledgePackId: null,
      })
      .where('knowledgePackId = :packId', { packId })
      .execute();

    this.logger.log(
      `[packing] Pack ${packId} superseded` +
      (supersededById ? ` by ${supersededById}` : ''),
    );

    return this.segmentationService.findOnePack(packId);
  }

  // ─────────────────────────────────────────────────────────────
  // Incremental Packing
  // ─────────────────────────────────────────────────────────────

  /**
   * Create or incrementally update a KnowledgePack for a given activity.
   *
   * - If no ACTIVE KP exists: synthesize all segments into a new KP.
   * - If an ACTIVE KP exists: filter truly new segments (not already in sourceSegmentIds),
   *   synthesize with existing content as context, and update the KP.
   * - If all segments are already packed: skip with zero counts.
   *
   * Returns an IncrementalPackingResult with segment/token counts.
   */
  async packByActivityIncremental(
    activityId: string,
    segments: TopicalSegment[],
  ): Promise<IncrementalPackingResult> {
    // Find existing ACTIVE KP for this activity
    const existingPack = await this.packRepo.findOne({
      where: { activityId, packType: PackType.ACTIVITY, status: PackStatus.ACTIVE },
    });

    if (!existingPack) {
      // No existing pack — synthesize from scratch and create new KP
      return this.createNewIncrementalPack(activityId, segments);
    }

    // Filter truly new segments (not already in the existing pack)
    const existingSegmentIdSet = new Set(existingPack.sourceSegmentIds);
    const newSegments = segments.filter((s) => !existingSegmentIdSet.has(s.id));

    if (newSegments.length === 0) {
      this.logger.log(
        `[packing] No new segments for activity=${activityId}, skipping incremental update`,
      );
      return {
        packId: existingPack.id,
        segmentCount: 0,
        tokensUsed: 0,
        durationMs: 0,
        isNew: false,
      };
    }

    // Synthesize with existing content as context
    return this.updateExistingPack(existingPack, newSegments);
  }

  /**
   * Create a brand new KP from segments (no prior pack exists).
   */
  private async createNewIncrementalPack(
    activityId: string,
    segments: TopicalSegment[],
  ): Promise<IncrementalPackingResult> {
    const startTime = Date.now();

    this.logger.log(
      `[packing] Creating new incremental KP for activity=${activityId}, segments=${segments.length}`,
    );

    const structured = await this.synthesizeStructured(segments, null);

    const sourceSegmentIds = segments.map((s) => s.id);
    const totalMessageCount = segments.reduce((sum, s) => sum + s.messageCount, 0);
    const { periodStart, periodEnd } = this.computePeriodBounds(segments);
    const participantIds = this.collectParticipantIds(segments);

    const pack = this.packRepo.create({
      title: structured.summary.substring(0, 100),
      packType: PackType.ACTIVITY,
      activityId,
      entityId: null,
      periodStart,
      periodEnd,
      summary: structured.summary,
      decisions: structured.decisions.map((d) => ({
        what: d.what,
        when: d.when,
        context: d.context,
      })),
      openQuestions: structured.openQuestions.map((q) => ({
        question: q.question,
        raisedAt: q.raisedAt,
        context: q.context,
      })),
      keyFacts: structured.keyFacts.map((f) => ({
        factType: f.factType,
        value: f.value,
        confidence: f.confidence,
        sourceSegmentIds,
        lastUpdated: new Date().toISOString(),
      })),
      conflicts: structured.conflicts.map((c) => ({
        type: 'fact_contradiction' as const,
        description: `${c.fact1} vs ${c.fact2}`,
        segmentIds: sourceSegmentIds,
        resolved: false,
        resolution: c.resolution,
      })),
      participantIds,
      sourceSegmentIds,
      segmentCount: segments.length,
      totalMessageCount,
      status: PackStatus.ACTIVE,
      metadata: {
        packingVersion: '2.0.0',
      },
    });

    const saved = await this.packRepo.save(pack);

    await this.markSegmentsAsPacked(segments, saved.id);

    const durationMs = Date.now() - startTime;

    this.logger.log(
      `[packing] Created new incremental KP: id=${saved.id}, segments=${segments.length}, duration=${durationMs}ms`,
    );

    return {
      packId: saved.id,
      segmentCount: segments.length,
      tokensUsed: structured.tokensUsed,
      durationMs,
      isNew: true,
    };
  }

  /**
   * Update an existing KP with new segments, using existing content as context.
   */
  private async updateExistingPack(
    existingPack: KnowledgePack,
    newSegments: TopicalSegment[],
  ): Promise<IncrementalPackingResult> {
    const startTime = Date.now();

    this.logger.log(
      `[packing] Incremental update of KP=${existingPack.id}, newSegments=${newSegments.length}`,
    );

    const existingContent = this.parseContent(existingPack);
    const structured = await this.synthesizeStructured(newSegments, existingContent);

    const newSegmentIds = newSegments.map((s) => s.id);
    const allSourceSegmentIds = [...existingPack.sourceSegmentIds, ...newSegmentIds];
    const totalMessageCount =
      existingPack.totalMessageCount +
      newSegments.reduce((sum, s) => sum + s.messageCount, 0);
    const { periodStart, periodEnd } = this.computePeriodBounds([
      // Virtual segments to represent existing period bounds
      { startedAt: existingPack.periodStart, endedAt: existingPack.periodEnd } as TopicalSegment,
      ...newSegments,
    ]);
    const existingParticipantIds = existingPack.participantIds || [];
    const newParticipantIds = this.collectParticipantIds(newSegments);
    const allParticipantIds = [...new Set([...existingParticipantIds, ...newParticipantIds])];

    // Update existing pack in place
    existingPack.summary = structured.summary;
    existingPack.decisions = structured.decisions.map((d) => ({
      what: d.what,
      when: d.when,
      context: d.context,
    }));
    existingPack.openQuestions = structured.openQuestions.map((q) => ({
      question: q.question,
      raisedAt: q.raisedAt,
      context: q.context,
    }));
    existingPack.keyFacts = structured.keyFacts.map((f) => ({
      factType: f.factType,
      value: f.value,
      confidence: f.confidence,
      sourceSegmentIds: allSourceSegmentIds,
      lastUpdated: new Date().toISOString(),
    }));
    existingPack.conflicts = structured.conflicts.map((c) => ({
      type: 'fact_contradiction' as const,
      description: `${c.fact1} vs ${c.fact2}`,
      segmentIds: allSourceSegmentIds,
      resolved: false,
      resolution: c.resolution,
    }));
    existingPack.sourceSegmentIds = allSourceSegmentIds;
    existingPack.segmentCount = allSourceSegmentIds.length;
    existingPack.totalMessageCount = totalMessageCount;
    existingPack.periodStart = periodStart;
    existingPack.periodEnd = periodEnd;
    existingPack.participantIds = allParticipantIds;
    existingPack.metadata = {
      ...existingPack.metadata,
      packingVersion: '2.0.0',
    };

    await this.packRepo.save(existingPack);

    await this.markSegmentsAsPacked(newSegments, existingPack.id);

    const durationMs = Date.now() - startTime;

    this.logger.log(
      `[packing] Incremental update complete: KP=${existingPack.id}, newSegments=${newSegments.length}, duration=${durationMs}ms`,
    );

    return {
      packId: existingPack.id,
      segmentCount: newSegments.length,
      tokensUsed: structured.tokensUsed,
      durationMs,
      isNew: false,
    };
  }

  /**
   * Synthesize structured KP content from segments, optionally with existing content as context.
   */
  private async synthesizeStructured(
    segments: TopicalSegment[],
    existingContent: StructuredKpContent | null,
  ): Promise<StructuredKpContent & { tokensUsed: number }> {
    const segmentDescriptions = segments.map((s, i) => {
      const period = `${s.startedAt.toISOString().split('T')[0]} — ${s.endedAt.toISOString().split('T')[0]}`;
      return (
        `Сегмент ${i + 1}: "${s.topic}"\n` +
        `Период: ${period}, Сообщений: ${s.messageCount}\n` +
        (s.summary ? `Описание: ${s.summary}` : '')
      );
    }).join('\n\n');

    let prompt: string;

    if (existingContent) {
      prompt = `
Ты — ассистент по обновлению пакетов знаний.

══════════════════════════════════════════
СУЩЕСТВУЮЩИЙ ПАКЕТ ЗНАНИЙ
══════════════════════════════════════════

Summary: ${existingContent.summary}

Ключевые факты:
${existingContent.keyFacts.map((f) => `- [${f.factType}] ${f.value} (confidence: ${f.confidence})`).join('\n')}

Решения:
${existingContent.decisions.map((d) => `- ${d.what} (${d.when})`).join('\n')}

Открытые вопросы:
${existingContent.openQuestions.map((q) => `- ${q.question}`).join('\n')}

══════════════════════════════════════════
НОВЫЕ СЕГМЕНТЫ ДЛЯ ИНТЕГРАЦИИ
══════════════════════════════════════════

${segmentDescriptions}

══════════════════════════════════════════
ЗАДАЧА
══════════════════════════════════════════

Обнови пакет знаний, интегрировав новые сегменты с существующей информацией.
- Обнови summary, объединив старую и новую информацию
- Добавь новые факты, решения, вопросы
- Разреши конфликты между старыми и новыми данными
- Удали устаревшие открытые вопросы, если они были решены
- Верни ПОЛНЫЙ обновлённый пакет (не только дельту)

Пиши на русском языке.
Заполни все обязательные поля JSON Schema.
`;
    } else {
      prompt = `
Ты — ассистент по консолидации знаний из обсуждений.

══════════════════════════════════════════
СЕГМЕНТЫ ДЛЯ АНАЛИЗА
══════════════════════════════════════════

${segmentDescriptions}

══════════════════════════════════════════
ЗАДАЧА
══════════════════════════════════════════

Создай структурированный пакет знаний:
1. summary — сводка (3-5 абзацев) на русском
2. keyFacts — важные факты с confidence (0-1)
3. decisions — принятые решения
4. openQuestions — нерешённые вопросы
5. conflicts — противоречия (если есть)
6. timeline — ключевые события по датам

Пиши на русском языке.
Заполни все обязательные поля JSON Schema.
`;
    }

    const result = await this.claudeAgentService.call<StructuredKpContent>({
      mode: 'oneshot',
      taskType: 'knowledge_packing',
      prompt,
      model: 'sonnet',
      schema: INCREMENTAL_PACKING_SCHEMA,
      maxTurns: PackingService.SYNTHESIS_MAX_TURNS,
      timeout: PackingService.SYNTHESIS_TIMEOUT_MS,
    });

    const tokensUsed = result.usage.inputTokens + result.usage.outputTokens;

    if (!result.data) {
      throw new Error('Incremental synthesis returned empty response from Claude');
    }

    return { ...result.data, tokensUsed };
  }

  /**
   * Parse existing KP content into StructuredKpContent for use as context.
   */
  private parseContent(pack: KnowledgePack): StructuredKpContent {
    return {
      summary: pack.summary,
      keyFacts: (pack.keyFacts || []).map((f) => ({
        factType: f.factType,
        value: f.value,
        confidence: f.confidence,
      })),
      decisions: (pack.decisions || []).map((d) => ({
        what: d.what,
        when: d.when,
        context: d.context || '',
      })),
      openQuestions: (pack.openQuestions || []).map((q) => ({
        question: q.question,
        raisedAt: q.raisedAt,
        context: q.context || '',
      })),
      conflicts: (pack.conflicts || []).map((c) => ({
        fact1: c.description.split(' vs ')[0] || c.description,
        fact2: c.description.split(' vs ')[1] || '',
        resolution: c.resolution || '',
      })),
      timeline: [],
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Pack Supersession
  // ─────────────────────────────────────────────────────────────

  /**
   * Supersede existing ACTIVE packs for the same scope before creating a new one.
   * Prevents duplicate knowledge packs in context retrieval.
   */
  private async supersedeExistingPacks(
    packType: PackType,
    scope: { activityId?: string; entityId?: string },
  ): Promise<void> {
    const qb = this.packRepo.createQueryBuilder('kp')
      .where('kp.status = :status', { status: PackStatus.ACTIVE })
      .andWhere('kp.packType = :packType', { packType });

    if (scope.activityId) {
      qb.andWhere('kp.activityId = :activityId', { activityId: scope.activityId });
    }
    if (scope.entityId) {
      qb.andWhere('kp.entityId = :entityId', { entityId: scope.entityId });
    }

    const existingPacks = await qb.getMany();

    for (const pack of existingPacks) {
      await this.supersedePack(pack.id);
      this.logger.log(`[packing] Superseded existing pack ${pack.id} before re-packing`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Segment Loading
  // ─────────────────────────────────────────────────────────────

  private async loadSegmentsByActivity(activityId: string): Promise<TopicalSegment[]> {
    return this.segmentRepo.find({
      where: {
        activityId,
        status: In(PackingService.PACKABLE_STATUSES),
      },
      order: { startedAt: 'ASC' },
    });
  }

  private async loadSegmentsByEntity(entityId: string): Promise<TopicalSegment[]> {
    return this.segmentRepo.find({
      where: {
        primaryParticipantId: entityId,
        status: In(PackingService.PACKABLE_STATUSES),
      },
      order: { startedAt: 'ASC' },
    });
  }

  private async loadSegmentsByPeriod(
    chatId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<TopicalSegment[]> {
    return this.segmentRepo
      .createQueryBuilder('s')
      .where('s.chatId = :chatId', { chatId })
      .andWhere('s.status IN (:...statuses)', {
        statuses: PackingService.PACKABLE_STATUSES,
      })
      .andWhere('s.startedAt >= :startDate', { startDate })
      .andWhere('s.endedAt <= :endDate', { endDate })
      .orderBy('s.startedAt', 'ASC')
      .getMany();
  }

  private ensureSegmentsAvailable(segments: TopicalSegment[], context: string): void {
    if (segments.length === 0) {
      throw new NotFoundException(
        `No packable segments found for ${context}. ` +
        `Only segments with status ACTIVE or CLOSED can be packed.`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Message Loading for Synthesis
  // ─────────────────────────────────────────────────────────────

  /**
   * Load message content for each segment to provide context for synthesis.
   * Uses a single batch query instead of per-segment queries to avoid N+1.
   */
  private async loadSegmentDataForSynthesis(
    segments: TopicalSegment[],
  ): Promise<SegmentSynthesisData[]> {
    const segmentIds = segments.map((s) => s.id);

    // Batch-load all messages for all segments in one query
    // Exclude bot messages to prevent system-generated content from entering knowledge packs
    const rows: Array<{
      segment_id: string;
      content: string | null;
      sender_name: string | null;
      timestamp: Date;
    }> = await this.dataSource.query(
      `SELECT sm.segment_id, m.content, e.name AS sender_name, m.timestamp
       FROM segment_messages sm
       JOIN messages m ON m.id = sm.message_id
       LEFT JOIN entities e ON e.id = m.sender_entity_id
       WHERE sm.segment_id = ANY($1::uuid[])
         AND (e.is_bot = false OR e.is_bot IS NULL)
       ORDER BY sm.segment_id, m.timestamp ASC`,
      [segmentIds],
    );

    // Group messages by segment ID
    const messagesBySegment = new Map<string, typeof rows>();
    for (const row of rows) {
      let arr = messagesBySegment.get(row.segment_id);
      if (!arr) {
        arr = [];
        messagesBySegment.set(row.segment_id, arr);
      }
      arr.push(row);
    }

    return segments.map((segment) => {
      const segmentMessages = messagesBySegment.get(segment.id) || [];

      const messageTexts = segmentMessages
        .filter((m) => m.content)
        .map((m) => {
          const sender = m.sender_name || 'Unknown';
          const time = m.timestamp
            ? new Date(m.timestamp).toISOString().split('T')[0]
            : '';
          return `[${sender}${time ? ' ' + time : ''}]: ${m.content}`;
        });

      return {
        segmentId: segment.id,
        topic: segment.topic,
        summary: segment.summary || '',
        keywords: segment.keywords || [],
        startedAt: segment.startedAt,
        endedAt: segment.endedAt,
        messageCount: segment.messageCount,
        messages: messageTexts,
      };
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Claude Synthesis
  // ─────────────────────────────────────────────────────────────

  /**
   * Call Claude to synthesize segments into consolidated knowledge.
   */
  private async synthesize(
    segmentData: SegmentSynthesisData[],
  ): Promise<{
    synthesis: PackingSynthesisResponse;
    tokensUsed: number;
    durationMs: number;
  }> {
    const startTime = Date.now();

    const prompt = this.buildSynthesisPrompt(segmentData);

    this.logger.debug(
      `[packing] Synthesizing ${segmentData.length} segments, ` +
      `prompt length: ${prompt.length} chars`,
    );

    const result = await this.claudeAgentService.call<PackingSynthesisResponse>({
      mode: 'oneshot',
      taskType: 'knowledge_packing',
      prompt,
      model: 'sonnet',
      schema: PACKING_SYNTHESIS_SCHEMA,
      maxTurns: PackingService.SYNTHESIS_MAX_TURNS,
      timeout: PackingService.SYNTHESIS_TIMEOUT_MS,
    });

    const durationMs = Date.now() - startTime;
    const tokensUsed = result.usage.inputTokens + result.usage.outputTokens;

    if (!result.data) {
      this.logger.error(
        `[packing] Claude returned empty response for knowledge synthesis ` +
        `(${segmentData.length} segments, ${tokensUsed} tokens, ${durationMs}ms)`,
      );
      throw new Error('Knowledge synthesis returned empty response from Claude');
    }

    this.logger.debug(
      `[packing] Synthesis complete: ${tokensUsed} tokens, ${durationMs}ms`,
    );

    return { synthesis: result.data, tokensUsed, durationMs };
  }

  /**
   * Build the prompt for Claude synthesis.
   */
  private buildSynthesisPrompt(segmentData: SegmentSynthesisData[]): string {
    const segmentBlocks = segmentData
      .map((s, index) => {
        const header =
          `── Сегмент ${index + 1}: "${s.topic}" ──\n` +
          `Период: ${s.startedAt.toISOString().split('T')[0]} — ${s.endedAt.toISOString().split('T')[0]}\n` +
          `Сообщений: ${s.messageCount}\n` +
          (s.keywords.length > 0 ? `Ключевые слова: ${s.keywords.join(', ')}\n` : '') +
          (s.summary ? `Краткое описание: ${s.summary}\n` : '');

        const messagesBlock =
          s.messages.length > 0
            ? `\nСообщения:\n${s.messages.join('\n')}`
            : '\n(сообщения не загружены)';

        return header + messagesBlock;
      })
      .join('\n\n');

    return `
Ты — ассистент по консолидации знаний из обсуждений.

══════════════════════════════════════════
ЗАДАЧА
══════════════════════════════════════════

Проанализируй ${segmentData.length} тематических сегментов обсуждений и создай
консолидированный пакет знаний. Это должно быть компактное, структурированное
представление всей информации из этих обсуждений.

══════════════════════════════════════════
ЧТО НУЖНО СДЕЛАТЬ
══════════════════════════════════════════

1. **summary** — Напиши сводку на русском языке (3-5 абзацев):
   - Общая картина: что обсуждалось, какой прогресс достигнут
   - Ключевые темы и их связь между собой
   - Текущий статус и что осталось сделать
   - НЕ перечисляй сегменты по отдельности — объедини информацию

2. **decisions** — Извлеки ключевые решения:
   - Только конкретные решения, а не намерения
   - Укажи контекст: почему было принято

3. **openQuestions** — Нерешённые вопросы:
   - Вопросы, которые были подняты но не получили ответа
   - Вопросы, требующие дальнейшего обсуждения
   - Неопределённости и риски

4. **keyFacts** — Важные факты:
   - Конкретная информация: даты, суммы, имена, контакты
   - Требования и ограничения
   - Статусы и договорённости
   - Укажи уверенность (confidence): 0.9+ для явно упомянутого, 0.7-0.9 для контекстного

5. **conflicts** — Противоречия между сегментами:
   - Разные утверждения об одном и том же
   - Изменение решений без явного объяснения
   - НЕ считай конфликтом обычное развитие ситуации
   - Если конфликтов нет — верни пустой массив

6. **suggestedTitle** — Предложи название пакета знаний:
   - Краткое (до 100 символов), на русском
   - Должно отражать основную тему или scope

══════════════════════════════════════════
СЕГМЕНТЫ ДЛЯ АНАЛИЗА
══════════════════════════════════════════

${segmentBlocks}

══════════════════════════════════════════
ПРАВИЛА
══════════════════════════════════════════

- Пиши на русском языке
- Консолидируй информацию, не дублируй
- При конфликтах предпочитай более позднюю информацию
- Факты с confidence < 0.5 не включай
- Будь конкретен: цитируй даты, имена, суммы

Заполни все обязательные поля JSON Schema.
`;
  }

  // ─────────────────────────────────────────────────────────────
  // KnowledgePack Creation
  // ─────────────────────────────────────────────────────────────

  private async createPack(params: CreatePackParams): Promise<KnowledgePack> {
    const {
      title,
      packType,
      activityId,
      entityId,
      periodStart,
      periodEnd,
      synthesis,
      segments,
      participantIds,
    } = params;

    const sourceSegmentIds = segments.map((s) => s.id);
    const totalMessageCount = segments.reduce((sum, s) => sum + s.messageCount, 0);

    const pack = this.packRepo.create({
      title,
      packType,
      activityId,
      entityId,
      periodStart,
      periodEnd,
      summary: synthesis.summary,
      decisions: synthesis.decisions.map((d) => ({
        what: d.what,
        when: d.when,
        context: d.context,
      })),
      openQuestions: synthesis.openQuestions.map((q) => ({
        question: q.question,
        raisedAt: q.raisedAt,
        context: q.context,
      })),
      keyFacts: synthesis.keyFacts.map((f) => ({
        factType: f.factType,
        value: f.value,
        confidence: f.confidence,
        sourceSegmentIds,
        lastUpdated: new Date().toISOString(),
      })),
      conflicts: synthesis.conflicts.map((c) => ({
        type: 'fact_contradiction' as const,
        description: `${c.fact1} vs ${c.fact2}`,
        segmentIds: sourceSegmentIds,
        resolved: false,
        resolution: c.resolution,
      })),
      participantIds,
      sourceSegmentIds,
      segmentCount: segments.length,
      totalMessageCount,
      status: PackStatus.ACTIVE,
      metadata: {
        packingVersion: '1.0.0',
      },
    });

    const saved = await this.packRepo.save(pack);

    this.logger.log(
      `[packing] Created KnowledgePack: id=${saved.id}, ` +
      `type=${packType}, segments=${segments.length}, messages=${totalMessageCount}`,
    );

    return saved;
  }

  // ─────────────────────────────────────────────────────────────
  // Segment Status Updates
  // ─────────────────────────────────────────────────────────────

  private async markSegmentsAsPacked(
    segments: TopicalSegment[],
    packId: string,
  ): Promise<void> {
    const segmentIds = segments.map((s) => s.id);

    await this.segmentRepo
      .createQueryBuilder()
      .update(TopicalSegment)
      .set({
        status: SegmentStatus.PACKED,
        knowledgePackId: packId,
      })
      .whereInIds(segmentIds)
      .execute();

    this.logger.debug(
      `[packing] Marked ${segmentIds.length} segments as PACKED (packId=${packId})`,
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────

  private computePeriodBounds(segments: TopicalSegment[]): {
    periodStart: Date;
    periodEnd: Date;
  } {
    const dates = segments.flatMap((s) => [s.startedAt, s.endedAt]);
    return {
      periodStart: new Date(Math.min(...dates.map((d) => d.getTime()))),
      periodEnd: new Date(Math.max(...dates.map((d) => d.getTime()))),
    };
  }

  private collectParticipantIds(segments: TopicalSegment[]): string[] {
    const allIds = segments.flatMap((s) => s.participantIds);
    return [...new Set(allIds)];
  }
}

// ─────────────────────────────────────────────────────────────
// Internal Types
// ─────────────────────────────────────────────────────────────

interface SegmentSynthesisData {
  segmentId: string;
  topic: string;
  summary: string;
  keywords: string[];
  startedAt: Date;
  endedAt: Date;
  messageCount: number;
  messages: string[];
}

interface CreatePackParams {
  title: string;
  packType: PackType;
  activityId: string | null;
  entityId: string | null;
  periodStart: Date;
  periodEnd: Date;
  synthesis: PackingSynthesisResponse;
  segments: TopicalSegment[];
  participantIds: string[];
}

// ─────────────────────────────────────────────────────────────
// Incremental Packing Types
// ─────────────────────────────────────────────────────────────

/**
 * Structured content for a KnowledgePack — used for incremental synthesis.
 */
export interface StructuredKpContent {
  summary: string;
  keyFacts: Array<{
    factType: string;
    value: string;
    confidence: number;
  }>;
  decisions: Array<{
    what: string;
    when: string;
    context: string;
  }>;
  openQuestions: Array<{
    question: string;
    raisedAt: string;
    context: string;
  }>;
  conflicts: Array<{
    fact1: string;
    fact2: string;
    resolution: string;
  }>;
  timeline: Array<{
    date: string;
    event: string;
  }>;
}

/**
 * Result from an incremental packing operation.
 */
export interface IncrementalPackingResult {
  packId: string;
  segmentCount: number;
  tokensUsed: number;
  durationMs: number;
  isNew: boolean;
}

/**
 * JSON Schema for incremental packing synthesis.
 * IMPORTANT: Uses raw JSON Schema, NOT z.toJSONSchema().
 */
const INCREMENTAL_PACKING_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description:
        'Consolidated summary in Russian (3-5 paragraphs). ' +
        'If updating existing pack, merge old and new information.',
    },
    keyFacts: {
      type: 'array',
      description: 'Important facts consolidated from segments',
      items: {
        type: 'object',
        properties: {
          factType: {
            type: 'string',
            description:
              'Category: "agreement", "requirement", "status", "contact", ' +
              '"deadline", "budget", "technical", "other"',
          },
          value: {
            type: 'string',
            description: 'The fact value as a clear statement',
          },
          confidence: {
            type: 'number',
            description: 'Confidence level 0-1',
          },
        },
        required: ['factType', 'value', 'confidence'],
      },
    },
    decisions: {
      type: 'array',
      description: 'Key decisions',
      items: {
        type: 'object',
        properties: {
          what: { type: 'string', description: 'What was decided' },
          when: { type: 'string', description: 'When (date or context)' },
          context: { type: 'string', description: 'Reasoning' },
        },
        required: ['what', 'when', 'context'],
      },
    },
    openQuestions: {
      type: 'array',
      description: 'Unresolved questions',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question' },
          raisedAt: { type: 'string', description: 'When raised' },
          context: { type: 'string', description: 'Why important' },
        },
        required: ['question', 'raisedAt', 'context'],
      },
    },
    conflicts: {
      type: 'array',
      description: 'Contradictions between old and new information',
      items: {
        type: 'object',
        properties: {
          fact1: { type: 'string', description: 'First statement' },
          fact2: { type: 'string', description: 'Conflicting statement' },
          resolution: { type: 'string', description: 'Suggested resolution' },
        },
        required: ['fact1', 'fact2', 'resolution'],
      },
    },
    timeline: {
      type: 'array',
      description: 'Key events in chronological order',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date (ISO or approximate)' },
          event: { type: 'string', description: 'What happened' },
        },
        required: ['date', 'event'],
      },
    },
  },
  required: ['summary', 'keyFacts', 'decisions', 'openQuestions', 'conflicts', 'timeline'],
};
