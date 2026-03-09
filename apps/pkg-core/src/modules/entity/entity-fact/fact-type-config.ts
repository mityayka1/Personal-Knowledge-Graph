export type FactCategory = 'professional' | 'personal' | 'preference' | 'contact' | 'business';
export type ExtractionPriority = 'high' | 'medium' | 'low';

export interface FactTypeConfigEntry {
  halfLifeDays: number | null;
  category: FactCategory;
  isUnique: boolean;
  extractionPriority: ExtractionPriority;
}

export const FACT_TYPE_CONFIG: Record<string, FactTypeConfigEntry> = {
  birthday:   { halfLifeDays: null,  category: 'personal',     isUnique: true,  extractionPriority: 'high' },
  location:   { halfLifeDays: 365,   category: 'personal',     isUnique: false, extractionPriority: 'medium' },
  position:   { halfLifeDays: 730,   category: 'professional', isUnique: true,  extractionPriority: 'high' },
  company:    { halfLifeDays: 730,   category: 'professional', isUnique: true,  extractionPriority: 'high' },
  skill:      { halfLifeDays: 1095,  category: 'professional', isUnique: false, extractionPriority: 'medium' },
  project:    { halfLifeDays: 180,   category: 'business',     isUnique: false, extractionPriority: 'medium' },
  status:     { halfLifeDays: 90,    category: 'business',     isUnique: false, extractionPriority: 'high' },
  preference: { halfLifeDays: 365,   category: 'preference',   isUnique: false, extractionPriority: 'low' },
  hobby:      { halfLifeDays: 730,   category: 'personal',     isUnique: false, extractionPriority: 'low' },
  phone:      { halfLifeDays: null,  category: 'contact',      isUnique: false, extractionPriority: 'high' },
  email:      { halfLifeDays: null,  category: 'contact',      isUnique: false, extractionPriority: 'high' },
  telegram:   { halfLifeDays: null,  category: 'contact',      isUnique: false, extractionPriority: 'high' },
  website:    { halfLifeDays: null,  category: 'contact',      isUnique: false, extractionPriority: 'low' },
  social:     { halfLifeDays: null,  category: 'contact',      isUnique: false, extractionPriority: 'low' },
  education:  { halfLifeDays: null,  category: 'personal',     isUnique: false, extractionPriority: 'medium' },
  family:     { halfLifeDays: null,  category: 'personal',     isUnique: false, extractionPriority: 'medium' },
};

export function getFactTypeConfig(factType: string): FactTypeConfigEntry | null {
  return FACT_TYPE_CONFIG[factType] ?? null;
}

export function isValidFactType(factType: string): boolean {
  return factType in FACT_TYPE_CONFIG;
}

export const VALID_FACT_TYPES = Object.keys(FACT_TYPE_CONFIG);
