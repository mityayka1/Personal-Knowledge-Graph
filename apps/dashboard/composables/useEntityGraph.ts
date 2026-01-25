import { useQuery } from '@tanstack/vue-query';
import type { Ref } from 'vue';

/**
 * Graph node representing an entity.
 */
export interface GraphNode {
  id: string;
  name: string;
  type: 'person' | 'organization';
  profilePhoto?: string | null;
}

/**
 * Graph edge representing a relation between entities.
 */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relationType: string;
  sourceRole: string;
  targetRole: string;
}

/**
 * Entity graph data for visualization.
 */
export interface EntityGraph {
  centralEntityId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Relation types for display labels.
 */
export const RELATION_TYPE_LABELS: Record<string, string> = {
  employment: 'Работает',
  reporting: 'Отчётность',
  team: 'Команда',
  marriage: 'Брак',
  parenthood: 'Родитель',
  siblinghood: 'Родственники',
  friendship: 'Дружба',
  acquaintance: 'Знакомство',
  partnership: 'Партнёрство',
  client_vendor: 'Клиент/Поставщик',
};

/**
 * Get human-readable label for relation type.
 */
export function getRelationLabel(relationType: string): string {
  return RELATION_TYPE_LABELS[relationType] || relationType;
}

/**
 * Fetch entity graph for visualization.
 *
 * @param entityId - Central entity ID
 * @param depth - Graph traversal depth (default: 1)
 */
export function useEntityGraph(entityId: Ref<string>, depth: Ref<number> = ref(1)) {
  return useQuery({
    queryKey: ['entityGraph', entityId, depth],
    queryFn: async () => {
      return await $fetch<EntityGraph>(`/api/entities/${entityId.value}/graph`, {
        query: { depth: depth.value },
      });
    },
    enabled: () => !!entityId.value,
    staleTime: 30000, // Consider data fresh for 30 seconds
  });
}
