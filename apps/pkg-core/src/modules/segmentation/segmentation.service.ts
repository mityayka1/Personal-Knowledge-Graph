import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { TopicalSegment, SegmentStatus, KnowledgePack, PackStatus } from '@pkg/entities';
import { CreateSegmentDto } from './dto/create-segment.dto';
import { UpdateSegmentDto } from './dto/update-segment.dto';

export interface FindSegmentsOptions {
  chatId?: string;
  activityId?: string;
  interactionId?: string;
  status?: SegmentStatus;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface FindPacksOptions {
  activityId?: string;
  entityId?: string;
  packType?: string;
  status?: PackStatus;
  limit?: number;
  offset?: number;
}

@Injectable()
export class SegmentationService {
  private readonly logger = new Logger(SegmentationService.name);

  constructor(
    @InjectRepository(TopicalSegment)
    private readonly segmentRepo: Repository<TopicalSegment>,
    @InjectRepository(KnowledgePack)
    private readonly packRepo: Repository<KnowledgePack>,
    private readonly dataSource: DataSource,
  ) {}

  // ─────────────────────────────────────────────────────────────
  // TopicalSegment CRUD
  // ─────────────────────────────────────────────────────────────

  async createSegment(dto: CreateSegmentDto): Promise<TopicalSegment> {
    const segment = this.segmentRepo.create({
      topic: dto.topic,
      keywords: dto.keywords ?? null,
      summary: dto.summary ?? null,
      chatId: dto.chatId,
      interactionId: dto.interactionId ?? null,
      activityId: dto.activityId ?? null,
      participantIds: dto.participantIds,
      primaryParticipantId: dto.primaryParticipantId ?? null,
      messageCount: dto.messageIds?.length ?? 0,
      startedAt: new Date(dto.startedAt),
      endedAt: new Date(dto.endedAt),
      confidence: dto.confidence ?? 0.8,
      status: SegmentStatus.ACTIVE,
    });

    const saved = await this.segmentRepo.save(segment);

    // Link messages via join table
    if (dto.messageIds?.length) {
      await this.linkMessages(saved.id, dto.messageIds);
    }

    this.logger.log(`Created segment: ${saved.id} "${saved.topic}" (${saved.messageCount} msgs)`);
    return saved;
  }

  async findOneSegment(id: string): Promise<TopicalSegment> {
    const segment = await this.segmentRepo.findOne({
      where: { id },
      relations: ['interaction', 'activity', 'primaryParticipant'],
    });

    if (!segment) {
      throw new NotFoundException(`Segment with id '${id}' not found`);
    }

    return segment;
  }

  async findSegments(options: FindSegmentsOptions): Promise<{ data: TopicalSegment[]; total: number }> {
    const qb = this.segmentRepo.createQueryBuilder('s')
      .leftJoinAndSelect('s.activity', 'activity')
      .leftJoinAndSelect('s.primaryParticipant', 'participant');

    if (options.chatId) {
      qb.andWhere('s.chatId = :chatId', { chatId: options.chatId });
    }
    if (options.activityId) {
      qb.andWhere('s.activityId = :activityId', { activityId: options.activityId });
    }
    if (options.interactionId) {
      qb.andWhere('s.interactionId = :interactionId', { interactionId: options.interactionId });
    }
    if (options.status) {
      qb.andWhere('s.status = :status', { status: options.status });
    }
    if (options.search) {
      qb.andWhere('(s.topic ILIKE :search OR s.summary ILIKE :search)', {
        search: `%${options.search}%`,
      });
    }

    qb.orderBy('s.startedAt', 'DESC');

    const total = await qb.getCount();
    const data = await qb
      .skip(options.offset ?? 0)
      .take(options.limit ?? 20)
      .getMany();

    return { data, total };
  }

  async updateSegment(id: string, dto: UpdateSegmentDto): Promise<TopicalSegment> {
    const segment = await this.findOneSegment(id);

    if (dto.topic !== undefined) segment.topic = dto.topic;
    if (dto.keywords !== undefined) segment.keywords = dto.keywords;
    if (dto.summary !== undefined) segment.summary = dto.summary;
    if (dto.activityId !== undefined) segment.activityId = dto.activityId;
    if (dto.status !== undefined) segment.status = dto.status;
    if (dto.confidence !== undefined) segment.confidence = dto.confidence;

    const updated = await this.segmentRepo.save(segment);
    this.logger.log(`Updated segment: ${id}`);
    return updated;
  }

