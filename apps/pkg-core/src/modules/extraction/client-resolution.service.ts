import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EntityRecord, EntityType } from '@pkg/entities';

/**
 * Resolution method used to identify the client entity.
 */
export type ClientResolutionMethod = 'explicit' | 'participant_org' | 'name_search';

/**
 * Result of client resolution.
 */
export interface ClientResolutionResult {
  /** Resolved entity ID */
  entityId: string;
  /** Resolved entity name */
  entityName: string;
  /** Method used to resolve */
  method: ClientResolutionMethod;
}

/**
 * Parameters for resolving a client entity.
 */
export interface ResolveClientParams {
  /** Explicit client name from extraction */
  clientName?: string;
  /** Names of project participants */
  participants?: string[];
  /** Owner entity ID (excluded from candidates) */
  ownerEntityId: string;
}

/**
 * Escape special ILIKE characters (% and _) to prevent pattern injection.
 */
function escapeIlike(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&');
}

/**
 * ClientResolutionService — determines the client entity for a project
 * using multiple resolution strategies in priority order.
 *
 * Resolution strategies (by priority):
 * 1. Explicit client name from extracted data
 * 2. Organization search among participants
 * 3. Entity name search via ILIKE (fallback)
 *
 * This service is read-only: it NEVER creates new entities.
 */
@Injectable()
export class ClientResolutionService {
  private readonly logger = new Logger(ClientResolutionService.name);

  constructor(
    @InjectRepository(EntityRecord)
    private readonly entityRepo: Repository<EntityRecord>,
  ) {}

  /**
   * Determine the client entity for a project from available context.
   *
   * @returns Resolved entity with method used, or null if unable to determine
   */
  async resolveClient(params: ResolveClientParams): Promise<ClientResolutionResult | null> {
    const { clientName, participants, ownerEntityId } = params;

    // Strategy 1: Explicit client name from extraction
    if (clientName) {
      this.logger.debug(`Trying explicit client name: "${clientName}"`);
      const entity = await this.findEntityByName(clientName);

      if (entity && entity.id !== ownerEntityId) {
        this.logger.log(`Resolved client via explicit name: "${entity.name}" (${entity.id})`);
        return {
          entityId: entity.id,
          entityName: entity.name,
          method: 'explicit',
        };
      }

      this.logger.debug(`Explicit client name "${clientName}" did not match any entity`);
    }

    // Strategy 2: Find organizations among participants
    if (participants && participants.length > 0) {
      this.logger.debug(
        `Searching for organizations among ${participants.length} participants`,
      );
      const organizations = await this.findOrganizationsAmong(participants, ownerEntityId);

      if (organizations.length > 0) {
        // Pick the first organization found (most relevant match)
        const org = organizations[0];
        this.logger.log(
          `Resolved client via participant organization: "${org.name}" (${org.id})`,
        );
        return {
          entityId: org.id,
          entityName: org.name,
          method: 'participant_org',
        };
      }

      this.logger.debug('No organizations found among participants');
    }

    // Strategy 3: Fallback — search by participant names (organizations only)
    // We restrict to organizations to avoid false positives with persons
    // who are merely participants, not clients.
    if (participants && participants.length > 0) {
      for (const name of participants) {
        const entity = await this.findEntityByName(name);
        if (entity && entity.id !== ownerEntityId && entity.type === EntityType.ORGANIZATION) {
          this.logger.log(
            `Resolved client via participant name search: "${entity.name}" (${entity.id})`,
          );
          return {
            entityId: entity.id,
            entityName: entity.name,
            method: 'name_search',
          };
        }
      }
    }

    this.logger.debug('Could not resolve client from available context');
    return null;
  }

  /**
   * Find entity by name using case-insensitive partial match.
   *
   * Search priority:
   * 1. Exact match (case-insensitive)
   * 2. Partial match (ILIKE %name%)
   *
   * Returns the best match or null.
   */
  async findEntityByName(name: string): Promise<EntityRecord | null> {
    if (!name || name.trim().length === 0) {
      return null;
    }

    const trimmedName = name.trim();

    // First try exact match (case-insensitive) for higher precision
    const exactMatch = await this.entityRepo
      .createQueryBuilder('e')
      .where('LOWER(e.name) = LOWER(:name)', { name: trimmedName })
      .orderBy('e.updatedAt', 'DESC')
      .getOne();

    if (exactMatch) {
      return exactMatch;
    }

    // Fallback to partial match
    return this.entityRepo
      .createQueryBuilder('e')
      .where('e.name ILIKE :pattern', { pattern: `%${escapeIlike(trimmedName)}%` })
      .orderBy('e.updatedAt', 'DESC')
      .getOne();
  }

  /**
   * Find all organization entities matching a list of names.
   *
   * For each participant name, performs an ILIKE search filtered
   * to entityType = 'organization'. Owner entity is excluded.
   *
   * @param names List of participant names to search
   * @param excludeEntityId Entity ID to exclude from results (typically owner)
   * @returns Array of matched organization entities (deduplicated)
   */
  async findOrganizationsAmong(
    names: string[],
    excludeEntityId?: string,
  ): Promise<EntityRecord[]> {
    if (!names || names.length === 0) {
      return [];
    }

    const foundOrgs = new Map<string, EntityRecord>();

    for (const name of names) {
      if (!name || name.trim().length === 0) {
        continue;
      }

      const trimmedName = name.trim();

      const qb = this.entityRepo
        .createQueryBuilder('e')
        .where('e.type = :orgType', { orgType: EntityType.ORGANIZATION })
        .andWhere(
          '(LOWER(e.name) = LOWER(:exactName) OR e.name ILIKE :pattern)',
          { exactName: trimmedName, pattern: `%${escapeIlike(trimmedName)}%` },
        );

      if (excludeEntityId) {
        qb.andWhere('e.id != :excludeId', { excludeId: excludeEntityId });
      }

      qb.orderBy('e.updatedAt', 'DESC');

      const org = await qb.getOne();

      if (org && !foundOrgs.has(org.id)) {
        foundOrgs.set(org.id, org);
        this.logger.debug(
          `Found organization "${org.name}" matching participant name "${name}"`,
        );
      }
    }

    return Array.from(foundOrgs.values());
  }
}
