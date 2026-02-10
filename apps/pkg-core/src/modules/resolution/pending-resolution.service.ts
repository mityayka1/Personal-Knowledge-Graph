import { Injectable, NotFoundException, Inject, forwardRef, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { PendingEntityResolution, ResolutionStatus, Message, IdentifierType, EntityIdentifier, PendingResolutionMetadata } from '@pkg/entities';
import { AUTO_RESOLVE_CONFIDENCE_THRESHOLD } from '@pkg/shared';
import { EntityIdentifierService } from '../entity/entity-identifier/entity-identifier.service';

@Injectable()
export class PendingResolutionService {
  private readonly logger = new Logger(PendingResolutionService.name);

  constructor(
    @InjectRepository(PendingEntityResolution)
    private resolutionRepo: Repository<PendingEntityResolution>,
    @Inject(forwardRef(() => EntityIdentifierService))
    private identifierService: EntityIdentifierService,
    private dataSource: DataSource,
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
    messageTimestamp?: Date;
    metadata?: PendingResolutionMetadata;
  }) {
    let resolution = await this.resolutionRepo.findOne({
      where: {
        identifierType: data.identifierType,
        identifierValue: data.identifierValue,
      },
    });

    const messageTime = data.messageTimestamp || new Date();

    if (!resolution) {
      resolution = this.resolutionRepo.create({
        identifierType: data.identifierType,
        identifierValue: data.identifierValue,
        displayName: data.displayName,
        metadata: data.metadata || null,
        status: ResolutionStatus.PENDING,
        firstSeenAt: messageTime,
      });
      await this.resolutionRepo.save(resolution);
    } else {
      let needsSave = false;

      // Update metadata if we now have it but didn't before
      if (data.metadata && !resolution.metadata) {
        resolution.metadata = data.metadata;
        needsSave = true;
      }

      // Update firstSeenAt if this message is older
      if (messageTime < resolution.firstSeenAt) {
        resolution.firstSeenAt = messageTime;
        needsSave = true;
      }

      if (needsSave) {
        await this.resolutionRepo.save(resolution);
      }
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

    // Execute all operations in a transaction for atomicity
    return this.dataSource.transaction(async (manager) => {
      let identifierCreated = false;

      // 1. Create entity identifier to link the telegram_user_id to the entity
      const identifierRepo = manager.getRepository(EntityIdentifier);
      try {
        const identifier = identifierRepo.create({
          entityId,
          identifierType: resolution.identifierType as IdentifierType,
          identifierValue: resolution.identifierValue,
          metadata: resolution.metadata ?? null,
        });
        await identifierRepo.save(identifier);
        identifierCreated = true;
        this.logger.log(`Created identifier ${resolution.identifierType}:${resolution.identifierValue} for entity ${entityId}`);
      } catch (err) {
        // Identifier might already exist (unique constraint), log and continue
        this.logger.warn(`Could not create identifier: ${err instanceof Error ? err.message : err}`);
      }

      // 2. Update messages - link all messages from this identifier to the entity
      const messageRepo = manager.getRepository(Message);
      const updateResult = await messageRepo
        .createQueryBuilder()
        .update(Message)
        .set({ senderEntityId: entityId })
        .where('sender_entity_id IS NULL')
        .andWhere('sender_identifier_type = :type', { type: resolution.identifierType })
        .andWhere('sender_identifier_value = :value', { value: resolution.identifierValue })
        .execute();

      this.logger.log(`Updated ${updateResult.affected} messages for entity ${entityId}`);

      // 3. Update resolution status
      const resolutionRepo = manager.getRepository(PendingEntityResolution);
      resolution.status = ResolutionStatus.RESOLVED;
      resolution.resolvedEntityId = entityId;
      resolution.resolvedAt = new Date();
      await resolutionRepo.save(resolution);

      return {
        id,
        status: 'resolved',
        entity_id: entityId,
        resolved_at: resolution.resolvedAt,
        auto_resolved: autoResolved,
        messages_linked: updateResult.affected || 0,
        identifier_created: identifierCreated,
      };
    });
  }

  /**
   * Link a pending resolution directly to an entity without full resolve flow.
   * Used when extraction creates a real Entity alongside a PendingEntityResolution.
   */
  async linkToEntity(id: string, entityId: string): Promise<void> {
    const result = await this.resolutionRepo.update(id, {
      resolvedEntityId: entityId,
      status: ResolutionStatus.RESOLVED,
      resolvedAt: new Date(),
    });
    if (result.affected === 0) {
      this.logger.warn(`linkToEntity: pending resolution ${id} not found`);
    }
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

  async unresolve(id: string) {
    const resolution = await this.findOne(id);

    if (resolution.status !== ResolutionStatus.RESOLVED) {
      return {
        id,
        status: resolution.status,
        message: 'Resolution is not in resolved status',
      };
    }

    const entityId = resolution.resolvedEntityId;

    if (!entityId) {
      return {
        id,
        status: resolution.status,
        message: 'Resolution has no linked entity',
      };
    }

    // Execute all operations in a transaction for atomicity
    return this.dataSource.transaction(async (manager) => {
      // 1. Delete the entity identifier that was created
      const identifierRepo = manager.getRepository(EntityIdentifier);
      const deleteResult = await identifierRepo.delete({
        entityId,
        identifierType: resolution.identifierType,
        identifierValue: resolution.identifierValue,
      });
      this.logger.log(`Deleted ${deleteResult.affected} identifier(s) ${resolution.identifierType}:${resolution.identifierValue} from entity ${entityId}`);

      // 2. Clear senderEntityId from messages using sender identifier fields
      const messageRepo = manager.getRepository(Message);
      const updateResult = await messageRepo
        .createQueryBuilder()
        .update(Message)
        .set({ senderEntityId: null })
        .where('sender_entity_id = :entityId', { entityId })
        .andWhere('sender_identifier_type = :type', { type: resolution.identifierType })
        .andWhere('sender_identifier_value = :value', { value: resolution.identifierValue })
        .execute();

      this.logger.log(`Cleared senderEntityId from ${updateResult.affected} messages`);

      // 3. Reset resolution status
      const resolutionRepo = manager.getRepository(PendingEntityResolution);
      await resolutionRepo.update(id, {
        status: ResolutionStatus.PENDING,
        resolvedEntityId: null,
        resolvedAt: null,
      });

      return {
        id,
        status: 'pending',
        previousEntityId: entityId,
        messages_unlinked: updateResult.affected || 0,
        message: 'Resolution has been undone',
      };
    });
  }
}
