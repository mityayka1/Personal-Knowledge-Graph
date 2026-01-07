import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PendingEntityResolution, ResolutionStatus } from '@pkg/entities';
import { AUTO_RESOLVE_CONFIDENCE_THRESHOLD } from '@pkg/shared';

@Injectable()
export class PendingResolutionService {
  constructor(
    @InjectRepository(PendingEntityResolution)
    private resolutionRepo: Repository<PendingEntityResolution>,
  ) {}

  async findAll(status?: ResolutionStatus, limit = 50, offset = 0) {
    const where = status ? { status } : {};

    const [items, total] = await this.resolutionRepo.findAndCount({
      where,
      order: { firstSeenAt: 'DESC' },
      take: limit,
      skip: offset,
    });

    return { items, total };
  }

  async findOne(id: string) {
    const resolution = await this.resolutionRepo.findOne({
      where: { id },
      relations: ['resolvedEntity'],
    });

    if (!resolution) {
      throw new NotFoundException(`PendingResolution with id '${id}' not found`);
    }

    return resolution;
  }

  async findOrCreate(data: {
    identifierType: string;
    identifierValue: string;
    displayName?: string;
  }) {
    let resolution = await this.resolutionRepo.findOne({
      where: {
        identifierType: data.identifierType,
        identifierValue: data.identifierValue,
      },
    });

    if (!resolution) {
      resolution = this.resolutionRepo.create({
        identifierType: data.identifierType,
        identifierValue: data.identifierValue,
        displayName: data.displayName,
        status: ResolutionStatus.PENDING,
        firstSeenAt: new Date(),
      });
      await this.resolutionRepo.save(resolution);
    }

    return resolution;
  }

  async updateSuggestions(
    id: string,
    suggestions: Array<{
      entity_id: string;
      name: string;
      confidence: number;
      reason: string;
    }>,
  ) {
    const resolution = await this.findOne(id);

    resolution.suggestions = suggestions;
    await this.resolutionRepo.save(resolution);

    // Auto-resolve if high confidence
    const bestSuggestion = suggestions.sort((a, b) => b.confidence - a.confidence)[0];

    if (bestSuggestion && bestSuggestion.confidence >= AUTO_RESOLVE_CONFIDENCE_THRESHOLD) {
      return this.resolve(id, bestSuggestion.entity_id, true);
    }

    return {
      id,
      status: resolution.status,
      suggestions_count: suggestions.length,
      auto_resolved: false,
    };
  }

  async resolve(id: string, entityId: string, autoResolved = false) {
    const resolution = await this.findOne(id);

    resolution.status = ResolutionStatus.RESOLVED;
    resolution.resolvedEntityId = entityId;
    resolution.resolvedAt = new Date();

    await this.resolutionRepo.save(resolution);

    return {
      id,
      status: 'resolved',
      entity_id: entityId,
      resolved_at: resolution.resolvedAt,
      auto_resolved: autoResolved,
    };
  }

  async ignore(id: string) {
    const resolution = await this.findOne(id);

    resolution.status = ResolutionStatus.IGNORED;
    resolution.resolvedAt = new Date();

    await this.resolutionRepo.save(resolution);

    return {
      id,
      status: 'ignored',
    };
  }
}
