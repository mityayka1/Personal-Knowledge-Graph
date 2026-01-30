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
  ParseIntPipe,
  DefaultValuePipe,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { EntityService } from './entity.service';
import { EntityFactService } from './entity-fact/entity-fact.service';
import { CreateEntityDto, CreateFactDto } from './dto/create-entity.dto';
import { UpdateEntityDto } from './dto/update-entity.dto';
import { EntityType } from '@pkg/entities';

@Controller('entities')
export class EntityController {
  constructor(
    private entityService: EntityService,
    private factService: EntityFactService,
  ) {}

  @Get()
  async findAll(
    @Query('type') type?: EntityType,
    @Query('search') search?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.entityService.findAll({ type, search, limit, offset });
  }

  /**
   * Get the owner entity ("me").
   * Returns 404 if no owner is set.
   */
  @Get('me')
  async findMe() {
    const owner = await this.entityService.findMe();
    if (!owner) {
      throw new NotFoundException('Owner entity not set. Use POST /entities/:id/set-owner to set one.');
    }
    return owner;
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.entityService.findOne(id);
  }

  @Post()
  async create(@Body() dto: CreateEntityDto) {
    return this.entityService.create(dto);
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEntityDto,
  ) {
    return this.entityService.update(id, dto);
  }

  /**
   * Soft delete an entity.
   * Data is preserved and can be restored with POST /entities/:id/restore
   */
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.entityService.remove(id);
  }

  /**
   * Restore a soft-deleted entity.
   */
  @Post(':id/restore')
  async restore(@Param('id', ParseUUIDPipe) id: string) {
    return this.entityService.restore(id);
  }

  /**
   * Get all soft-deleted entities.
   */
  @Get('deleted/list')
  async findDeleted(
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.entityService.findDeleted({ limit, offset });
  }

  /**
   * Permanently delete an entity (CANNOT BE UNDONE).
   * Requires confirm=true query parameter.
   */
  @Delete(':id/hard')
  async hardDelete(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('confirm') confirm?: string,
  ) {
    return this.entityService.hardDelete(id, confirm === 'true');
  }

  @Post(':id/merge/:targetId')
  async merge(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('targetId', ParseUUIDPipe) targetId: string,
  ) {
    return this.entityService.merge(id, targetId);
  }

  /**
   * Set entity as the system owner ("me").
   * Only one entity can be owner at a time.
   */
  @Post(':id/set-owner')
  async setOwner(@Param('id', ParseUUIDPipe) id: string) {
    return this.entityService.setOwner(id);
  }

  // Facts management

  /**
   * Get facts for an entity with rank-based ordering.
   * Returns preferred facts first, then normal.
   * Deprecated facts excluded by default.
   */
  @Get(':id/facts')
  async getFacts(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('includeDeprecated') includeDeprecated?: string,
    @Query('includeHistory') includeHistory?: string,
  ) {
    // Verify entity exists
    await this.entityService.findOne(id);
    return this.factService.findByEntityWithRanking(id, {
      includeDeprecated: includeDeprecated === 'true',
      includeHistory: includeHistory === 'true',
    });
  }

  @Post(':id/facts')
  async addFact(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateFactDto,
  ) {
    // Verify entity exists
    await this.entityService.findOne(id);
    return this.factService.create(id, dto);
  }

  @Delete(':id/facts/:factId')
  async removeFact(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('factId', ParseUUIDPipe) factId: string,
  ) {
    await this.entityService.findOne(id);
    const invalidated = await this.factService.invalidate(factId);
    return { invalidated, factId };
  }

  // Graph visualization

  /**
   * Get entity graph for visualization.
   * Returns nodes (entities) and edges (relations) centered around the given entity.
   *
   * @param id - Entity UUID
   * @param depth - Graph depth (1-3, currently only 1 is supported)
   */
  @Get(':id/graph')
  async getGraph(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('depth', new DefaultValuePipe(1), ParseIntPipe) depth: number,
  ) {
    // Validate depth range
    if (depth < 1 || depth > 3) {
      throw new BadRequestException('depth must be between 1 and 3');
    }
    return this.entityService.getGraph(id, depth);
  }
}