  async linkMessages(segmentId: string, messageIds: string[]): Promise<void> {
    if (!messageIds.length) return;

    const values = messageIds
      .map((mid) => `('${segmentId}', '${mid}')`)
      .join(', ');

    await this.dataSource.query(`
      INSERT INTO segment_messages (segment_id, message_id)
      VALUES ${values}
      ON CONFLICT DO NOTHING
    `);

    // Update denormalized message_count
    const [{ count }] = await this.dataSource.query(
      `SELECT COUNT(*) as count FROM segment_messages WHERE segment_id = $1`,
      [segmentId],
    );

    await this.segmentRepo.update(segmentId, { messageCount: parseInt(count, 10) });
  }

  async getSegmentMessages(segmentId: string): Promise<string[]> {
    const rows = await this.dataSource.query(
      `SELECT message_id FROM segment_messages WHERE segment_id = $1 ORDER BY message_id`,
      [segmentId],
    );
    return rows.map((r: { message_id: string }) => r.message_id);
  }

  async mergeSegments(targetId: string, sourceId: string): Promise<TopicalSegment> {
    const target = await this.findOneSegment(targetId);
    const source = await this.findOneSegment(sourceId);

    // Move messages from source to target
    await this.dataSource.query(`
      INSERT INTO segment_messages (segment_id, message_id)
      SELECT $1, message_id FROM segment_messages WHERE segment_id = $2
      ON CONFLICT DO NOTHING
    `, [targetId, sourceId]);

    // Merge participant IDs
    const mergedParticipants = [...new Set([...target.participantIds, ...source.participantIds])];

    // Expand time range
    const startedAt = target.startedAt < source.startedAt ? target.startedAt : source.startedAt;
    const endedAt = target.endedAt > source.endedAt ? target.endedAt : source.endedAt;

    // Merge extracted entity IDs
    const extractedFactIds = [...new Set([...target.extractedFactIds, ...source.extractedFactIds])];
    const extractedTaskIds = [...new Set([...target.extractedTaskIds, ...source.extractedTaskIds])];
    const extractedCommitmentIds = [...new Set([...target.extractedCommitmentIds, ...source.extractedCommitmentIds])];

    // Update message count
    const [{ count }] = await this.dataSource.query(
      `SELECT COUNT(*) as count FROM segment_messages WHERE segment_id = $1`,
      [targetId],
    );

    await this.segmentRepo.update(targetId, {
      participantIds: mergedParticipants,
      startedAt,
      endedAt,
      messageCount: parseInt(count, 10),
      extractedFactIds,
      extractedTaskIds,
      extractedCommitmentIds,
    });

    // Mark source as merged
    await this.segmentRepo.update(sourceId, {
      status: SegmentStatus.MERGED,
      mergedIntoId: targetId,
    });

    this.logger.log(`Merged segment ${sourceId} into ${targetId}`);
    return this.findOneSegment(targetId);
  }

  // ─────────────────────────────────────────────────────────────
  // Cross-Chat Topic Linking
  // ─────────────────────────────────────────────────────────────

