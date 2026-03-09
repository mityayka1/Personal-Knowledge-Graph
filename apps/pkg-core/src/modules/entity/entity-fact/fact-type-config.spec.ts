import { FactType, FactCategory } from '@pkg/entities';
import { FACT_TYPE_CONFIG, getFactTypeConfig, isValidFactType, DEPRECATED_FACT_TYPES, VALID_FACT_TYPES } from './fact-type-config';

describe('FactTypeConfig', () => {
  it('should cover all FactType enum values except deprecated', () => {
    const deprecatedSet = new Set(DEPRECATED_FACT_TYPES as readonly string[]);
    for (const value of Object.values(FactType)) {
      if (deprecatedSet.has(value)) {
        expect(FACT_TYPE_CONFIG[value]).toBeUndefined();
      } else {
        expect(FACT_TYPE_CONFIG[value]).toBeDefined();
      }
    }
  });

  it('should NOT have role (merged into position)', () => {
    expect(FACT_TYPE_CONFIG['role']).toBeUndefined();
    expect(DEPRECATED_FACT_TYPES).toContain(FactType.ROLE);
  });

  it('should have exactly 17 active fact types', () => {
    const enumCount = Object.values(FactType).length;
    const deprecatedCount = DEPRECATED_FACT_TYPES.length;
    expect(VALID_FACT_TYPES.length).toBe(enumCount - deprecatedCount);
  });

  it('should return config for valid type', () => {
    const config = getFactTypeConfig('birthday');
    expect(config).toBeDefined();
    expect(config!.halfLifeDays).toBeNull(); // permanent
    expect(config!.category).toBe(FactCategory.PERSONAL);
    expect(config!.isUnique).toBe(true);
  });

  it('should return null for invalid type', () => {
    expect(getFactTypeConfig('nonexistent')).toBeNull();
  });

  it('should validate known fact types', () => {
    expect(isValidFactType('position')).toBe(true);
    expect(isValidFactType('role')).toBe(false);
    expect(isValidFactType('invalid')).toBe(false);
  });

  it('should use FactCategory from @pkg/entities', () => {
    const professionalTypes = Object.entries(FACT_TYPE_CONFIG)
      .filter(([_, c]) => c.category === FactCategory.PROFESSIONAL)
      .map(([k]) => k);
    expect(professionalTypes).toContain('position');
    expect(professionalTypes).toContain('company');
    expect(professionalTypes).toContain('skill');
    expect(professionalTypes).toContain('department');
    expect(professionalTypes).toContain('specialization');
    expect(professionalTypes).toContain('education');
  });

  it('should map categories consistent with FACT_CATEGORY_MAP', () => {
    // Spot-check key mappings match fact-validation.ts FACT_CATEGORY_MAP
    expect(FACT_TYPE_CONFIG['birthday'].category).toBe(FactCategory.PERSONAL);
    expect(FACT_TYPE_CONFIG['preference'].category).toBe(FactCategory.PREFERENCES);
    expect(FACT_TYPE_CONFIG['inn'].category).toBe(FactCategory.BUSINESS);
    expect(FACT_TYPE_CONFIG['communication'].category).toBe(FactCategory.PREFERENCES);
  });
});
