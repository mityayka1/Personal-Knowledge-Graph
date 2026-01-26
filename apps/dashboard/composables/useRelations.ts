import { useMutation, useQueryClient } from '@tanstack/vue-query';

/**
 * Relation types with roles.
 */
type EntityType = 'person' | 'organization';

/**
 * Relation type configuration.
 */
interface RelationTypeConfig {
  label: string;
  roles: readonly string[];
  roleLabels: Record<string, string>;
  description: string;
  /** Allowed entity types: [sourceTypes, targetTypes] or 'any' for both */
  allowedEntityTypes?: {
    source?: EntityType[];
    target?: EntityType[];
  };
}

export const RELATION_TYPES: Record<string, RelationTypeConfig> = {
  employment: {
    label: 'Работа',
    roles: ['employee', 'employer'],
    roleLabels: { employee: 'Сотрудник', employer: 'Работодатель' },
    description: 'Трудовые отношения',
    // employee=person, employer=organization
    allowedEntityTypes: { source: ['person'], target: ['organization'] },
  },
  reporting: {
    label: 'Отчётность',
    roles: ['subordinate', 'manager'],
    roleLabels: { subordinate: 'Подчинённый', manager: 'Руководитель' },
    description: 'Отношения подчинения',
    // person-to-person only
    allowedEntityTypes: { source: ['person'], target: ['person'] },
  },
  team: {
    label: 'Команда',
    roles: ['member', 'lead'],
    roleLabels: { member: 'Участник', lead: 'Лидер' },
    description: 'Участие в команде',
    // person as member, person or org as team
    allowedEntityTypes: { source: ['person'], target: ['person', 'organization'] },
  },
  marriage: {
    label: 'Брак',
    roles: ['spouse'],
    roleLabels: { spouse: 'Супруг(а)' },
    description: 'Семейные отношения',
    // person-to-person only
    allowedEntityTypes: { source: ['person'], target: ['person'] },
  },
  parenthood: {
    label: 'Родительство',
    roles: ['parent', 'child'],
    roleLabels: { parent: 'Родитель', child: 'Ребёнок' },
    description: 'Отношения родитель-ребёнок',
    // person-to-person only
    allowedEntityTypes: { source: ['person'], target: ['person'] },
  },
  siblinghood: {
    label: 'Родственники',
    roles: ['sibling'],
    roleLabels: { sibling: 'Брат/Сестра' },
    description: 'Братья и сёстры',
    // person-to-person only
    allowedEntityTypes: { source: ['person'], target: ['person'] },
  },
  friendship: {
    label: 'Дружба',
    roles: ['friend'],
    roleLabels: { friend: 'Друг' },
    description: 'Дружеские отношения',
    // person-to-person only
    allowedEntityTypes: { source: ['person'], target: ['person'] },
  },
  acquaintance: {
    label: 'Знакомство',
    roles: ['acquaintance'],
    roleLabels: { acquaintance: 'Знакомый' },
    description: 'Знакомые',
    // person-to-person only
    allowedEntityTypes: { source: ['person'], target: ['person'] },
  },
  mentorship: {
    label: 'Наставничество',
    roles: ['mentor', 'mentee'],
    roleLabels: { mentor: 'Наставник', mentee: 'Ученик' },
    description: 'Отношения наставник-ученик',
    // person-to-person only
    allowedEntityTypes: { source: ['person'], target: ['person'] },
  },
  partnership: {
    label: 'Партнёрство',
    roles: ['partner'],
    roleLabels: { partner: 'Партнёр' },
    description: 'Деловое партнёрство',
    // any entity type
  },
  client_vendor: {
    label: 'Клиент/Поставщик',
    roles: ['client', 'vendor'],
    roleLabels: { client: 'Клиент', vendor: 'Поставщик' },
    description: 'Бизнес-отношения',
    // any entity type
  },
} as const;

export type RelationTypeKey = keyof typeof RELATION_TYPES;

/**
 * Get role label for display.
 */
export function getRoleLabel(relationType: string, role: string): string {
  const typeInfo = RELATION_TYPES[relationType as RelationTypeKey];
  if (typeInfo) {
    return typeInfo.roleLabels[role as keyof typeof typeInfo.roleLabels] || role;
  }
  return role;
}

