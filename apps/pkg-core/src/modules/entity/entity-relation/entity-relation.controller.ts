import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  ParseUUIDPipe,
  ParseEnumPipe,
  NotFoundException,
} from '@nestjs/common';
import { EntityRelationService } from './entity-relation.service';
import { CreateRelationDto } from './dto/create-relation.dto';
import { RelationType } from '@pkg/entities';

@Controller('relations')
export class EntityRelationController {
  constructor(private readonly relationService: EntityRelationService) {}

  /**
   * Get relation by ID.
   */
  @Get(':id')
  async findById(@Param('id', ParseUUIDPipe) id: string) {
    const relation = await this.relationService.findById(id);
    if (!relation) {
      throw new NotFoundException(`Relation ${id} not found`);
    }
    return relation;
  }

  /**
   * Get all relations for an entity.
   * Returns relations with context (other members, current role).
   *
   * @param entityId - Entity UUID
   * @param type - Optional relation type filter (e.g., 'employment', 'friendship')
   */
  @Get()
  async findByEntity(
    @Query('entityId', ParseUUIDPipe) entityId: string,
    @Query('type', new ParseEnumPipe(RelationType, { optional: true }))
    type?: RelationType,
  ) {
    if (type) {
      return this.relationService.findByType(entityId, type);
    }
    return this.relationService.findByEntityWithContext(entityId);
  }

  /**
   * Create a new relation.
   */
  @Post()
  async create(@Body() dto: CreateRelationDto) {
    return this.relationService.create(dto);
  }

  /**
   * Delete a relation (soft delete all members).
   */
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    const relation = await this.relationService.findById(id);
    if (!relation) {
      throw new NotFoundException(`Relation ${id} not found`);
    }

    // Soft delete all members
    let removed = 0;
    for (const member of relation.members) {
      if (!member.validUntil) {
        const success = await this.relationService.removeMember(
          id,
          member.entityId,
          member.role,
        );
        if (success) removed++;
      }
    }

    return { relationId: id, membersRemoved: removed };
  }
}
