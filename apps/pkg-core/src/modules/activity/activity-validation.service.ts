import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Activity, ActivityType } from '@pkg/entities';

/**
 * Правила иерархии типов Activity.
 *
 * Ключ — родительский тип, значение — массив допустимых дочерних типов.
 * Пустой массив означает лист дерева (дети запрещены).
 */
const HIERARCHY_RULES: Record<ActivityType, ActivityType[]> = {
  [ActivityType.AREA]: [ActivityType.BUSINESS, ActivityType.DIRECTION, ActivityType.PROJECT],
  [ActivityType.BUSINESS]: [ActivityType.DIRECTION, ActivityType.PROJECT],
  [ActivityType.DIRECTION]: [ActivityType.PROJECT, ActivityType.INITIATIVE],
  [ActivityType.PROJECT]: [ActivityType.TASK, ActivityType.PROJECT, ActivityType.MILESTONE],
  [ActivityType.INITIATIVE]: [ActivityType.PROJECT, ActivityType.TASK],
  [ActivityType.TASK]: [],
  [ActivityType.MILESTONE]: [],
  [ActivityType.HABIT]: [ActivityType.TASK],
  [ActivityType.LEARNING]: [ActivityType.TASK],
  [ActivityType.EVENT_SERIES]: [ActivityType.TASK],
};

/**
 * ActivityValidationService — валидация иерархии типов Activity.
 *
 * Проверяет:
 * - Допустимость дочернего типа для родительского
 * - Существование родителя
 * - Отсутствие циклических ссылок при перемещении
 */
@Injectable()
export class ActivityValidationService {
  private readonly logger = new Logger(ActivityValidationService.name);

  constructor(
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
  ) {}

  /**
   * Проверить что дочерний тип допустим для данного родительского типа.
   *
   * @throws BadRequestException если иерархия нарушена
   */
  validateTypeHierarchy(parentType: ActivityType, childType: ActivityType): void {
    const allowed = HIERARCHY_RULES[parentType];

    if (!allowed || !allowed.includes(childType)) {
      const allowedList = allowed && allowed.length > 0
        ? allowed.join(', ')
        : 'none (leaf node)';

      throw new BadRequestException(
        `Cannot create ${childType} under ${parentType}. Allowed children: ${allowedList}`,
      );
    }
  }

  /**
   * Полная валидация при создании Activity.
   *
   * Проверяет:
   * 1. Если parentId указан — родитель существует
   * 2. Иерархия типов допустима
   *
   * @throws NotFoundException если parent не найден
   * @throws BadRequestException если иерархия нарушена
   */
  async validateCreate(params: {
    activityType: ActivityType;
    parentId?: string | null;
  }): Promise<void> {
    const { activityType, parentId } = params;

    if (!parentId) {
      // Корневые Activity — без проверки иерархии
      this.logger.debug(
        `Validation passed: creating root activity of type ${activityType}`,
      );
      return;
    }

    const parent = await this.activityRepo.findOne({
      where: { id: parentId },
      select: ['id', 'activityType', 'name'],
    });

    if (!parent) {
      throw new NotFoundException(
        `Parent activity with id '${parentId}' not found`,
      );
    }

    this.validateTypeHierarchy(parent.activityType, activityType);

    this.logger.debug(
      `Validation passed: ${activityType} under ${parent.activityType} (parent: ${parent.name})`,
    );
  }

  /**
   * Валидация при обновлении Activity.
   *
   * Если меняется parentId — проверяет:
   * 1. Новый родитель существует
   * 2. Иерархия типов допустима
   * 3. Нет циклических ссылок (не пытаемся стать потомком самого себя)
   *
   * @throws NotFoundException если parent не найден
   * @throws BadRequestException если иерархия нарушена или цикл
   */
  async validateUpdate(params: {
    activityId: string;
    activityType: ActivityType;
    newParentId?: string | null;
  }): Promise<void> {
    const { activityId, activityType, newParentId } = params;

    if (newParentId === undefined) {
      // parentId не меняется — ничего проверять не нужно
      return;
    }

    if (newParentId === null) {
      // Перемещение в корень — допустимо всегда
      this.logger.debug(
        `Validation passed: moving activity ${activityId} to root`,
      );
      return;
    }

    if (newParentId === activityId) {
      throw new BadRequestException(
        'Activity cannot be its own parent',
      );
    }

    const parent = await this.activityRepo.findOne({
      where: { id: newParentId },
      select: ['id', 'activityType', 'name', 'materializedPath'],
    });

    if (!parent) {
      throw new NotFoundException(
        `Parent activity with id '${newParentId}' not found`,
      );
    }

    this.validateTypeHierarchy(parent.activityType, activityType);

    await this.checkNoCycle(activityId, newParentId);

    this.logger.debug(
      `Validation passed: moving ${activityType} (${activityId}) under ${parent.activityType} (${parent.name})`,
    );
  }

  /**
   * Получить допустимые дочерние типы для данного типа.
   */
  getAllowedChildTypes(parentType: ActivityType): ActivityType[] {
    return HIERARCHY_RULES[parentType] ?? [];
  }

  /**
   * Проверить нет ли циклической ссылки.
   *
   * Проходит по materializedPath чтобы убедиться что newParentId
   * не является потомком activityId.
   *
   * Если newParentId содержит activityId в своём пути — это цикл:
   * перемещение A под потомка A создало бы цикл A -> ... -> A.
   *
   * @throws BadRequestException если обнаружен цикл
   */
  async checkNoCycle(activityId: string, newParentId: string): Promise<void> {
    const newParent = await this.activityRepo.findOne({
      where: { id: newParentId },
      select: ['id', 'materializedPath'],
    });

    if (!newParent) {
      // Родитель не найден — ошибку бросит validateUpdate
      return;
    }

    // materializedPath содержит UUID предков через "/", например: "uuid1/uuid2/uuid3"
    // Если activityId присутствует в materializedPath нового родителя,
    // значит новый родитель — потомок activityId, и перемещение создаст цикл.
    const pathSegments = newParent.materializedPath
      ? newParent.materializedPath.split('/')
      : [];

    if (pathSegments.includes(activityId)) {
      throw new BadRequestException(
        `Cannot move activity '${activityId}' under '${newParentId}': ` +
        `it would create a cycle (the target is a descendant of the source)`,
      );
    }

    // Также проверяем сам newParentId — если он совпадает с activityId,
    // это прямой цикл (уже проверено в validateUpdate, но для standalone вызова)
    if (newParentId === activityId) {
      throw new BadRequestException(
        'Activity cannot be its own parent',
      );
    }
  }
}
