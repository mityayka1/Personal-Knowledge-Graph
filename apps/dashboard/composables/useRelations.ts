import { useMutation, useQueryClient } from '@tanstack/vue-query';

/**
 * Relation types with roles.
 */
export const RELATION_TYPES = {
  employment: {
    label: 'Работа',
    roles: ['employee', 'employer'],
    roleLabels: { employee: 'Сотрудник', employer: 'Работодатель' },
    description: 'Трудовые отношения',
  },
  reporting: {
    label: 'Отчётность',
    roles: ['subordinate', 'manager'],
    roleLabels: { subordinate: 'Подчинённый', manager: 'Руководитель' },
    description: 'Отношения подчинения',
  },
  team: {
    label: 'Команда',
    roles: ['member', 'lead'],
    roleLabels: { member: 'Участник', lead: 'Лидер' },
    description: 'Участие в команде',
  },
  marriage: {
    label: 'Брак',
    roles: ['spouse'],
    roleLabels: { spouse: 'Супруг(а)' },
    description: 'Семейные отношения',
  },
  parenthood: {
    label: 'Родительство',
    roles: ['parent', 'child'],
    roleLabels: { parent: 'Родитель', child: 'Ребёнок' },
    description: 'Отношения родитель-ребёнок',
  },
  siblinghood: {
    label: 'Родственники',
    roles: ['sibling'],
    roleLabels: { sibling: 'Брат/Сестра' },
    description: 'Братья и сёстры',
  },
  friendship: {
    label: 'Дружба',
    roles: ['friend'],
    roleLabels: { friend: 'Друг' },
    description: 'Дружеские отношения',
  },
  acquaintance: {
    label: 'Знакомство',
    roles: ['acquaintance'],
    roleLabels: { acquaintance: 'Знакомый' },
    description: 'Знакомые',
  },
  mentorship: {
    label: 'Наставничество',
    roles: ['mentor', 'mentee'],
    roleLabels: { mentor: 'Наставник', mentee: 'Ученик' },
    description: 'Отношения наставник-ученик',
  },
  partnership: {
    label: 'Партнёрство',
    roles: ['partner'],
    roleLabels: { partner: 'Партнёр' },
    description: 'Деловое партнёрство',
  },
  client_vendor: {
    label: 'Клиент/Поставщик',
    roles: ['client', 'vendor'],
    roleLabels: { client: 'Клиент', vendor: 'Поставщик' },
    description: 'Бизнес-отношения',
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
 * Delete a relation.
 */
export function useDeleteRelation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (relationId: string) => {
      return await $fetch<{ relationId: string; membersRemoved: number }>(`/api/relations/${relationId}`, {
        method: 'DELETE',
      });
    },
    onSuccess: () => {
      // Invalidate all entity graphs (we don't know which entities were affected)
      queryClient.invalidateQueries({ queryKey: ['entityGraph'] });
    },
  });
}
