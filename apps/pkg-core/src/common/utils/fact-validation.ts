import { FactType, FactCategory } from '@pkg/entities';

const FACT_TYPE_ALIASES: Record<string, FactType> = {
  occupation: FactType.POSITION,
  job: FactType.POSITION,
  job_title: FactType.POSITION,
  work_activity: FactType.SPECIALIZATION,
  research_area: FactType.SPECIALIZATION,
  professional: FactType.SPECIALIZATION,
  expertise: FactType.SPECIALIZATION,
  tool: FactType.SKILL,
  technology: FactType.SKILL,
  experience: FactType.EDUCATION,
  certification: FactType.EDUCATION,
  address: FactType.LOCATION,
  actual_address: FactType.LOCATION,
  city: FactType.LOCATION,
  health_condition: FactType.HEALTH,
  health_visit: FactType.HEALTH,
  accessibility_issue: FactType.HEALTH,
  tax_status: FactType.STATUS,
  work_status: FactType.STATUS,
  career_aspiration: FactType.PREFERENCE,
  professional_approach: FactType.PREFERENCE,
  work_setup: FactType.PREFERENCE,
  opinion: FactType.PREFERENCE,
  personal: FactType.PREFERENCE,
  timezone: FactType.PREFERENCE,
  nickname: FactType.PREFERENCE,
  communication_style: FactType.COMMUNICATION,
  communication_preference: FactType.COMMUNICATION,
};

const FACT_TYPE_VALUES = new Set(Object.values(FactType) as string[]);

export function normalizeFactType(raw: string): FactType | null {
  const normalized = raw.toLowerCase().replace(/[-\s]/g, '_');
  if (FACT_TYPE_VALUES.has(normalized)) return normalized as FactType;
  return FACT_TYPE_ALIASES[normalized] ?? null;
}

const FACT_CATEGORY_MAP: Record<FactType, FactCategory> = {
  [FactType.POSITION]: FactCategory.PROFESSIONAL,
  [FactType.COMPANY]: FactCategory.PROFESSIONAL,
  [FactType.DEPARTMENT]: FactCategory.PROFESSIONAL,
  [FactType.SPECIALIZATION]: FactCategory.PROFESSIONAL,
  [FactType.SKILL]: FactCategory.PROFESSIONAL,
  [FactType.EDUCATION]: FactCategory.PROFESSIONAL,
  [FactType.ROLE]: FactCategory.PROFESSIONAL,
  [FactType.BIRTHDAY]: FactCategory.PERSONAL,
  [FactType.LOCATION]: FactCategory.PERSONAL,
  [FactType.FAMILY]: FactCategory.PERSONAL,
  [FactType.HOBBY]: FactCategory.PERSONAL,
  [FactType.LANGUAGE]: FactCategory.PERSONAL,
  [FactType.HEALTH]: FactCategory.PERSONAL,
  [FactType.STATUS]: FactCategory.PERSONAL,
  [FactType.COMMUNICATION]: FactCategory.PREFERENCES,
  [FactType.PREFERENCE]: FactCategory.PREFERENCES,
  [FactType.INN]: FactCategory.BUSINESS,
  [FactType.LEGAL_ADDRESS]: FactCategory.BUSINESS,
};

export function getFactCategory(type: FactType): FactCategory {
  return FACT_CATEGORY_MAP[type];
}
