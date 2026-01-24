import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { IsInt, IsOptional, IsString, Min, Max, MinLength } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import {
  FactConflictService,
  FactConflictResolution,
  FactConflictResolutionResult,
} from './fact-conflict.service';
import { EntityFactService } from '../entity/entity-fact/entity-fact.service';
import { EntityFact } from '@pkg/entities';

/**
 * Query DTO for listing conflicts
 */
class ListConflictsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;
}

/**
 * Param DTO for conflict resolution
 */
class ResolveConflictParamsDto {
  @IsString()
  @MinLength(1)
  @Transform(({ value }) => value?.trim())
  shortId: string;
}

/**
 * Controller for fact conflict resolution and management.
 *
 * Endpoints:
 * - GET  /fact-conflicts               → List facts needing review
 * - POST /fact-conflicts/:shortId/new  → Use new fact, deprecate old
 * - POST /fact-conflicts/:shortId/old  → Keep old fact, reject new
 * - POST /fact-conflicts/:shortId/both → Keep both facts (COEXIST)
 */
@Controller('fact-conflicts')
export class FactConflictController {
  private readonly logger = new Logger(FactConflictController.name);

  constructor(
    private readonly factConflictService: FactConflictService,
    private readonly entityFactService: EntityFactService,
  ) {}

  /**
   * List facts that need human review (conflicts).
   * Returns facts with needsReview=true, ordered by creation date.
   */
  @Get()
  async listConflicts(@Query() query: ListConflictsQueryDto): Promise<EntityFact[]> {
    const limit = query.limit ?? 50;

    this.logger.log(`Fetching facts with pending review (limit: ${limit})`);

    return this.entityFactService.findPendingReview({
      limit,
    });
  }

  /**
   * Resolve conflict: use new fact
   */
  @Post(':shortId/new')
  async resolveNew(
    @Param() params: ResolveConflictParamsDto,
  ): Promise<FactConflictResolutionResult> {
    return this.resolveConflict(params.shortId, 'new');
  }

  /**
   * Resolve conflict: keep old fact
   */
  @Post(':shortId/old')
  async resolveOld(
    @Param() params: ResolveConflictParamsDto,
  ): Promise<FactConflictResolutionResult> {
    return this.resolveConflict(params.shortId, 'old');
  }

  /**
   * Resolve conflict: keep both facts
   */
  @Post(':shortId/both')
  async resolveBoth(
    @Param() params: ResolveConflictParamsDto,
  ): Promise<FactConflictResolutionResult> {
    return this.resolveConflict(params.shortId, 'both');
  }

  /**
   * Generic conflict resolution handler
   */
  private async resolveConflict(
    shortId: string,
    resolution: FactConflictResolution,
  ): Promise<FactConflictResolutionResult> {
    // Validation is now handled by DTO
    this.logger.log(`Resolving fact conflict ${shortId} with resolution: ${resolution}`);

    const result = await this.factConflictService.resolveConflict(shortId, resolution);

    if (!result.success && result.error === 'Данные не найдены или устарели') {
      throw new NotFoundException(result.error);
    }

    return result;
  }
}
