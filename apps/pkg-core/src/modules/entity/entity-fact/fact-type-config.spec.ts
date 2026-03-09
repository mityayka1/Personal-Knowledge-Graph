import { FACT_TYPE_CONFIG, getFactTypeConfig, isValidFactType, FactCategory } from './fact-type-config';

describe('FactTypeConfig', () => {
  it('should have config for all known fact types', () => {
    const knownTypes = [
      'birthday', 'location', 'position', 'company', 'skill',
      'project', 'status', 'preference', 'hobby', 'phone',
      'email', 'telegram', 'website', 'social', 'education',
      'family',
    ];
    for (const type of knownTypes) {
      expect(FACT_TYPE_CONFIG[type]).toBeDefined();
    }
  });

  it('should NOT have role (merged into position)', () => {
    expect(FACT_TYPE_CONFIG['role']).toBeUndefined();
  });

  it('should return config for valid type', () => {
    const config = getFactTypeConfig('birthday');
    expect(config).toBeDefined();
    expect(config?.halfLifeDays).toBeNull(); // permanent
    expect(config?.category).toBe('personal');
    expect(config?.isUnique).toBe(true);
  });

  it('should return null for invalid type', () => {
    expect(getFactTypeConfig('nonexistent')).toBeNull();
  });

  it('should validate known fact types', () => {
    expect(isValidFactType('position')).toBe(true);
    expect(isValidFactType('role')).toBe(false);
    expect(isValidFactType('invalid')).toBe(false);
  });

  it('should categorize fact types correctly', () => {
    const professionalTypes = Object.entries(FACT_TYPE_CONFIG)
      .filter(([_, c]) => c.category === 'professional')
      .map(([k]) => k);
    expect(professionalTypes).toContain('position');
    expect(professionalTypes).toContain('company');
    expect(professionalTypes).toContain('skill');
  });
});
