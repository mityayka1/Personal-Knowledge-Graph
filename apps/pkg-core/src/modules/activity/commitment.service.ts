import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, IsNull, Not } from 'typeorm';
import {
  Commitment,
  CommitmentType,
  CommitmentStatus,
  CommitmentPriority,
} from '@pkg/entities';

/**
 * DTO для создания Commitment.
 */
export interface CreateCommitmentDto {
  type: CommitmentType;
  title: string;
  description?: string;
  status?: CommitmentStatus;
  priority?: CommitmentPriority;
  fromEntityId: string;
  toEntityId: string;
  activityId?: string;
  sourceMessageId?: string;
  extractedEventId?: string;
  dueDate?: Date;
  recurrenceRule?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
  notes?: string;
}

/**
 * Опции поиска Commitments.
 */
export interface FindCommitmentsOptions {
  fromEntityId?: string;
  toEntityId?: string;
  entityId?: string; // Either from or to
  status?: CommitmentStatus | CommitmentStatus[];
  type?: CommitmentType | CommitmentType[];
  activityId?: string;
  hasDueDate?: boolean;
  isOverdue?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * CommitmentService — CRUD и специальные запросы для обязательств.
 *
 * Обязательства отслеживают обещания между людьми:
 * - Кто кому что обещал
 * - Сроки выполнения
 * - Статус (pending, completed, overdue)
 */
@Injectable()
export class CommitmentService {
  private readonly logger = new Logger(CommitmentService.name);

  constructor(
    @InjectRepository(Commitment)
    private readonly commitmentRepo: Repository<Commitment>,
  ) {}

  // ─────────────────────────────────────────────────────────────
  // CRUD Operations
  // ─────────────────────────────────────────────────────────────

  /**
   * Найти Commitment по ID.
   */
  async findOne(id: string): Promise<Commitment> {
    const commitment = await this.commitmentRepo.findOne({
      where: { id },
      relations: ['fromEntity', 'toEntity', 'activity', 'sourceMessage'],
    });

    if (!commitment) {
      throw new NotFoundException(`Commitment with id '${id}' not found`);
    }

    return commitment;
  }

  /**
   * Найти Commitments с фильтрами.
   */
  async findAll(options: FindCommitmentsOptions = {}): Promise<{
    items: Commitment[];
    total: number;
  }> {
    const {
      fromEntityId,
      toEntityId,
      entityId,
      status,
      type,
      activityId,
      hasDueDate,
      isOverdue,
      limit = 50,
      offset = 0,
    } = options;

    const qb = this.commitmentRepo
      .createQueryBuilder('c')
      .leftJoinAndSelect('c.fromEntity', 'fromEntity')
      .leftJoinAndSelect('c.toEntity', 'toEntity')
      .leftJoinAndSelect('c.activity', 'activity')
      .take(limit)
      .skip(offset)
      .orderBy('c.dueDate', 'ASC', 'NULLS LAST')
      .addOrderBy('c.createdAt', 'DESC');

    // Фильтр по участникам
    if (fromEntityId) {
      qb.andWhere('c.fromEntityId = :fromEntityId', { fromEntityId });
    }
    if (toEntityId) {
      qb.andWhere('c.toEntityId = :toEntityId', { toEntityId });
    }
    if (entityId) {
      qb.andWhere('(c.fromEntityId = :entityId OR c.toEntityId = :entityId)', { entityId });
    }

    // Фильтр по статусу
    if (status) {
      if (Array.isArray(status)) {
        qb.andWhere('c.status IN (:...statuses)', { statuses: status });
      } else {
        qb.andWhere('c.status = :status', { status });
      }
    }

    // Фильтр по типу
    if (type) {
      if (Array.isArray(type)) {
        qb.andWhere('c.type IN (:...types)', { types: type });
      } else {
        qb.andWhere('c.type = :type', { type });
      }
    }

    // Фильтр по активности
    if (activityId) {
      qb.andWhere('c.activityId = :activityId', { activityId });
    }

    // Фильтр по наличию дедлайна
    if (hasDueDate !== undefined) {
      if (hasDueDate) {
        qb.andWhere('c.dueDate IS NOT NULL');
      } else {
        qb.andWhere('c.dueDate IS NULL');
      }
    }

    // Фильтр по просроченным
    if (isOverdue) {
      qb.andWhere('c.dueDate < NOW()');
      qb.andWhere('c.status NOT IN (:...completedStatuses)', {
        completedStatuses: [CommitmentStatus.COMPLETED, CommitmentStatus.CANCELLED],
      });
    }

    const [items, total] = await qb.getManyAndCount();

    return { items, total };
  }

  /**
   * Создать новый Commitment.
   */
  async create(dto: CreateCommitmentDto): Promise<Commitment> {
    const commitment = this.commitmentRepo.create({
      type: dto.type,
      title: dto.title,
      description: dto.description,
      status: dto.status ?? CommitmentStatus.PENDING,
      priority: dto.priority ?? CommitmentPriority.MEDIUM,
      fromEntityId: dto.fromEntityId,
      toEntityId: dto.toEntityId,
      activityId: dto.activityId,
      sourceMessageId: dto.sourceMessageId,
      extractedEventId: dto.extractedEventId,
      dueDate: dto.dueDate,
      recurrenceRule: dto.recurrenceRule,
      confidence: dto.confidence,
      metadata: dto.metadata,
      notes: dto.notes,
    });

    const saved = await this.commitmentRepo.save(commitment);
    this.logger.log(`Created commitment: ${saved.id} (${saved.title})`);

    return this.findOne(saved.id);
  }

