import { getEffectiveConfidence, DEFAULT_HALF_LIFE_DAYS } from './confidence-decay';

describe('getEffectiveConfidence', () => {
  const halfLifeConfig: Record<string, number | null> = {
    birthday: null,       // Permanent — no decay
    position: 730,        // 2 years
    project: 180,         // 6 months
    status: 90,           // 3 months
    default: 365,         // 1 year
  };

  it('should not decay birthday facts (halfLife = null)', () => {
    const result = getEffectiveConfidence({
      baseConfidence: 0.9,
      factType: 'birthday',
      ageDays: 3650, // 10 years
      halfLifeConfig,
    });
    expect(result).toBe(0.9);
  });

  it('should decay by half at exactly half-life', () => {
    const result = getEffectiveConfidence({
      baseConfidence: 1.0,
      factType: 'position',
      ageDays: 730, // exactly half-life
      halfLifeConfig,
    });
    expect(result).toBeCloseTo(0.5, 2);
  });

  it('should decay to ~0.25 at 2x half-life', () => {
    const result = getEffectiveConfidence({
      baseConfidence: 1.0,
      factType: 'position',
      ageDays: 1460, // 2x half-life
      halfLifeConfig,
    });
    expect(result).toBeCloseTo(0.25, 2);
  });

  it('should use default half-life for unknown factType', () => {
    const result = getEffectiveConfidence({
      baseConfidence: 1.0,
      factType: 'hobby',
      ageDays: 365,
      halfLifeConfig,
    });
    expect(result).toBeCloseTo(0.5, 2);
  });

  it('should handle zero age (brand new fact)', () => {
    const result = getEffectiveConfidence({
      baseConfidence: 0.85,
      factType: 'status',
      ageDays: 0,
      halfLifeConfig,
    });
    expect(result).toBe(0.85);
  });

  it('should filter facts below minimum threshold 0.1', () => {
    const result = getEffectiveConfidence({
      baseConfidence: 0.5,
      factType: 'status', // halfLife=90
      ageDays: 900,       // 10x half-life → 0.5 * (1/1024) ≈ 0.0005
      halfLifeConfig,
    });
    expect(result).toBeLessThan(0.1);
  });
});
