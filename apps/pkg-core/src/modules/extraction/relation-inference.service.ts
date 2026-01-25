import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, MoreThanOrEqual } from 'typeorm';
import {
  EntityFact,
  EntityRecord,
  EntityType,
  RelationType,
  RelationSource,
} from '@pkg/entities';
import { EntityRelationService } from '../entity/entity-relation/entity-relation.service';
import { EntityService } from '../entity/entity.service';

/**
 * Options for relation inference.
 */
export interface InferenceOptions {
  /** Only process facts created after this date */
  sinceDate?: Date;
  /** If true, don't create relations, just report what would be created */
  dryRun?: boolean;
  /** Maximum number of facts to process in one run */
  limit?: number;
}

/**
 * Result of relation inference run.
 */
export interface InferenceResult {
  /** Number of facts processed */
  processed: number;
  /** Number of relations created */
  created: number;
  /** Number of facts skipped (org not found, relation exists, etc.) */
  skipped: number;
  /** Errors encountered */
  errors: Array<{ factId: string; error: string }>;
  /** Details of created relations (for dry-run) */
  details?: Array<{
    factId: string;
    entityId: string;
    organizationId: string;
    organizationName: string;
    relationType: RelationType;
  }>;
}

/**
 * Service for inferring relations from existing facts.
 *
 * Analyzes entity_facts (e.g., company facts) and automatically creates
 * corresponding entity_relations (e.g., employment relations).
 *
 * Example:
 * - Fact: { entityId: "person-123", factType: "company", value: "Сбер" }
 * - Organization found: { id: "org-456", name: "Сбербанк", type: "organization" }
 * - Creates: employment relation between person-123 (employee) and org-456 (employer)
 */
@Injectable()
export class RelationInferenceService {
  private readonly logger = new Logger(RelationInferenceService.name);

  constructor(
    @InjectRepository(EntityFact)
    private readonly factRepo: Repository<EntityFact>,
    private readonly entityService: EntityService,
    private readonly entityRelationService: EntityRelationService,
  ) {}