  /**
   * Обновить Commitment.
   */
  async update(id: string, updates: Partial<CreateCommitmentDto>): Promise<Commitment> {
    const commitment = await this.findOne(id);

    // Применяем только переданные поля
    Object.assign(commitment, updates);

    await this.commitmentRepo.save(commitment);
    this.logger.log(`Updated commitment: ${id}`);

    return this.findOne(id);
  }

  /**
   * Удалить Commitment.
   */
  async remove(id: string): Promise<{ deleted: true; id: string }> {
    const commitment = await this.findOne(id);
    await this.commitmentRepo.remove(commitment);
    this.logger.log(`Deleted commitment: ${id}`);
    return { deleted: true, id };
  }

  // ─────────────────────────────────────────────────────────────
  // Status Transitions
  // ─────────────────────────────────────────────────────────────

  /**
   * Пометить как выполненный.
   */
  async complete(id: string): Promise<Commitment> {
    const commitment = await this.findOne(id);
    commitment.status = CommitmentStatus.COMPLETED;
    commitment.completedAt = new Date();

    await this.commitmentRepo.save(commitment);
    this.logger.log(`Completed commitment: ${id}`);

    return this.findOne(id);
  }

  /**
   * Отменить обязательство.
   */
  async cancel(id: string): Promise<Commitment> {
    const commitment = await this.findOne(id);
    commitment.status = CommitmentStatus.CANCELLED;

    await this.commitmentRepo.save(commitment);
    this.logger.log(`Cancelled commitment: ${id}`);

    return this.findOne(id);
  }

  /**
   * Отложить обязательство.
   */
  async defer(id: string, newDueDate?: Date): Promise<Commitment> {
    const commitment = await this.findOne(id);
    commitment.status = CommitmentStatus.DEFERRED;
    if (newDueDate) {
      commitment.dueDate = newDueDate;
    }

    await this.commitmentRepo.save(commitment);
    this.logger.log(`Deferred commitment: ${id}`);

    return this.findOne(id);
  }

  /**
   * Начать выполнение.
   */
  async startProgress(id: string): Promise<Commitment> {
    const commitment = await this.findOne(id);
    commitment.status = CommitmentStatus.IN_PROGRESS;

    await this.commitmentRepo.save(commitment);
    this.logger.log(`Started progress on commitment: ${id}`);

    return this.findOne(id);
  }

  // ─────────────────────────────────────────────────────────────
  // Special Queries
  // ─────────────────────────────────────────────────────────────

  /**
   * Получить просроченные обязательства.
   */
  async getOverdue(entityId?: string): Promise<Commitment[]> {
    const qb = this.commitmentRepo
      .createQueryBuilder('c')
      .leftJoinAndSelect('c.fromEntity', 'fromEntity')
      .leftJoinAndSelect('c.toEntity', 'toEntity')
      .where('c.dueDate < NOW()')
      .andWhere('c.status NOT IN (:...statuses)', {
        statuses: [CommitmentStatus.COMPLETED, CommitmentStatus.CANCELLED],
      })
      .orderBy('c.dueDate', 'ASC');

    if (entityId) {
      qb.andWhere('(c.fromEntityId = :entityId OR c.toEntityId = :entityId)', { entityId });
    }

    return qb.getMany();
  }

  /**
   * Получить обязательства на сегодня.
   */
  async getDueToday(entityId?: string): Promise<Commitment[]> {
    const qb = this.commitmentRepo
      .createQueryBuilder('c')
      .leftJoinAndSelect('c.fromEntity', 'fromEntity')
      .leftJoinAndSelect('c.toEntity', 'toEntity')
      .where('DATE(c.dueDate) = CURRENT_DATE')
      .andWhere('c.status NOT IN (:...statuses)', {
        statuses: [CommitmentStatus.COMPLETED, CommitmentStatus.CANCELLED],
      })
      .orderBy('c.dueDate', 'ASC');

    if (entityId) {
      qb.andWhere('(c.fromEntityId = :entityId OR c.toEntityId = :entityId)', { entityId });
    }

    return qb.getMany();
  }

  /**
   * Получить обязательства, требующие напоминания.
   */
  async getForReminder(): Promise<Commitment[]> {
    return this.commitmentRepo
      .createQueryBuilder('c')
      .leftJoinAndSelect('c.fromEntity', 'fromEntity')
      .leftJoinAndSelect('c.toEntity', 'toEntity')
      .where('c.nextReminderAt <= NOW()')
      .andWhere('c.status NOT IN (:...statuses)', {
        statuses: [CommitmentStatus.COMPLETED, CommitmentStatus.CANCELLED],
      })
      .orderBy('c.nextReminderAt', 'ASC')
      .getMany();
  }

  /**
   * Обновить время следующего напоминания.
   */
  async updateReminder(id: string, nextReminderAt: Date): Promise<void> {
    await this.commitmentRepo.update(id, {
      nextReminderAt,
      reminderCount: () => 'reminder_count + 1',
    });
  }
}
