import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

// ─── Constants ───────────────────────────────────────────────
export const HOP_PENALTY_BASE = 0.8;

// ─── Interfaces ──────────────────────────────────────────────

export interface TraversalOptions {
  /** Max hops from the source entity (default: 2) */
  maxHops: number;
  /** Max related entities to return per hop (default: 5) */
  maxRelated: number;
}

export interface RelatedEntityFact {
  id: string;
  factType: string;
  value: string | null;
  confidence: number | null;
}

export interface RelatedEntityResult {
  entityId: string;
  entityName: string;
  relationType: string;
  role: string;
  hop: number;
  hopPenalty: number;
  facts: RelatedEntityFact[];
}

export interface EntityTraversalResult {
  entities: RelatedEntityResult[];
}

export interface ActivityParent {
  id: string;
  name: string;
  activityType: string;
  status: string;
  depth: number;
}

export interface ActivityChild {
  id: string;
  name: string;
  activityType: string;
  status: string;
}

export interface KnowledgePackSummary {
  id: string;
  title: string;
  summary: string;
  activityId: string;
  keyFacts: Array<{
    factType: string;
    value: string;
    confidence: number;
    sourceSegmentIds: string[];
    lastUpdated: string;
  }>;
  decisions: Array<{
    what: string;
    when: string;
    context?: string;
  }>;
  openQuestions: Array<{
    question: string;
    raisedAt: string;
    context?: string;
  }>;
}

export interface ActivityHierarchyResult {
  parents: ActivityParent[];
  children: ActivityChild[];
  knowledgePacks: KnowledgePackSummary[];
}

// ─── Service ─────────────────────────────────────────────────

@Injectable()
export class GraphTraversalService {
  private readonly logger = new Logger(GraphTraversalService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * BFS traversal through entity relations up to maxHops.
   * Each hop applies a penalty of HOP_PENALTY_BASE^hop to scores.
   */
  async traverseEntityRelations(
    entityId: string,
    options: TraversalOptions,
  ): Promise<EntityTraversalResult> {
    const { maxHops, maxRelated } = options;
    const visited = new Set<string>([entityId]);
    const allResults: RelatedEntityResult[] = [];

    // BFS: queue of (currentEntityId, currentHop)
    let frontier: string[] = [entityId];

    for (let hop = 1; hop <= maxHops; hop++) {
      if (frontier.length === 0) break;

      const nextFrontier: string[] = [];
      const hopPenalty = Math.pow(HOP_PENALTY_BASE, hop);

      for (const currentEntityId of frontier) {
        // Query related entities via entity_relation_members
        const relatedEntities = await this.dataSource.query(
          `SELECT DISTINCT
             e.id AS entity_id,
             e.name AS entity_name,
             er.relation_type,
             erm2.role,
             er.confidence
           FROM entity_relation_members erm1
           JOIN entity_relations er ON er.id = erm1.relation_id
           JOIN entity_relation_members erm2 ON erm2.relation_id = er.id AND erm2.entity_id != $1
           JOIN entities e ON e.id = erm2.entity_id AND e.deleted_at IS NULL
           WHERE erm1.entity_id = $1
             AND erm1.valid_until IS NULL
             AND erm2.valid_until IS NULL
           ORDER BY er.confidence DESC NULLS LAST
           LIMIT $2`,
          [currentEntityId, maxRelated],
        );

        for (const row of relatedEntities) {
          if (visited.has(row.entity_id)) continue;
          visited.add(row.entity_id);

          // Fetch current facts for this entity
          const facts = await this.dataSource.query(
            `SELECT id, fact_type, value, confidence
             FROM entity_facts
             WHERE entity_id = $1
               AND valid_until IS NULL
               AND deleted_at IS NULL
               AND status = 'active'
             ORDER BY created_at DESC
             LIMIT 10`,
            [row.entity_id],
          );

          allResults.push({
            entityId: row.entity_id,
            entityName: row.entity_name,
            relationType: row.relation_type,
            role: row.role,
            hop,
            hopPenalty,
            facts: facts.map((f: Record<string, unknown>) => ({
              id: f.id as string,
              factType: f.fact_type as string,
              value: f.value as string | null,
              confidence: f.confidence != null ? parseFloat(String(f.confidence)) : null,
            })),
          });

          nextFrontier.push(row.entity_id);
        }
      }

      frontier = nextFrontier;
    }

    return { entities: allResults };
  }

  /**
   * Traverse the activity hierarchy via the closure table.
   * Returns parent chain, direct children, and associated KnowledgePacks.
   */
  async traverseActivityHierarchy(
    activityId: string,
  ): Promise<ActivityHierarchyResult> {
    // 1. Parent chain via activities_closure (raw SQL returns snake_case)
    const rawParents = await this.dataSource.query(
      `SELECT a.id, a.name, a.activity_type, a.status, a.depth
       FROM activities_closure ac
       JOIN activities a ON a.id = ac.id_ancestor
       WHERE ac.id_descendant = $1
         AND ac.id_ancestor != $1
         AND a.deleted_at IS NULL
       ORDER BY a.depth ASC`,
      [activityId],
    );

    // 2. Direct children (raw SQL returns snake_case)
    const rawChildren = await this.dataSource.query(
      `SELECT id, name, activity_type, status
       FROM activities
       WHERE parent_id = $1
         AND status = 'active'
         AND deleted_at IS NULL
       ORDER BY name ASC`,
      [activityId],
    );

    // 3. KnowledgePacks for activity + all ancestors
    const activityIds = [activityId, ...rawParents.map((p: Record<string, unknown>) => p.id as string)];
    let knowledgePacks: KnowledgePackSummary[] = [];

    if (activityIds.length > 0) {
      const rawPacks = await this.dataSource.query(
        `SELECT id, title, summary, activity_id, key_facts, decisions, open_questions, status
         FROM knowledge_packs
         WHERE activity_id = ANY($1)
           AND status = 'active'
         ORDER BY created_at DESC
         LIMIT 20`,
        [activityIds],
      );

      knowledgePacks = rawPacks.map((kp: Record<string, unknown>) => ({
        id: kp.id as string,
        title: kp.title as string,
        summary: kp.summary as string,
        activityId: kp.activity_id as string,
        keyFacts: this.parseJsonb(kp.key_facts),
        decisions: this.parseJsonb(kp.decisions),
        openQuestions: this.parseJsonb(kp.open_questions),
      }));
    }

    return {
      parents: rawParents.map((p: Record<string, unknown>) => ({
        id: p.id as string,
        name: p.name as string,
        activityType: (p.activity_type ?? p.activityType) as string,
        status: p.status as string,
        depth: p.depth as number,
      })),
      children: rawChildren.map((c: Record<string, unknown>) => ({
        id: c.id as string,
        name: c.name as string,
        activityType: (c.activity_type ?? c.activityType) as string,
        status: c.status as string,
      })),
      knowledgePacks,
    };
  }

  /**
   * Safely parse JSONB column value (may already be parsed or may be a string).
   */
  private parseJsonb(value: unknown): any[] {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return [];
      }
    }
    return [];
  }
}
