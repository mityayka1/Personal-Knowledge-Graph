import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not, IsNull, TreeRepository } from 'typeorm';
import { randomUUID } from 'crypto';
import {
  Activity,
  ActivityType,
  ActivityStatus,
  ActivityPriority,
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
  parentId?: string | null;
  ownerEntityId?: string;
  clientEntityId?: string;
  hasDeadline?: boolean;
  search?: string;
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
   * Найти активность по ID с расширенными связями (members, children count).
   */
  async findOneWithDetails(id: string): Promise<Activity & { childrenCount: number; members: ActivityMember[] }> {
    const activity = await this.activityRepo.findOne({
      where: { id },
      relations: ['parent', 'ownerEntity', 'clientEntity'],
    });

    if (!activity) {
      throw new NotFoundException(`Activity with id '${id}' not found`);
    }

    const [members, childrenCount] = await Promise.all([
      this.memberRepo.find({
        where: { activityId: id, isActive: true },
        relations: ['entity'],
        order: { role: 'ASC', joinedAt: 'ASC' },
      }),
      this.activityRepo.count({ where: { parentId: id } }),
    ]);

    return Object.assign(activity, { childrenCount, members });
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
      search,
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

    // Поиск по названию (fuzzy search)
    if (search) {
      qb.andWhere('activity.name ILIKE :search', { search: `%${search}%` });
    }

    const [items, total] = await qb.getManyAndCount();

    return { items, total };
  }

  /**
   * Создать новую активность.
   *
   * ВАЖНО: Используем QueryBuilder.insert() вместо repository.save()
   * для обхода бага TypeORM 0.3.x с ClosureSubjectExecutor.
   * @see https://github.com/typeorm/typeorm/issues/9658
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

    // Генерируем ID вручную, т.к. QueryBuilder не возвращает entity
    const activityId = randomUUID();

    // Используем QueryBuilder для обхода closure-table бага
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const values: any = {
      id: activityId,
      name: dto.name,
      activityType: dto.activityType,
      description: dto.description ?? null,
      status: dto.status ?? ActivityStatus.ACTIVE,
      priority: dto.priority,
      context: dto.context,
      parentId: dto.parentId ?? null,
      depth,
      materializedPath,
      ownerEntityId: dto.ownerEntityId,
      clientEntityId: dto.clientEntityId ?? null,
      deadline: dto.deadline ? new Date(dto.deadline) : null,
      startDate: dto.startDate ? new Date(dto.startDate) : null,
      recurrenceRule: dto.recurrenceRule ?? null,
      tags: dto.tags ?? null,
      progress: dto.progress ?? null,
      metadata: dto.metadata ?? null,
    };

    await this.activityRepo
      .createQueryBuilder()
      .insert()
      .into(Activity)
      .values(values)
      .execute();

    this.logger.log(`Created activity: ${activityId} (${dto.name})`);

    return this.findOne(activityId);
  }

  /**
   * Обновить активность.
   */
  async update(id: string, dto: UpdateActivityDto): Promise<Activity> {
    const activity = await this.findOne(id);

    // Обновить простые поля
    if (dto.activityType !== undefined) activity.activityType = dto.activityType;
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
      // null clears metadata, object merges with existing
      activity.metadata = dto.metadata === null
        ? null
        : { ...activity.metadata, ...dto.metadata };
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
      // Store old values for cascade update
      const oldDepth = activity.depth;
      const oldPath = activity.materializedPath;
      const oldFullPath = oldPath ? `${oldPath}/${activity.id}` : activity.id;

      if (dto.parentId === null) {
        activity.parentId = null;
        activity.parent = null;
        activity.depth = 0;
        activity.materializedPath = null;
      } else {
        const newParent = await this.findOne(dto.parentId);
        activity.parentId = dto.parentId;
        activity.parent = newParent;
        activity.depth = newParent.depth + 1;
        activity.materializedPath = newParent.materializedPath
          ? `${newParent.materializedPath}/${newParent.id}`
          : newParent.id;
      }

      // Cascade update descendants' materializedPath and depth
      const newFullPath = activity.materializedPath
        ? `${activity.materializedPath}/${activity.id}`
        : activity.id;
      const depthDelta = activity.depth - oldDepth;

      await this.cascadeUpdateDescendantPaths(
        activity.id,
        oldFullPath,
        newFullPath,
        depthDelta,
      );
    }

    // Обновить lastActivityAt
    activity.lastActivityAt = new Date();

    // Используем QueryBuilder для обхода closure-table бага (аналогично create())
    // TypeORM save() вызывает ClosureSubjectExecutor.update(), который
    // падает с "Cannot read properties of undefined (reading 'getEntityValue')"
    // при изменении parentId на closure-table сущности.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateSet: any = {
      activityType: activity.activityType,
      name: activity.name,
      description: activity.description,
      status: activity.status,
      priority: activity.priority,
      context: activity.context,
      ownerEntityId: activity.ownerEntityId,
      clientEntityId: activity.clientEntityId,
      recurrenceRule: activity.recurrenceRule,
      tags: activity.tags,
      progress: activity.progress,
      metadata: activity.metadata,
      deadline: activity.deadline,
      startDate: activity.startDate,
      endDate: activity.endDate,
      parentId: activity.parentId,
      depth: activity.depth,
      materializedPath: activity.materializedPath,
      lastActivityAt: activity.lastActivityAt,
    };

    await this.activityRepo
      .createQueryBuilder()
      .update(Activity)
      .set(updateSet)
      .where('id = :id', { id })
      .execute();

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
   * @param clientEntityId - UUID клиента
   * @param includeCompleted - включить завершённые проекты (default: false)
   */
  async getProjectsByClient(
    clientEntityId: string,
    includeCompleted = false,
  ): Promise<Activity[]> {
    const excludedStatuses = includeCompleted
      ? [ActivityStatus.CANCELLED, ActivityStatus.ARCHIVED]
      : [ActivityStatus.COMPLETED, ActivityStatus.CANCELLED, ActivityStatus.ARCHIVED];

    return this.activityRepo.find({
      where: {
        clientEntityId,
        activityType: ActivityType.PROJECT,
        status: Not(In(excludedStatuses)),
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
   * Найти активности без описания (для обогащения через AI).
   */
  async findActivitiesWithoutDescriptions(): Promise<Activity[]> {
    return this.activityRepo
      .createQueryBuilder('a')
      .leftJoinAndSelect('a.parent', 'parent')
      .leftJoinAndSelect('a.clientEntity', 'clientEntity')
      .where('a.description IS NULL')
      .andWhere('a.status != :archived', { archived: ActivityStatus.ARCHIVED })
      .orderBy('a.updatedAt', 'DESC')
      .getMany();
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
  // Enrichment
  // ─────────────────────────────────────────────────────────────

  /**
   * Enrich existing Activity with new data from extraction.
   * Only fills empty/null/default fields; never overwrites existing values.
   * Tags are merged (union of unique values).
   * Always updates lastActivityAt.
   *
   * Uses QueryBuilder for update to bypass TypeORM closure-table bug.
   * @see https://github.com/typeorm/typeorm/issues/9658
   */
  async enrichActivity(
    id: string,
    fields: {
      description?: string;
      tags?: string[];
      deadline?: Date;
      priority?: string;
    },
  ): Promise<void> {
    const activity = await this.activityRepo.findOne({ where: { id } });
    if (!activity) {
      this.logger.warn(`enrichActivity: activity ${id} not found, skipping`);
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateSet: Record<string, any> = {
      lastActivityAt: new Date(),
    };
    const enriched: string[] = [];

    // description: update only if current is null or empty
    if (fields.description && !activity.description) {
      updateSet.description = fields.description;
      enriched.push('description');
    }

    // tags: merge arrays (unique values), never overwrite
    if (fields.tags?.length) {
      const existing = activity.tags ?? [];
      const merged = [...new Set([...existing, ...fields.tags])];
      if (merged.length > existing.length) {
        updateSet.tags = merged;
        enriched.push(`tags(+${merged.length - existing.length})`);
      }
    }

    // deadline: update only if current is null
    if (fields.deadline && !activity.deadline) {
      updateSet.deadline = fields.deadline;
      enriched.push('deadline');
    }

    // priority: update only if current is 'none' or default 'medium' (extraction default)
    // Rationale: extracted activities start with MEDIUM default, so we enrich them
    if (
      fields.priority &&
      (activity.priority === ActivityPriority.NONE ||
        activity.priority === ActivityPriority.MEDIUM)
    ) {
      const mapped = this.mapPriorityString(fields.priority);
      if (mapped && mapped !== activity.priority) {
        updateSet.priority = mapped;
        enriched.push('priority');
      }
    }

    await this.activityRepo
      .createQueryBuilder()
      .update(Activity)
      .set(updateSet)
      .where('id = :id', { id })
      .execute();

    if (enriched.length > 0) {
      this.logger.log(`Enriched activity ${id}: ${enriched.join(', ')}`);
    }
  }

  /**
   * Map priority string from extraction to ActivityPriority enum.
   */
  private mapPriorityString(priority: string): ActivityPriority | null {
    switch (priority.toLowerCase()) {
      case 'critical':
      case 'urgent':
        return ActivityPriority.CRITICAL;
      case 'high':
        return ActivityPriority.HIGH;
      case 'medium':
        return ActivityPriority.MEDIUM;
      case 'low':
        return ActivityPriority.LOW;
      default:
        return null;
    }
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
    await this.findOne(id); // validate exists

    // Use QueryBuilder to avoid TypeORM closure-table save() bug
    await this.activityRepo
      .createQueryBuilder()
      .update()
      .set({ status: ActivityStatus.ARCHIVED, lastActivityAt: new Date() })
      .where('id = :id', { id })
      .execute();

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

  // ─────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────

  /**
   * Cascade update materializedPath and depth for all descendants
   * when an activity is moved to a new parent.
   *
   * @param activityId - ID of the moved activity
   * @param oldFullPath - Old full path including activity ID (e.g., "A/B/C")
   * @param newFullPath - New full path including activity ID (e.g., "X/A/B/C")
   * @param depthDelta - Difference in depth (newDepth - oldDepth)
   */
  private async cascadeUpdateDescendantPaths(
    activityId: string,
    oldFullPath: string,
    newFullPath: string,
    depthDelta: number,
  ): Promise<void> {
    // Find all descendants by materializedPath prefix
    // Descendants have materializedPath that starts with oldFullPath
    const descendants = await this.activityRepo
      .createQueryBuilder('a')
      .where('a.materializedPath LIKE :pattern', { pattern: `${oldFullPath}%` })
      .getMany();

    if (descendants.length === 0) {
      return;
    }

    this.logger.debug(
      `Cascade updating ${descendants.length} descendants of activity ${activityId}`,
    );

    // Update descendants using raw query to avoid closure-table bug
    // (TypeORM 0.3.x save() crashes with ClosureSubjectExecutor.getEntityValue)
    await this.activityRepo.query(
      `UPDATE activities
       SET "materializedPath" = REPLACE("materializedPath", $1, $2),
           "depth" = "depth" + $3
       WHERE "materializedPath" LIKE $4`,
      [oldFullPath, newFullPath, depthDelta, `${oldFullPath}%`],
    );

    this.logger.log(
      `Cascade updated ${descendants.length} descendants: path "${oldFullPath}" → "${newFullPath}"`,
    );
  }
}
