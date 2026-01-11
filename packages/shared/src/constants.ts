// Session gap threshold defaults (used as fallback when DB setting unavailable)
export const DEFAULT_SESSION_GAP_MINUTES = 240; // 4 hours
export const SESSION_GAP_THRESHOLD_MS = DEFAULT_SESSION_GAP_MINUTES * 60 * 1000;

// Embedding dimensions (OpenAI text-embedding-3-small)
export const EMBEDDING_DIMENSIONS = 1536;

// API paths
export const API_PREFIX = '/api/v1';

// Default pagination
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

// Context synthesis
export const DEFAULT_CONTEXT_MAX_TOKENS = 2000;
export const DEFAULT_CONTEXT_RECENT_DAYS = 30;

// Entity resolution
export const AUTO_RESOLVE_CONFIDENCE_THRESHOLD = 0.9;

// Tiered retrieval
export const RECENT_DAYS_THRESHOLD = 7;
export const ARCHIVE_DAYS_THRESHOLD = 30;
