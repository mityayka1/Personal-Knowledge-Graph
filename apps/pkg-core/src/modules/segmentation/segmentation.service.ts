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
