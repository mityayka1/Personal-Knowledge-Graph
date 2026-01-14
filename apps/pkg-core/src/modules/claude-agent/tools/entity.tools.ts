import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { toolSuccess, toolError, toolNotFound } from './tool.types';
import type { EntityService } from '../../entity/entity.service';
import { EntityType } from '@pkg/entities';

/**
 * Create entity-related tools (people and organizations)
 */
export function createEntityTools(entityService: EntityService) {
  return [
    tool(
      'list_entities',
      `Search and list people and organizations in the knowledge graph.
Use this to find entity IDs before calling other tools like get_entity_context or create_reminder.
Supports filtering by type (person/organization) and name search.`,
      {
        search: z.string().optional().describe('Search by name (partial match supported)'),
        type: z.enum(['person', 'organization']).optional().describe('Filter by entity type'),
        limit: z.number().int().min(1).max(100).default(20).describe('Maximum number of results'),
        offset: z.number().int().min(0).default(0).describe('Pagination offset'),
      },
      async (args) => {
        try {
          const result = await entityService.findAll({
            search: args.search,
            type: args.type as EntityType | undefined,
            limit: args.limit,
            offset: args.offset,
          });

          if (result.items.length === 0) {
            return toolNotFound('entities matching your criteria');
          }

          const entities = result.items.map(e => ({
            id: e.id,
            name: e.name,
            type: e.type,
            organization: e.organization?.name || null,
          }));

          return toolSuccess({
            total: result.total,
            showing: entities.length,
            hasMore: result.total > args.offset + entities.length,
            entities,
          });
        } catch (error) {
          return toolError(error instanceof Error ? error.message : String(error));
        }
      }
    ),

    tool(
      'get_entity_details',
      `Get detailed information about a specific person or organization.
Returns entity profile including facts, identifiers, and basic info.
For full context with recent interactions, use get_entity_context instead.`,
      {
        entityId: z.string().uuid().describe('ID of the entity to get details for'),
      },
      async (args) => {
        try {
          const entity = await entityService.findOne(args.entityId);

          return toolSuccess({
            id: entity.id,
            name: entity.name,
            type: entity.type,
            facts: (entity.facts || []).map(f => ({
              type: f.factType,
              value: f.value || null,
            })),
            identifiers: (entity.identifiers || []).map(i => ({
              type: i.identifierType,
              value: i.identifierValue,
            })),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('not found')) {
            return toolError('Entity not found. Use list_entities to search for the person/organization first.');
          }
          return toolError(message);
        }
      }
    ),
  ];
}
