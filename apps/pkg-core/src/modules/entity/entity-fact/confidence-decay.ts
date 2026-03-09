export const DEFAULT_HALF_LIFE_DAYS: Record<string, number | null> = {
  birthday: null,
  location: 365,
  position: 730,
  company: 730,
  skill: 1095,
  project: 180,
  status: 90,
  preference: 365,
  hobby: 730,
  default: 365,
};

export interface DecayParams {
  baseConfidence: number;
  factType: string;
  ageDays: number;
  halfLifeConfig: Record<string, number | null>;
}

/**
 * Calculate effective confidence with exponential decay.
 * Formula: effective = base * e^(-ln(2) / halfLife * ageDays)
 *
 * Applied ONLY at retrieval time — DB values remain unchanged.
 */
export function getEffectiveConfidence(params: DecayParams): number {
  const { baseConfidence, factType, ageDays, halfLifeConfig } = params;

  const halfLife = factType in halfLifeConfig
    ? halfLifeConfig[factType]
    : (halfLifeConfig['default'] ?? 365);

  // null halfLife = permanent (no decay)
  if (halfLife === null) return baseConfidence;

  // invalid halfLife = treat as permanent
  if (halfLife <= 0) return baseConfidence;

  if (ageDays <= 0) return baseConfidence;

  const decayFactor = Math.exp((-Math.LN2 / halfLife) * ageDays);
  return baseConfidence * decayFactor;
}

/** Minimum effective confidence threshold — facts below this are excluded */
export const MIN_EFFECTIVE_CONFIDENCE = 0.1;