  /**
   * Infer relations from existing facts.
   * Currently supports: company facts → employment relations.
   *
   * @param options - Inference options (sinceDate, dryRun, limit)
   * @returns Inference result with statistics
   */
  async inferRelations(options?: InferenceOptions): Promise<InferenceResult> {
    const result: InferenceResult = {
      processed: 0,
      created: 0,
      skipped: 0,
      errors: [],
      details: options?.dryRun ? [] : undefined,
    };

    // 1. Find company facts without corresponding employment relations
    const companyFacts = await this.findUnlinkedCompanyFacts(
      options?.sinceDate,
      options?.limit,
    );

    this.logger.log(
      `Found ${companyFacts.length} unlinked company facts to process`,
    );

    for (const fact of companyFacts) {
      try {
        result.processed++;

        // Skip facts without value
        if (!fact.value) {
          this.logger.debug(`Skipping fact ${fact.id} - no value`);
          result.skipped++;
          continue;
        }

        // 2. Try to find organization entity by company name
        const org = await this.findOrganizationByName(fact.value);

        if (!org) {
          this.logger.debug(
            `Organization not found for "${fact.value}" (fact ${fact.id})`,
          );
          result.skipped++;
          continue;
        }

        // 3. Check if relation already exists
        const existingRelation = await this.entityRelationService.findByPair(
          fact.entityId,
          org.id,
          RelationType.EMPLOYMENT,
        );

        if (existingRelation) {
          this.logger.debug(
            `Relation already exists for ${fact.entityId} ↔ ${org.id}`,
          );
          result.skipped++;
          continue;
        }

        // 4. Create employment relation (or just report in dry-run mode)
        if (options?.dryRun) {
          result.details?.push({
            factId: fact.id,
            entityId: fact.entityId,
            organizationId: org.id,
            organizationName: org.name,
            relationType: RelationType.EMPLOYMENT,
          });
          result.created++;
          this.logger.log(
            `[DRY-RUN] Would create employment: ${fact.entityId} → ${org.name}`,
          );
        } else {
          await this.entityRelationService.create({
            relationType: RelationType.EMPLOYMENT,
            members: [
              { entityId: fact.entityId, role: 'employee' },
              { entityId: org.id, role: 'employer' },
            ],
            source: RelationSource.INFERRED,
            confidence: fact.confidence ?? 0.7,
            metadata: {
              inferredFrom: 'company_fact',
              sourceFactId: fact.id,
              sourceFactValue: fact.value,
            },
          });
          result.created++;
          this.logger.log(
            `Created employment relation: ${fact.entityId} → ${org.name} (from fact ${fact.id})`,
          );
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        result.errors.push({ factId: fact.id, error: errorMessage });
        this.logger.error(
          `Error processing fact ${fact.id}: ${errorMessage}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    this.logger.log(
      `Inference complete: processed=${result.processed}, created=${result.created}, ` +
        `skipped=${result.skipped}, errors=${result.errors.length}` +
        (options?.dryRun ? ' [DRY-RUN]' : ''),
    );

    return result;
  }

  /**
   * Find company facts that don't have corresponding employment relations.
   *
   * Uses a NOT EXISTS subquery to exclude facts where:
   * - The entity already has an employment relation
   * - The relation is still active (validUntil IS NULL)
   */
  private async findUnlinkedCompanyFacts(
    sinceDate?: Date,
    limit?: number,
  ): Promise<EntityFact[]> {
    const qb = this.factRepo
      .createQueryBuilder('f')
      .where('f.type = :type', { type: 'company' })
      .andWhere('f.validUntil IS NULL') // Only current facts
      .andWhere(
        `NOT EXISTS (
        SELECT 1 FROM entity_relation_members m
        JOIN entity_relations r ON r.id = m.relation_id
        WHERE m.entity_id = f.entity_id
          AND r.relation_type = 'employment'
          AND m.valid_until IS NULL
      )`,
      )
      .orderBy('f.createdAt', 'DESC');

    if (sinceDate) {
      qb.andWhere('f.createdAt >= :since', { since: sinceDate });
    }

    if (limit) {
      qb.limit(limit);
    }

    return qb.getMany();
  }

  /**
   * Find organization by name with fuzzy matching.
   *
   * Strategy:
   * 1. Try exact match on normalized name
   * 2. Try fuzzy search on first word
   * 3. Return best match if similarity > 0.7
   */
  private async findOrganizationByName(
    name: string,
  ): Promise<EntityRecord | null> {
    // Normalize name
    const normalized = this.normalizeCompanyName(name);

    if (normalized.length < 2) {
      return null;
    }

    // Try search
    const result = await this.entityService.findAll({
      search: normalized,
      type: EntityType.ORGANIZATION,
      limit: 5,
    });

    if (result.items.length === 0) {
      // Try with first word only
      const firstWord = normalized.split(' ')[0];
      if (firstWord.length >= 3) {
        const fuzzyResult = await this.entityService.findAll({
          search: firstWord,
          type: EntityType.ORGANIZATION,
          limit: 5,
        });
        return this.findBestMatch(normalized, fuzzyResult.items);
      }
      return null;
    }

    return this.findBestMatch(normalized, result.items);
  }

  /**
   * Find best matching organization from candidates.
   * Returns the first one with similarity > 0.7, or null.
   */
  private findBestMatch(
    searchTerm: string,
    candidates: EntityRecord[],
  ): EntityRecord | null {
    for (const org of candidates) {
      const orgNormalized = this.normalizeCompanyName(org.name);
      const sim = this.similarity(searchTerm, orgNormalized);

      if (sim > 0.7) {
        this.logger.debug(
          `Matched "${searchTerm}" to "${org.name}" (similarity: ${sim.toFixed(2)})`,
        );
        return org;
      }
    }

    return null;
  }

  /**
   * Normalize company name for matching.
   * Removes legal forms, quotes, extra whitespace.
   */
  private normalizeCompanyName(name: string): string {
    return name
      .toLowerCase()
      .replace(/["""«»'']/g, '') // Remove quotes
      .replace(/\s*(ооо|оао|зао|пао|ао|ип|нко|гуп|муп|фгуп)\s*/gi, '') // Remove legal forms
      .replace(/\s*(llc|inc|corp|ltd|gmbh|ag)\s*/gi, '') // Remove English legal forms
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
  }

  /**
   * Calculate string similarity using Levenshtein distance.
   * Returns value between 0 (completely different) and 1 (identical).
   */
  private similarity(a: string, b: string): number {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    const dist = this.levenshteinDistance(a, b);
    return 1 - dist / maxLen;
  }

  /**
   * Calculate Levenshtein (edit) distance between two strings.
   */
  private levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = Array(b.length + 1)
      .fill(null)
      .map(() => Array(a.length + 1).fill(null));

    for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= b.length; j++) matrix[j][0] = j;

    for (let j = 1; j <= b.length; j++) {
      for (let i = 1; i <= a.length; i++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1, // deletion
          matrix[j - 1][i] + 1, // insertion
          matrix[j - 1][i - 1] + cost, // substitution
        );
      }
    }

    return matrix[b.length][a.length];
  }

  /**
   * Get statistics about potential inference candidates.
   * Useful for understanding the data before running inference.
   */
  async getInferenceStats(): Promise<{
    totalCompanyFacts: number;
    unlinkedCompanyFacts: number;
    organizationsInDb: number;
  }> {
    const totalCompanyFacts = await this.factRepo.count({
      where: { factType: 'company' as any, validUntil: IsNull() },
    });

    const unlinkedFacts = await this.findUnlinkedCompanyFacts();

    const orgsResult = await this.entityService.findAll({
      type: EntityType.ORGANIZATION,
      limit: 1,
    });

    return {
      totalCompanyFacts,
      unlinkedCompanyFacts: unlinkedFacts.length,
      organizationsInDb: orgsResult.total,
    };
  }
}
