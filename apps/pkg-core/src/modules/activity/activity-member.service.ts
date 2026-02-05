import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ActivityMember,
  ActivityMemberRole,
  EntityRecord,
} from '@pkg/entities';

/**
 * Параметры для разрешения и создания участников Activity.
 */
export interface ResolveAndCreateMembersParams {
  /** ID Activity для которой создаются участники */
  activityId: string;
  /** Массив имён участников из extraction (строки) */
  participants: string[];
  /** ID владельца (создаётся как OWNER) */
  ownerEntityId: string;
  /** ID клиента (создаётся как CLIENT) */
  clientEntityId?: string;
}

/**
 * Параметры для добавления одного участника.
 */
export interface AddMemberParams {
  activityId: string;
  entityId: string;
  role: ActivityMemberRole;
  notes?: string;
}

/**
 * ActivityMemberService — управление участниками Activity.
 *
 * Ключевая функция — resolveAndCreateMembers():
 * принимает строковые имена из extraction и создаёт
 * структурированные связи Activity <-> Entity.
 */
@Injectable()
export class ActivityMemberService {
  private readonly logger = new Logger(ActivityMemberService.name);

  constructor(
    @InjectRepository(ActivityMember)
    private readonly memberRepo: Repository<ActivityMember>,
    @InjectRepository(EntityRecord)
    private readonly entityRepo: Repository<EntityRecord>,
  ) {}

  /**
   * Разрешить имена участников в Entity и создать ActivityMember записи.
   *
   * Это ключевой метод — принимает строковые имена из extraction
   * и создаёт структурированные связи Activity <-> Entity.
   *
   * Логика:
   * 1. Создать OWNER запись для ownerEntityId
   * 2. Если clientEntityId — создать CLIENT запись
   * 3. Для каждого participant name:
   *    a. findEntityByName(name) — ищем Entity
   *    b. Если найден И это не owner и не client — создать MEMBER запись
   *    c. Если не найден — логируем warning, пропускаем
   * 4. Возвращаем все созданные записи
   */
  async resolveAndCreateMembers(
    params: ResolveAndCreateMembersParams,
  ): Promise<ActivityMember[]> {
    const { activityId, participants, ownerEntityId, clientEntityId } = params;
    const createdMembers: ActivityMember[] = [];

    this.logger.log(
      `Resolving members for activity ${activityId}: ` +
        `owner=${ownerEntityId}, client=${clientEntityId ?? 'none'}, ` +
        `participants=[${participants.join(', ')}]`,
    );

    // 1. Создать OWNER запись
    const ownerMember = await this.addMember({
      activityId,
      entityId: ownerEntityId,
      role: ActivityMemberRole.OWNER,
    });
    if (ownerMember) {
      createdMembers.push(ownerMember);
    }

    // 2. Создать CLIENT запись если указан
    if (clientEntityId) {
      const clientMember = await this.addMember({
        activityId,
        entityId: clientEntityId,
        role: ActivityMemberRole.CLIENT,
      });
      if (clientMember) {
        createdMembers.push(clientMember);
      }
    }

    // 3. Разрешить participant names в Entity и создать MEMBER записи
    const knownEntityIds = new Set<string>([ownerEntityId]);
    if (clientEntityId) {
      knownEntityIds.add(clientEntityId);
    }

    for (const participantName of participants) {
      const trimmedName = participantName.trim();
      if (!trimmedName) {
        continue;
      }

      const entity = await this.findEntityByName(trimmedName);

      if (!entity) {
        this.logger.warn(
          `Could not resolve participant "${trimmedName}" for activity ${activityId} — entity not found, skipping`,
        );
        continue;
      }

      // Пропускаем если это уже owner или client
      if (knownEntityIds.has(entity.id)) {
        this.logger.debug(
          `Participant "${trimmedName}" (${entity.id}) is already owner/client, skipping`,
        );
        continue;
      }

      const member = await this.addMember({
        activityId,
        entityId: entity.id,
        role: ActivityMemberRole.MEMBER,
      });

      if (member) {
        createdMembers.push(member);
        knownEntityIds.add(entity.id);
        this.logger.debug(
          `Resolved participant "${trimmedName}" → entity ${entity.id} (${entity.name})`,
        );
      }
    }

    this.logger.log(
      `Created ${createdMembers.length} member(s) for activity ${activityId}`,
    );

    return createdMembers;
  }

  /**
   * Добавить одного участника к Activity.
   * Проверяет unique constraint (activityId, entityId, role) и пропускает дубликаты.
   *
   * @returns Созданная запись или null если дубликат (unique constraint violation).
   */
  async addMember(params: AddMemberParams): Promise<ActivityMember | null> {
    const { activityId, entityId, role, notes } = params;

    try {
      const member = this.memberRepo.create({
        activityId,
        entityId,
        role,
        notes: notes ?? null,
        joinedAt: new Date(),
      });

      const saved = await this.memberRepo.save(member);

      this.logger.debug(
        `Added member: entity=${entityId}, role=${role}, activity=${activityId}`,
      );

      return saved;
    } catch (error: unknown) {
      // Unique constraint violation (activityId, entityId, role)
      // PostgreSQL error code 23505 = unique_violation
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code: string }).code === '23505'
      ) {
        this.logger.debug(
          `Member already exists: entity=${entityId}, role=${role}, activity=${activityId} — skipping duplicate`,
        );
        return null;
      }

      throw error;
    }
  }

  /**
   * Получить всех участников Activity с Entity details.
   */
  async getMembers(activityId: string): Promise<ActivityMember[]> {
    return this.memberRepo.find({
      where: { activityId, isActive: true },
      relations: ['entity'],
      order: { role: 'ASC', joinedAt: 'ASC' },
    });
  }

  /**
   * Получить все Activity где Entity является участником.
   */
  async getActivitiesForEntity(
    entityId: string,
    role?: ActivityMemberRole,
  ): Promise<ActivityMember[]> {
    const where: Record<string, unknown> = { entityId, isActive: true };
    if (role) {
      where.role = role;
    }

    return this.memberRepo.find({
      where,
      relations: ['activity'],
      order: { joinedAt: 'DESC' },
    });
  }

  /**
   * Деактивировать участника (soft remove — isActive = false, leftAt = now).
   */
  async deactivateMember(
    activityId: string,
    entityId: string,
  ): Promise<void> {
    const result = await this.memberRepo.update(
      { activityId, entityId, isActive: true },
      { isActive: false, leftAt: new Date() },
    );

    if (result.affected && result.affected > 0) {
      this.logger.log(
        `Deactivated member: entity=${entityId}, activity=${activityId}`,
      );
    } else {
      this.logger.warn(
        `No active member found to deactivate: entity=${entityId}, activity=${activityId}`,
      );
    }
  }

  /**
   * Поиск Entity по имени для resolution.
   * Case-insensitive ILIKE search по name.
   *
   * Возвращает первый найденный результат, отсортированный по дате обновления
   * (наиболее недавно обновлённый Entity имеет приоритет).
   */
  private async findEntityByName(
    name: string,
  ): Promise<EntityRecord | null> {
    return this.entityRepo
      .createQueryBuilder('e')
      .where('e.name ILIKE :pattern', { pattern: `%${name}%` })
      .orderBy('e.updatedAt', 'DESC')
      .getOne();
  }
}
