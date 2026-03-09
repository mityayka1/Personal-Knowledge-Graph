import { FactType, FactCategory } from '@pkg/entities';

export type ExtractionPriority = 'high' | 'medium' | 'low';

export interface FactTypeConfigEntry {
  halfLifeDays: number | null;
  category: FactCategory;
  isUnique: boolean;
  extractionPriority: ExtractionPriority;
}

/**
 * Metadata config per FactType. Covers ALL active FactType enum values
 * except deprecated 'role' (merged into 'position').
 *
 * halfLifeDays: null = permanent (no decay), number = half-life in days
 * category: maps to FactCategory enum from @pkg/entities
 * isUnique: if true, only one active fact of this type per entity is expected
 * extractionPriority: extraction importance for LLM prompts
 */
export const FACT_TYPE_CONFIG: Record<string, FactTypeConfigEntry> = {
  // PROFESSIONAL
  [FactType.POSITION]:       { halfLifeDays: 730,   category: FactCategory.PROFESSIONAL, isUnique: true,  extractionPriority: 'high' },
  [FactType.COMPANY]:        { halfLifeDays: 730,   category: FactCategory.PROFESSIONAL, isUnique: true,  extractionPriority: 'high' },
  [FactType.DEPARTMENT]:     { halfLifeDays: 730,   category: FactCategory.PROFESSIONAL, isUnique: false, extractionPriority: 'medium' },
  [FactType.SPECIALIZATION]: { halfLifeDays: 1095,  category: FactCategory.PROFESSIONAL, isUnique: false, extractionPriority: 'medium' },
  [FactType.SKILL]:          { halfLifeDays: 1095,  category: FactCategory.PROFESSIONAL, isUnique: false, extractionPriority: 'medium' },
  [FactType.EDUCATION]:      { halfLifeDays: null,  category: FactCategory.PROFESSIONAL, isUnique: false, extractionPriority: 'medium' },

  // PERSONAL
  [FactType.BIRTHDAY]:       { halfLifeDays: null,  category: FactCategory.PERSONAL,     isUnique: true,  extractionPriority: 'high' },
  [FactType.LOCATION]:       { halfLifeDays: 365,   category: FactCategory.PERSONAL,     isUnique: false, extractionPriority: 'medium' },
  [FactType.FAMILY]:         { halfLifeDays: null,  category: FactCategory.PERSONAL,     isUnique: false, extractionPriority: 'medium' },
  [FactType.HOBBY]:          { halfLifeDays: 730,   category: FactCategory.PERSONAL,     isUnique: false, extractionPriority: 'low' },
  [FactType.LANGUAGE]:       { halfLifeDays: null,  category: FactCategory.PERSONAL,     isUnique: false, extractionPriority: 'low' },
  [FactType.HEALTH]:         { halfLifeDays: 180,   category: FactCategory.PERSONAL,     isUnique: false, extractionPriority: 'medium' },
  [FactType.STATUS]:         { halfLifeDays: 90,    category: FactCategory.PERSONAL,     isUnique: false, extractionPriority: 'high' },

  // PREFERENCES
  [FactType.COMMUNICATION]:  { halfLifeDays: 365,   category: FactCategory.PREFERENCES,  isUnique: false, extractionPriority: 'low' },
  [FactType.PREFERENCE]:     { halfLifeDays: 365,   category: FactCategory.PREFERENCES,  isUnique: false, extractionPriority: 'low' },

  // BUSINESS
  [FactType.INN]:            { halfLifeDays: null,  category: FactCategory.BUSINESS,     isUnique: true,  extractionPriority: 'high' },
  [FactType.LEGAL_ADDRESS]:  { halfLifeDays: null,  category: FactCategory.BUSINESS,     isUnique: true,  extractionPriority: 'medium' },
};

/** Deprecated fact types excluded from config (data merged into alternatives) */
export const DEPRECATED_FACT_TYPES = [FactType.ROLE] as const;

export function getFactTypeConfig(factType: string): FactTypeConfigEntry | null {
  return FACT_TYPE_CONFIG[factType] ?? null;
}

export function isValidFactType(factType: string): boolean {
  return factType in FACT_TYPE_CONFIG;
}

export const VALID_FACT_TYPES = Object.keys(FACT_TYPE_CONFIG);