/**
 * Check if relation type has symmetric roles (both participants have same role).
 */
export function isSymmetricRelation(relationType: string): boolean {
  const typeInfo = RELATION_TYPES[relationType as RelationTypeKey];
  return typeInfo?.roles.length === 1;
}

/**
 * Get roles for a relation type.
 */
export function getRelationRoles(relationType: string): string[] {
  const typeInfo = RELATION_TYPES[relationType as RelationTypeKey];
  return typeInfo ? [...typeInfo.roles] : [];
}

/**
 * Check if relation type is compatible with given entity types (#6).
 * @param relationType - The relation type key
 * @param sourceEntityType - Type of the source entity (current entity)
 * @param targetEntityType - Type of the target entity (optional, for filtering)
 * @returns true if compatible
 */
export function isRelationTypeCompatible(
  relationType: string,
  sourceEntityType: 'person' | 'organization',
  targetEntityType?: 'person' | 'organization'
): boolean {
  const typeInfo = RELATION_TYPES[relationType as RelationTypeKey];
  if (!typeInfo) return false;

  const constraints = typeInfo.allowedEntityTypes;
  if (!constraints) return true; // No constraints = any type allowed

  // Check source entity type
  if (constraints.source && !constraints.source.includes(sourceEntityType)) {
    return false;
  }

  // Check target entity type if provided
  if (targetEntityType && constraints.target && !constraints.target.includes(targetEntityType)) {
    return false;
  }

  return true;
}

/**
 * Get allowed target entity types for a relation (#6).
 */
export function getAllowedTargetTypes(
  relationType: string
): ('person' | 'organization')[] | null {
  const typeInfo = RELATION_TYPES[relationType as RelationTypeKey];
  if (!typeInfo?.allowedEntityTypes?.target) return null; // Any type allowed
  return [...typeInfo.allowedEntityTypes.target];
}

/**
 * DTO for creating a relation.
 */
export interface CreateRelationDto {
  relationType: string;
  members: Array<{
    entityId: string;
    role: string;
    label?: string;
  }>;
  source?: 'manual' | 'extracted' | 'imported' | 'inferred';
  confidence?: number;
}

/**
 * Relation member from API.
 */
export interface RelationMember {
  entityId: string;
  role: string;
  label?: string;
  validUntil?: string | null;
  entity?: {
    id: string;
    name: string;
    type: 'person' | 'organization';
  };
}

/**
 * Relation from API.
 */
export interface Relation {
  id: string;
  relationType: string;
  source: string;
  confidence?: number;
  members: RelationMember[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Create a new relation.
 */
export function useCreateRelation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (dto: CreateRelationDto) => {
      return await $fetch<Relation>('/api/relations', {
        method: 'POST',
        body: dto,
      });
    },
    onSuccess: (_, variables) => {
      // Invalidate entity graph for all members
      for (const member of variables.members) {
        queryClient.invalidateQueries({ queryKey: ['entityGraph', member.entityId] });
        queryClient.invalidateQueries({ queryKey: ['entities', member.entityId] });
      }
    },
  });
}

/**
 * DTO for deleting a relation.
 */
export interface DeleteRelationParams {
  relationId: string;
  /** Entity IDs to invalidate immediately (e.g., current page entity) */
  affectedEntityIds?: string[];
}

/**
 * Delete a relation.
 * Pass affectedEntityIds for more targeted query invalidation (#2).
 */
export function useDeleteRelation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: DeleteRelationParams | string) => {
      const relationId = typeof params === 'string' ? params : params.relationId;
      return await $fetch<{ relationId: string; membersRemoved: number }>(`/api/relations/${relationId}`, {
        method: 'DELETE',
      });
    },
    onSuccess: (_, params) => {
      const affectedIds = typeof params === 'string' ? [] : (params.affectedEntityIds ?? []);

      if (affectedIds.length > 0) {
        // Targeted invalidation for known affected entities
        for (const entityId of affectedIds) {
          queryClient.invalidateQueries({ queryKey: ['entityGraph', entityId] });
          queryClient.invalidateQueries({ queryKey: ['entities', entityId] });
        }
      } else {
        // Fallback: invalidate all entity graphs (API doesn't return affected IDs)
        queryClient.invalidateQueries({ queryKey: ['entityGraph'] });
      }
    },
  });
}
