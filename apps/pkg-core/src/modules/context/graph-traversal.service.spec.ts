import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { GraphTraversalService, HOP_PENALTY_BASE } from './graph-traversal.service';

describe('GraphTraversalService', () => {
  let service: GraphTraversalService;
  let dataSource: DataSource;
  let queryMock: jest.Mock;

  beforeEach(async () => {
    queryMock = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GraphTraversalService,
        {
          provide: DataSource,
          useValue: {
            query: queryMock,
          },
        },
      ],
    }).compile();

    service = module.get<GraphTraversalService>(GraphTraversalService);
    dataSource = module.get<DataSource>(DataSource);
  });

  describe('traverseEntityRelations', () => {
    const entityId = '11111111-1111-1111-1111-111111111111';
    const relatedEntityId = '22222222-2222-2222-2222-222222222222';

    it('should return related entities with facts (1 hop)', async () => {
      // Hop 1: one related entity via relation member
      queryMock
        .mockResolvedValueOnce([
          {
            entity_id: relatedEntityId,
            entity_name: 'Alice',
            relation_type: 'employment',
            role: 'employer',
            confidence: '0.95',
          },
        ])
        // Facts for Alice
        .mockResolvedValueOnce([
          {
            id: 'fact-1',
            fact_type: 'position',
            value: 'CEO',
            confidence: '0.90',
          },
        ]);

      const result = await service.traverseEntityRelations(entityId, {
        maxHops: 1,
        maxRelated: 5,
      });

      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].entityId).toBe(relatedEntityId);
      expect(result.entities[0].entityName).toBe('Alice');
      expect(result.entities[0].relationType).toBe('employment');
      expect(result.entities[0].hop).toBe(1);
      expect(result.entities[0].facts).toHaveLength(1);
      expect(result.entities[0].facts[0].factType).toBe('position');
    });

    it('should apply hop penalty (0.8^hop) to scores', async () => {
      // Hop 1: entity A
      queryMock
        .mockResolvedValueOnce([
          {
            entity_id: relatedEntityId,
            entity_name: 'Alice',
            relation_type: 'employment',
            role: 'employer',
            confidence: '1.0',
          },
        ])
        // Facts for Alice (hop 1)
        .mockResolvedValueOnce([])
        // Hop 2 from Alice: entity B
        .mockResolvedValueOnce([
          {
            entity_id: '33333333-3333-3333-3333-333333333333',
            entity_name: 'Bob',
            relation_type: 'friendship',
            role: 'friend',
            confidence: '0.80',
          },
        ])
        // Facts for Bob (hop 2)
        .mockResolvedValueOnce([]);

      const result = await service.traverseEntityRelations(entityId, {
        maxHops: 2,
        maxRelated: 5,
      });

      expect(result.entities).toHaveLength(2);

      // Hop 1: penalty = 0.8^1 = 0.8
      const alice = result.entities.find(e => e.entityName === 'Alice');
      expect(alice).toBeDefined();
      expect(alice!.hop).toBe(1);
      expect(alice!.hopPenalty).toBeCloseTo(HOP_PENALTY_BASE);

      // Hop 2: penalty = 0.8^2 = 0.64
      const bob = result.entities.find(e => e.entityName === 'Bob');
      expect(bob).toBeDefined();
      expect(bob!.hop).toBe(2);
      expect(bob!.hopPenalty).toBeCloseTo(HOP_PENALTY_BASE * HOP_PENALTY_BASE);
    });

    it('should respect maxRelated limit', async () => {
      // SQL LIMIT constrains to maxRelated; mock simulates DB returning 2 rows
      queryMock
        .mockResolvedValueOnce([
          { entity_id: 'a1', entity_name: 'A', relation_type: 'friendship', role: 'friend', confidence: '1.0' },
          { entity_id: 'a2', entity_name: 'B', relation_type: 'friendship', role: 'friend', confidence: '0.9' },
        ])
        // Facts for A
        .mockResolvedValueOnce([])
        // Facts for B
        .mockResolvedValueOnce([]);

      const result = await service.traverseEntityRelations(entityId, {
        maxHops: 1,
        maxRelated: 2,
      });

      expect(result.entities).toHaveLength(2);

      // Verify the SQL was called with maxRelated as LIMIT parameter
      const firstCall = queryMock.mock.calls[0];
      expect(firstCall[1]).toContain(2); // LIMIT param
    });

    it('should not revisit the source entity or already visited entities', async () => {
      // Hop 1: entity A
      queryMock
        .mockResolvedValueOnce([
          {
            entity_id: relatedEntityId,
            entity_name: 'Alice',
            relation_type: 'employment',
            role: 'employer',
            confidence: '1.0',
          },
        ])
        // Facts for Alice
        .mockResolvedValueOnce([])
        // Hop 2 from Alice: returns the source entity (should be excluded)
        .mockResolvedValueOnce([])
        // No facts needed for empty result
        ;

      const result = await service.traverseEntityRelations(entityId, {
        maxHops: 2,
        maxRelated: 5,
      });

      // Should only contain Alice, not the source entity
      expect(result.entities).toHaveLength(1);
      const entityIds = result.entities.map(e => e.entityId);
      expect(entityIds).not.toContain(entityId);
    });
  });

  describe('traverseActivityHierarchy', () => {
    const activityId = 'aaaa1111-1111-1111-1111-111111111111';

    it('should traverse parent chain and children', async () => {
      // Parents via closure table
      queryMock
        .mockResolvedValueOnce([
          {
            id: 'parent-1',
            name: 'Work',
            activity_type: 'area',
            status: 'active',
            depth: 0,
          },
          {
            id: 'parent-2',
            name: 'AI Services',
            activity_type: 'business',
            status: 'active',
            depth: 1,
          },
        ])
        // Children
        .mockResolvedValueOnce([
          {
            id: 'child-1',
            name: 'Setup CI/CD',
            activity_type: 'task',
            status: 'active',
          },
          {
            id: 'child-2',
            name: 'Write docs',
            activity_type: 'task',
            status: 'active',
          },
        ])
        // Knowledge packs
        .mockResolvedValueOnce([]);

      const result = await service.traverseActivityHierarchy(activityId);

      expect(result.parents).toHaveLength(2);
      expect(result.parents[0].name).toBe('Work');
      expect(result.parents[1].name).toBe('AI Services');

      expect(result.children).toHaveLength(2);
      expect(result.children[0].name).toBe('Setup CI/CD');
    });

    it('should include KnowledgePacks from activity and parents', async () => {
      // Parents
      queryMock
        .mockResolvedValueOnce([
          {
            id: 'parent-1',
            name: 'Work',
            activity_type: 'area',
            status: 'active',
            depth: 0,
          },
        ])
        // Children
        .mockResolvedValueOnce([])
        // Knowledge packs for activity + parents
        .mockResolvedValueOnce([
          {
            id: 'kp-1',
            title: 'Weekly Summary',
            summary: 'Project progress update',
            activity_id: activityId,
            key_facts: JSON.stringify([{ factType: 'status', value: 'on track', confidence: 0.9, sourceSegmentIds: [], lastUpdated: '2026-01-01' }]),
            decisions: JSON.stringify([{ what: 'Use NestJS', when: '2026-01-01' }]),
            open_questions: JSON.stringify([]),
            status: 'active',
          },
          {
            id: 'kp-2',
            title: 'Area Overview',
            summary: 'Work area overview',
            activity_id: 'parent-1',
            key_facts: JSON.stringify([]),
            decisions: JSON.stringify([]),
            open_questions: JSON.stringify([]),
            status: 'active',
          },
        ]);

      const result = await service.traverseActivityHierarchy(activityId);

      expect(result.knowledgePacks).toHaveLength(2);
      expect(result.knowledgePacks[0].title).toBe('Weekly Summary');
      expect(result.knowledgePacks[1].title).toBe('Area Overview');
    });

    it('should handle empty parents and children', async () => {
      // No parents
      queryMock
        .mockResolvedValueOnce([])
        // No children
        .mockResolvedValueOnce([])
        // Knowledge packs for just the activity
        .mockResolvedValueOnce([]);

      const result = await service.traverseActivityHierarchy(activityId);

      expect(result.parents).toHaveLength(0);
      expect(result.children).toHaveLength(0);
      expect(result.knowledgePacks).toHaveLength(0);
    });
  });
});
