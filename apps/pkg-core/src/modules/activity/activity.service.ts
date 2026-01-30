import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not, IsNull, TreeRepository } from 'typeorm';
import {
  Activity,
  ActivityType,
  ActivityStatus,
  ActivityContext,
  ActivityMember,
  ActivityMemberRole,
} from '@pkg/entities';
import { CreateActivityDto } from './dto/create-activity.dto';
import { UpdateActivityDto } from './dto/update-activity.dto';

/**
 * Опции для поиска активностей.
 */
export interface FindActivitiesOptions {
  type?: ActivityType | ActivityType[];
  status?: ActivityStatus | ActivityStatus[];
  context?: ActivityContext;
  parentId?: string;
  ownerEntityId?: string;
  clientEntityId?: string;
  hasDeadline?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * ActivityService — CRUD и специальные запросы для активностей.
 *
 * Активности образуют иерархию через closure-table:
 * - Area → Business → Direction → Project → Task
 * - Любая вложенность допустима
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
    @InjectRepository(ActivityMember)
    private readonly memberRepo: Repository<ActivityMember>,
  ) {}

  // ─────────────────────────────────────────────────────────────
  // CRUD Operations
  // ─────────────────────────────────────────────────────────────

  /**
   * Найти активность по ID.
   */
  async findOne(id: string): Promise<Activity> {
    const activity = await this.activityRepo.findOne({
      where: { id },
      relations: ['parent', 'ownerEntity', 'clientEntity'],
    });

    if (!activity) {
      throw new NotFoundException(`Activity with id '${id}' not found`);
    }

    return activity;
  }

  /**
   * Найти активности с фильтрами.
   */
  async findAll(options: FindActivitiesOptions = {}): Promise<{
    items: Activity[];
    total: number;
  }> {
    const {
      type,
      status,
      context,
      parentId,
      ownerEntityId,
      clientEntityId,
      hasDeadline,
      limit = 50,
      offset = 0,
    } = options;

    const qb = this.activityRepo
      .createQueryBuilder('activity')
      .leftJoinAndSelect('activity.parent', 'parent')
      .leftJoinAndSelect('activity.ownerEntity', 'ownerEntity')
      .leftJoinAndSelect('activity.clientEntity', 'clientEntity')
      .take(limit)
      .skip(offset)
      .orderBy('activity.updatedAt', 'DESC');

    // Фильтр по типу
    if (type) {
      if (Array.isArray(type)) {
        qb.andWhere('activity.activityType IN (:...types)', { types: type });
      } else {
        qb.andWhere('activity.activityType = :type', { type });
      }
    }

    // Фильтр по статусу
    if (status) {
      if (Array.isArray(status)) {
        qb.andWhere('activity.status IN (:...statuses)', { statuses: status });
      } else {
        qb.andWhere('activity.status = :status', { status });
      }
    }

    // Фильтр по контексту
    if (context) {
      qb.andWhere('activity.context = :context', { context });
    }

    // Фильтр по родителю
    if (parentId !== undefined) {
      if (parentId === null) {
        qb.andWhere('activity.parentId IS NULL');
      } else {
        qb.andWhere('activity.parentId = :parentId', { parentId });
      }
    }

    // Фильтр по владельцу
    if (ownerEntityId) {
      qb.andWhere('activity.ownerEntityId = :ownerEntityId', { ownerEntityId });
    }

    // Фильтр по клиенту
    if (clientEntityId) {
      qb.andWhere('activity.clientEntityId = :clientEntityId', { clientEntityId });
    }

    // Фильтр по наличию дедлайна
    if (hasDeadline !== undefined) {
      if (hasDeadline) {
        qb.andWhere('activity.deadline IS NOT NULL');
      } else {
        qb.andWhere('activity.deadline IS NULL');
      }
    }

    const [items, total] = await qb.getManyAndCount();

    return { items, total };
  }

  /**
   * Создать новую активность.
   */
  async create(dto: CreateActivityDto): Promise<Activity> {
    // Вычислить depth и materialized path
    let depth = 0;
    let materializedPath: string | null = null;

    if (dto.parentId) {
      const parent = await this.findOne(dto.parentId);
      depth = parent.depth + 1;
      materializedPath = parent.materializedPath
        ? `${parent.materializedPath}/${parent.id}`
        : parent.id;
    }

    const activity = this.activityRepo.create({
      name: dto.name,
      activityType: dto.activityType,
      description: dto.description,
      status: dto.status ?? ActivityStatus.ACTIVE,
      priority: dto.priority,
      context: dto.context,
      parentId: dto.parentId,
      depth,
      materializedPath,
      ownerEntityId: dto.ownerEntityId,
      clientEntityId: dto.clientEntityId,
      deadline: dto.deadline ? new Date(dto.deadline) : undefined,
      startDate: dto.startDate ? new Date(dto.startDate) : undefined,
      recurrenceRule: dto.recurrenceRule,
      tags: dto.tags,
      progress: dto.progress,
      metadata: dto.metadata,
    });

    const saved = await this.activityRepo.save(activity);
    this.logger.log(`Created activity: ${saved.id} (${saved.name})`);

    return this.findOne(saved.id);
  }

  /**
   * Обновить активность.
   */
  async update(id: string, dto: UpdateActivityDto): Promise<Activity> {
    const activity = await this.findOne(id);

    // Обновить простые поля
    if (dto.name !== undefined) activity.name = dto.name;
    if (dto.description !== undefined) activity.description = dto.description;
    if (dto.status !== undefined) activity.status = dto.status;
    if (dto.priority !== undefined) activity.priority = dto.priority;
    if (dto.context !== undefined) activity.context = dto.context;
    if (dto.ownerEntityId !== undefined) activity.ownerEntityId = dto.ownerEntityId;
    if (dto.clientEntityId !== undefined) activity.clientEntityId = dto.clientEntityId;
    if (dto.recurrenceRule !== undefined) activity.recurrenceRule = dto.recurrenceRule;
    if (dto.tags !== undefined) activity.tags = dto.tags;
    if (dto.progress !== undefined) activity.progress = dto.progress;
    if (dto.metadata !== undefined) {
      activity.metadata = { ...activity.metadata, ...dto.metadata };
    }

    // Обновить даты
    if (dto.deadline !== undefined) {
      activity.deadline = dto.deadline ? new Date(dto.deadline) : null;
    }
    if (dto.startDate !== undefined) {
      activity.startDate = dto.startDate ? new Date(dto.startDate) : null;
    }
    if (dto.endDate !== undefined) {
      activity.endDate = dto.endDate ? new Date(dto.endDate) : null;
    }

    // Обновить родителя (пересчитать depth и path)
    if (dto.parentId !== undefined && dto.parentId !== activity.parentId) {
      if (dto.parentId === null) {
        activity.parentId = null;
        activity.depth = 0;
        activity.materializedPath = null;
      } else {
        const newParent = await this.findOne(dto.parentId);
        activity.parentId = dto.parentId;
        activity.depth = newParent.depth + 1;
        activity.materializedPath = newParent.materializedPath
          ? `${newParent.materializedPath}/${newParent.id}`
          : newParent.id;
      }
    }

    // Обновить lastActivityAt
    activity.lastActivityAt = new Date();

    await this.activityRepo.save(activity);
    this.logger.log(`Updated activity: ${id}`);

    return this.findOne(id);
  }

  /**
   * Удалить активность.
   */
  async remove(id: string): Promise<{ deleted: true; id: string }> {
    const activity = await this.findOne(id);
    await this.activityRepo.remove(activity);
    this.logger.log(`Deleted activity: ${id}`);
    return { deleted: true, id };
  }

  // ─────────────────────────────────────────────────────────────
  // Hierarchical Queries (Tree Operations)
  // ─────────────────────────────────────────────────────────────

  /**
   * Получить всё дерево активностей.
   * Если указан rootId — возвращает поддерево от этого корня.
   */
  async getActivityTree(rootId?: string): Promise<Activity[]> {
    const treeRepo = this.activityRepo.manager.getTreeRepository(Activity);

    if (rootId) {
      const root = await treeRepo.findOne({ where: { id: rootId } });
      if (!root) {
        throw new NotFoundException(`Activity with id '${rootId}' not found`);
      }
      return [await treeRepo.findDescendantsTree(root)];
    }

    return treeRepo.findTrees();
  }

  /**
   * Получить предков активности (путь от корня).
   */
  async getAncestors(id: string): Promise<Activity[]> {
    const treeRepo = this.activityRepo.manager.getTreeRepository(Activity);
    const activity = await treeRepo.findOne({ where: { id } });

    if (!activity) {
      throw new NotFoundException(`Activity with id '${id}' not found`);
    }

    return treeRepo.findAncestors(activity);
  }

  /**
   * Получить прямых потомков (children).
   */
  async getChildren(parentId: string): Promise<Activity[]> {
    return this.activityRepo.find({
      where: { parentId },
      relations: ['ownerEntity', 'clientEntity'],
      order: { name: 'ASC' },
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Special Queries
  // ─────────────────────────────────────────────────────────────

  /**
   * Получить активные проекты с дедлайнами.
   * Сортировка по ближайшему дедлайну.
   */
  async getActiveProjectsWithDeadlines(): Promise<Activity[]> {
    return this.activityRepo.find({
      where: {
        activityType: In([ActivityType.PROJECT, ActivityType.TASK]),
        status: In([ActivityStatus.ACTIVE, ActivityStatus.IDEA]),
        deadline: Not(IsNull()),
      },
      order: { deadline: 'ASC' },
      relations: ['clientEntity', 'parent', 'ownerEntity'],
    });
  }

  /**
   * Получить все активности по контексту (work/personal).
   */
  async getByContext(context: ActivityContext): Promise<Activity[]> {
    return this.activityRepo.find({
      where: {
        context,
        status: Not(ActivityStatus.ARCHIVED),
      },
      relations: ['parent', 'ownerEntity'],
      order: { updatedAt: 'DESC' },
    });
  }

  /**
   * Получить проекты по клиенту.
   */
  async getProjectsByClient(clientEntityId: string): Promise<Activity[]> {
    return this.activityRepo.find({
      where: {
        clientEntityId,
        activityType: ActivityType.PROJECT,
        status: Not(
          In([ActivityStatus.COMPLETED, ActivityStatus.CANCELLED, ActivityStatus.ARCHIVED]),
        ),
      },
      order: { updatedAt: 'DESC' },
    });
  }

  /**
   * Найти активность по упоминанию (fuzzy search).
   * Используется для inference из сообщений.
   */
  async findByMention(mention: string): Promise<Activity | null> {
    return this.activityRepo
      .createQueryBuilder('a')
      .where('a.name ILIKE :pattern', { pattern: `%${mention}%` })
      .andWhere('a.status NOT IN (:...statuses)', {
        statuses: [ActivityStatus.ARCHIVED, ActivityStatus.CANCELLED],
      })
      .orderBy('a.lastActivityAt', 'DESC', 'NULLS LAST')
      .getOne();
  }

  /**
   * Получить активности с просроченным дедлайном.
   */
  async getOverdueActivities(): Promise<Activity[]> {
    return this.activityRepo
      .createQueryBuilder('a')
      .where('a.deadline < NOW()')
      .andWhere('a.status IN (:...statuses)', {
        statuses: [ActivityStatus.ACTIVE, ActivityStatus.IDEA],
      })
      .orderBy('a.deadline', 'ASC')
      .getMany();
  }

  /**
   * Получить активности на сегодня (дедлайн сегодня).
   */
  async getTodayDeadlines(): Promise<Activity[]> {
    return this.activityRepo
      .createQueryBuilder('a')
      .where('DATE(a.deadline) = CURRENT_DATE')
      .andWhere('a.status IN (:...statuses)', {
        statuses: [ActivityStatus.ACTIVE, ActivityStatus.IDEA],
      })
      .orderBy('a.deadline', 'ASC')
      .getMany();
  }

  // ─────────────────────────────────────────────────────────────
  // Status Transitions
  // ─────────────────────────────────────────────────────────────

  /**
   * Пометить активность как завершённую.
   */
  async complete(id: string): Promise<Activity> {
    const activity = await this.findOne(id);
    activity.status = ActivityStatus.COMPLETED;
    activity.endDate = new Date();
    activity.progress = 100;
    activity.lastActivityAt = new Date();

    await this.activityRepo.save(activity);
    this.logger.log(`Completed activity: ${id}`);

    return this.findOne(id);
  }

  /**
   * Отменить активность.
   */
  async cancel(id: string): Promise<Activity> {
    const activity = await this.findOne(id);
    activity.status = ActivityStatus.CANCELLED;
    activity.endDate = new Date();
    activity.lastActivityAt = new Date();

    await this.activityRepo.save(activity);
    this.logger.log(`Cancelled activity: ${id}`);

    return this.findOne(id);
  }

  /**
   * Поставить на паузу.
   */
  async pause(id: string): Promise<Activity> {
    const activity = await this.findOne(id);
    activity.status = ActivityStatus.PAUSED;
    activity.lastActivityAt = new Date();

    await this.activityRepo.save(activity);
    this.logger.log(`Paused activity: ${id}`);

    return this.findOne(id);
  }

  /**
   * Возобновить (сделать активной).
   */
  async resume(id: string): Promise<Activity> {
    const activity = await this.findOne(id);
    activity.status = ActivityStatus.ACTIVE;
    activity.lastActivityAt = new Date();

    await this.activityRepo.save(activity);
    this.logger.log(`Resumed activity: ${id}`);

    return this.findOne(id);
  }

  /**
   * Архивировать активность.
   */
  async archive(id: string): Promise<Activity> {
    const activity = await this.findOne(id);
    activity.status = ActivityStatus.ARCHIVED;
    activity.lastActivityAt = new Date();

    await this.activityRepo.save(activity);
    this.logger.log(`Archived activity: ${id}`);

    return this.findOne(id);
  }

  // ─────────────────────────────────────────────────────────────
  // Activity Members
  // ─────────────────────────────────────────────────────────────

  /**
   * Добавить участника к активности.
   */
  async addMember(
    activityId: string,
    entityId: string,
    role: ActivityMemberRole = ActivityMemberRole.MEMBER,
  ): Promise<ActivityMember> {
    await this.findOne(activityId); // Validate activity exists

    const member = this.memberRepo.create({
      activityId,
      entityId,
      role,
      joinedAt: new Date(),
    });

    return this.memberRepo.save(member);
  }

  /**
   * Получить участников активности.
   */
  async getMembers(activityId: string): Promise<ActivityMember[]> {
    return this.memberRepo.find({
      where: { activityId },
      relations: ['entity'],
    });
  }

  /**
   * Удалить участника.
   */
  async removeMember(activityId: string, entityId: string): Promise<void> {
    await this.memberRepo.delete({ activityId, entityId });
  }
}