  /**
   * Find segments related to the given segment using three strategies:
   * 1. Activity match — segments with the same activityId (different chat)
   * 2. Keyword overlap — segments sharing 2+ keywords
   * 3. Participant + time window — overlapping participants within ±24h
   */
  async findRelatedSegments(
    segmentId: string,
  ): Promise<Array<{ segmentId: string; matchType: string; score: number }>> {
    const segment = await this.findOneSegment(segmentId);

    const existingRelated = segment.relatedSegmentIds ?? [];
    const excludeIds = [segmentId, ...existingRelated];

    const results: Map<string, { matchType: string; score: number }> = new Map();

    // Strategy 1: Activity match — same activityId, different chatId
    if (segment.activityId) {
      const activityMatches: Array<{ id: string }> = await this.dataSource.query(
        `SELECT id FROM topical_segments
         WHERE activity_id = $1
           AND chat_id != $2
           AND id != ALL($3::uuid[])
           AND status != 'merged'`,
        [segment.activityId, segment.chatId, excludeIds],
      );

      for (const row of activityMatches) {
        results.set(row.id, { matchType: 'activity', score: 0.9 });
      }
    }

    // Strategy 2: Keyword overlap — segments sharing 2+ keywords
    if (segment.keywords?.length && segment.keywords.length >= 2) {
      const keywordMatches: Array<{ id: string; overlap_count: string }> =
        await this.dataSource.query(
          `SELECT id, overlap_count FROM (
             SELECT id,
                    array_length(
                      ARRAY(SELECT unnest(keywords) INTERSECT SELECT unnest($1::text[])),
                      1
                    ) AS overlap_count
             FROM topical_segments
             WHERE keywords && $1::text[]
               AND id != ALL($2::uuid[])
               AND status != 'merged'
           ) sub
           WHERE overlap_count >= 2`,
          [segment.keywords, excludeIds],
        );

      for (const row of keywordMatches) {
        const overlapCount = parseInt(row.overlap_count, 10);
        const score = 0.6 + 0.1 * (overlapCount - 2);
        const existing = results.get(row.id);
        if (!existing || existing.score < score) {
          results.set(row.id, { matchType: 'keyword_overlap', score: Math.min(score, 1.0) });
        }
      }
    }

    // Strategy 3: Participant + time window — overlapping participants within ±24h
    if (segment.participantIds?.length) {
      const participantMatches: Array<{ id: string }> = await this.dataSource.query(
        `SELECT id FROM topical_segments
         WHERE participant_ids && $1::uuid[]
           AND id != ALL($2::uuid[])
           AND status != 'merged'
           AND started_at <= $3::timestamptz + INTERVAL '24 hours'
           AND ended_at >= $4::timestamptz - INTERVAL '24 hours'`,
        [segment.participantIds, excludeIds, segment.endedAt, segment.startedAt],
      );

      for (const row of participantMatches) {
        const existing = results.get(row.id);
        if (!existing || existing.score < 0.7) {
          results.set(row.id, { matchType: 'participant_time', score: 0.7 });
        }
      }
    }

    // Sort by score DESC
    const sorted = Array.from(results.entries())
      .map(([sid, match]) => ({ segmentId: sid, matchType: match.matchType, score: match.score }))
      .sort((a, b) => b.score - a.score);

    this.logger.log(
      `Found ${sorted.length} related segments for ${segmentId} ` +
        `(activity: ${sorted.filter((s) => s.matchType === 'activity').length}, ` +
        `keyword: ${sorted.filter((s) => s.matchType === 'keyword_overlap').length}, ` +
        `participant: ${sorted.filter((s) => s.matchType === 'participant_time').length})`,
    );

    return sorted;
  }

  /**
   * Bidirectional linking: add relatedIds to source segment
   * AND add sourceId to each related segment.
   */
  async linkRelatedSegments(segmentId: string, relatedIds: string[]): Promise<void> {
    if (!relatedIds.length) return;

    // Verify source segment exists
    await this.findOneSegment(segmentId);

    // Add relatedIds to source segment (using array_cat + array_distinct to avoid duplicates)
    await this.dataSource.query(
      `UPDATE topical_segments
       SET related_segment_ids = (
         SELECT ARRAY(SELECT DISTINCT unnest(related_segment_ids || $2::uuid[]))
       ),
       updated_at = NOW()
       WHERE id = $1`,
      [segmentId, relatedIds],
    );

    // Add sourceId to each related segment (bidirectional)
    for (const relatedId of relatedIds) {
      await this.dataSource.query(
        `UPDATE topical_segments
         SET related_segment_ids = (
           SELECT ARRAY(SELECT DISTINCT unnest(related_segment_ids || ARRAY[$2]::uuid[]))
         ),
         updated_at = NOW()
         WHERE id = $1`,
        [relatedId, segmentId],
      );
    }

    this.logger.log(`Linked segment ${segmentId} with ${relatedIds.length} related segments`);
  }

  // ─────────────────────────────────────────────────────────────
  // KnowledgePack CRUD
  // ─────────────────────────────────────────────────────────────

  async findOnePack(id: string): Promise<KnowledgePack> {
    const pack = await this.packRepo.findOne({
      where: { id },
      relations: ['activity', 'entity'],
    });

    if (!pack) {
      throw new NotFoundException(`KnowledgePack with id '${id}' not found`);
    }

    return pack;
  }

  async findPacks(options: FindPacksOptions): Promise<{ data: KnowledgePack[]; total: number }> {
    const qb = this.packRepo.createQueryBuilder('kp')
      .leftJoinAndSelect('kp.activity', 'activity')
      .leftJoinAndSelect('kp.entity', 'entity');

    if (options.activityId) {
      qb.andWhere('kp.activityId = :activityId', { activityId: options.activityId });
    }
    if (options.entityId) {
      qb.andWhere('kp.entityId = :entityId', { entityId: options.entityId });
    }
    if (options.packType) {
      qb.andWhere('kp.packType = :packType', { packType: options.packType });
    }
    if (options.status) {
      qb.andWhere('kp.status = :status', { status: options.status });
    }

    qb.orderBy('kp.periodEnd', 'DESC');

    const total = await qb.getCount();
    const data = await qb
      .skip(options.offset ?? 0)
      .take(options.limit ?? 20)
      .getMany();

    return { data, total };
  }
}
