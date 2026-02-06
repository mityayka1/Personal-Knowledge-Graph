import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  ParseUUIDPipe,
  Logger,
} from '@nestjs/common';
import { ActivityService } from './activity.service';
import { ActivityValidationService } from './activity-validation.service';
import { ActivityMemberService } from './activity-member.service';
import { CreateActivityDto } from './dto/create-activity.dto';
import { UpdateActivityDto } from './dto/update-activity.dto';
import { ActivityQueryDto } from './dto/activity-query.dto';
import { AddMembersDto } from './dto/add-members.dto';
import { ActivityMemberRole } from '@pkg/entities';

/**
 * ActivityController — REST API для управления активностями (Activity CRUD).
 *
 * Endpoints:
 * - POST   /activities          — создать Activity
 * - GET    /activities          — список с фильтрами и пагинацией
 * - GET    /activities/:id      — детали с relations
 * - PATCH  /activities/:id      — обновить поля
 * - DELETE /activities/:id      — soft delete (status = ARCHIVED)
 * - GET    /activities/:id/tree — поддерево (children + descendants)
 * - POST   /activities/:id/members — добавить участников
 * - GET    /activities/:id/members — получить участников
 */
@Controller('activities')
export class ActivityController {
  private readonly logger = new Logger(ActivityController.name);

  constructor(
    private readonly activityService: ActivityService,
    private readonly validationService: ActivityValidationService,
    private readonly memberService: ActivityMemberService,
  ) {}

  /**
   * Создать новую Activity.
   *
   * Если передан parentId — валидирует иерархию типов.
   * Если передан participants — резолвит и создаёт ActivityMember записи.
   */
  @Post()
  async create(@Body() dto: CreateActivityDto) {
    this.logger.log(`Creating activity: ${dto.name} (${dto.activityType})`);

    // Валидация иерархии типов если указан parentId
    if (dto.parentId) {
      await this.validationService.validateCreate({
        activityType: dto.activityType,
        parentId: dto.parentId,
      });
    }

    const activity = await this.activityService.create(dto);

    this.logger.log(`Created activity: ${activity.id} (${activity.name})`);

    return activity;
  }

  /**
   * Список активностей с фильтрами и пагинацией.
   */
  @Get()
  async findAll(@Query() query: ActivityQueryDto) {
    this.logger.debug(`Listing activities with filters: ${JSON.stringify(query)}`);

    return this.activityService.findAll({
      type: query.activityType,
      status: query.status,
      context: query.context,
      parentId: query.parentId,
      ownerEntityId: query.ownerEntityId,
      clientEntityId: query.clientEntityId,
      search: query.search,
      limit: query.limit,
      offset: query.offset,
    });
  }

  /**
   * Детали активности по ID.
   * Возвращает activity с relations (parent, ownerEntity, clientEntity),
   * members и количеством children.
   */
  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.activityService.findOneWithDetails(id);
  }

  /**
   * Обновить поля активности.
   *
   * Если меняется parentId — валидирует иерархию и отсутствие циклов.
   */
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateActivityDto,
  ) {
    this.logger.log(`Updating activity: ${id}`);

    // Валидация иерархии если меняется parentId
    if (dto.parentId !== undefined) {
      const existing = await this.activityService.findOne(id);
      await this.validationService.validateUpdate({
        activityId: id,
        activityType: dto.activityType ?? existing.activityType,
        newParentId: dto.parentId,
      });
    }

    return this.activityService.update(id, dto);
  }

  /**
   * Soft delete — устанавливает status = ARCHIVED.
   * Данные сохраняются, активность скрывается из активных списков.
   */
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    this.logger.log(`Archiving activity: ${id}`);

    const archived = await this.activityService.archive(id);

    return {
      id: archived.id,
      status: archived.status,
      message: 'Activity archived successfully',
    };
  }

  /**
   * Получить поддерево активности (children + descendants).
   */
  @Get(':id/tree')
  async getTree(@Param('id', ParseUUIDPipe) id: string) {
    return this.activityService.getActivityTree(id);
  }

  /**
   * Добавить участников к активности.
   */
  @Post(':id/members')
  async addMembers(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddMembersDto,
  ) {
    this.logger.log(`Adding ${dto.members.length} member(s) to activity: ${id}`);

    // Проверяем что активность существует
    await this.activityService.findOne(id);

    const results = await Promise.all(
      dto.members.map((member) =>
        this.memberService.addMember({
          activityId: id,
          entityId: member.entityId,
          role: member.role ?? ActivityMemberRole.MEMBER,
          notes: member.notes,
        }),
      ),
    );

    // Фильтруем null (дубликаты) из результатов
    const created = results.filter((r) => r !== null);

    this.logger.log(
      `Added ${created.length} member(s) to activity ${id} (${dto.members.length - created.length} duplicates skipped)`,
    );

    return {
      added: created.length,
      skipped: dto.members.length - created.length,
      members: created,
    };
  }

  /**
   * Получить участников активности.
   */
  @Get(':id/members')
  async getMembers(@Param('id', ParseUUIDPipe) id: string) {
    // Проверяем что активность существует
    await this.activityService.findOne(id);

    return this.memberService.getMembers(id);
  }
}
