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
import {
  FactConflictService,
  FactConflictResolution,
  FactConflictResolutionResult,
} from './fact-conflict.service';
import { EntityFactService } from '../entity/entity-fact/entity-fact.service';
import { EntityFact } from '@pkg/entities';

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
  async listConflicts(@Query('limit') limit?: string): Promise<EntityFact[]> {
    const parsedLimit = limit ? parseInt(limit, 10) : 50;

    this.logger.log(`Fetching facts with pending review (limit: ${parsedLimit})`);

    return this.entityFactService.findPendingReview({
      limit: parsedLimit,
    });
  }

  /**
   * Resolve conflict: use new fact
   */
  @Post(':shortId/new')
  async resolveNew(@Param('shortId') shortId: string): Promise<FactConflictResolutionResult> {
    return this.resolveConflict(shortId, 'new');
  }

  /**
   * Resolve conflict: keep old fact
   */
  @Post(':shortId/old')
  async resolveOld(@Param('shortId') shortId: string): Promise<FactConflictResolutionResult> {
    return this.resolveConflict(shortId, 'old');
  }

  /**
   * Resolve conflict: keep both facts
   */
  @Post(':shortId/both')
  async resolveBoth(@Param('shortId') shortId: string): Promise<FactConflictResolutionResult> {
    return this.resolveConflict(shortId, 'both');
  }

  /**
   * Generic conflict resolution handler
   */
  private async resolveConflict(
    shortId: string,
    resolution: FactConflictResolution,
  ): Promise<FactConflictResolutionResult> {
    if (!shortId) {
      throw new BadRequestException('shortId is required');
    }

    this.logger.log(`Resolving fact conflict ${shortId} with resolution: ${resolution}`);

    const result = await this.factConflictService.resolveConflict(shortId, resolution);

    if (!result.success && result.error === 'Данные не найдены или устарели') {
      throw new NotFoundException(result.error);
    }

    return result;
  }
}
