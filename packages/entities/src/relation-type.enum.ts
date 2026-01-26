/**
 * Типы связей между сущностями (Вариант 4 — пара с ролями).
 * Поддерживает N-арные связи: team (много участников), marriage (2 участника).
 */
export enum RelationType {
  // Работа
  EMPLOYMENT = 'employment', // roles: employee, employer
  REPORTING = 'reporting', // roles: subordinate, manager
  TEAM = 'team', // roles: member, lead

  // Семья
  MARRIAGE = 'marriage', // roles: spouse
  PARENTHOOD = 'parenthood', // roles: parent, child
  SIBLINGHOOD = 'siblinghood', // roles: sibling

  // Социальные
  FRIENDSHIP = 'friendship', // roles: friend
  ACQUAINTANCE = 'acquaintance', // roles: acquaintance
  MENTORSHIP = 'mentorship', // roles: mentor, mentee (учитель/ученик, тренер/подопечный)

  // Бизнес
  PARTNERSHIP = 'partnership', // roles: partner
  CLIENT_VENDOR = 'client_vendor', // roles: client, vendor
}

export enum RelationSource {
  MANUAL = 'manual',
  EXTRACTED = 'extracted',
  IMPORTED = 'imported',
  INFERRED = 'inferred', // Auto-inferred from existing facts (e.g., company fact → employment relation)
}

/**
 * Допустимые роли для каждого типа связи.
 */
export const RELATION_ROLES: Record<RelationType, string[]> = {
  [RelationType.EMPLOYMENT]: ['employee', 'employer'],
  [RelationType.REPORTING]: ['subordinate', 'manager'],
  [RelationType.TEAM]: ['member', 'lead'],
  [RelationType.MARRIAGE]: ['spouse'],
  [RelationType.PARENTHOOD]: ['parent', 'child'],
  [RelationType.SIBLINGHOOD]: ['sibling'],
  [RelationType.FRIENDSHIP]: ['friend'],
  [RelationType.ACQUAINTANCE]: ['acquaintance'],
  [RelationType.MENTORSHIP]: ['mentor', 'mentee'],
  [RelationType.PARTNERSHIP]: ['partner'],
  [RelationType.CLIENT_VENDOR]: ['client', 'vendor'],
};

/**
 * Ограничения на количество участников связи.
 */
export const RELATION_CARDINALITY: Record<
  RelationType,
  { min: number; max: number }
> = {
  [RelationType.EMPLOYMENT]: { min: 2, max: 2 },
  [RelationType.REPORTING]: { min: 2, max: 2 },
  [RelationType.TEAM]: { min: 2, max: 100 },
  [RelationType.MARRIAGE]: { min: 2, max: 2 },
  [RelationType.PARENTHOOD]: { min: 2, max: 2 },
  [RelationType.SIBLINGHOOD]: { min: 2, max: 20 },
  [RelationType.FRIENDSHIP]: { min: 2, max: 2 },
  [RelationType.ACQUAINTANCE]: { min: 2, max: 2 },
  [RelationType.MENTORSHIP]: { min: 2, max: 2 },
  [RelationType.PARTNERSHIP]: { min: 2, max: 10 },
  [RelationType.CLIENT_VENDOR]: { min: 2, max: 2 },
};

/**
 * Проверяет, допустима ли роль для данного типа связи.
 */
export function isValidRole(type: RelationType, role: string): boolean {
  return RELATION_ROLES[type]?.includes(role) ?? false;
}

/**
 * Проверяет, допустимо ли количество участников для данного типа связи.
 */
export function isValidCardinality(type: RelationType, count: number): boolean {
  const card = RELATION_CARDINALITY[type];
  if (!card) return false;
  return count >= card.min && count <= card.max;
}
