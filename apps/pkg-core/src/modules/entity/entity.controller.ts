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

  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.entityService.remove(id);
  }

  @Post(':id/merge/:targetId')
  async merge(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('targetId', ParseUUIDPipe) targetId: string,
  ) {
    return this.entityService.merge(id, targetId);
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
   */
  @Get(':id/graph')
  async getGraph(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('depth') depth?: string,
  ) {
    const depthNum = depth ? parseInt(depth, 10) : 1;
    return this.entityService.getGraph(id, depthNum);
  }
}
