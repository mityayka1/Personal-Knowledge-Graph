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
import { CreateEntityDto } from './dto/create-entity.dto';
import { UpdateEntityDto } from './dto/update-entity.dto';
import { EntityType } from '@pkg/entities';

@Controller('entities')
export class EntityController {
  constructor(private entityService: EntityService) {}

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
}
