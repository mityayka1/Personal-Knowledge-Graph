/**
 * Job data for enrichment queue
 */
export interface EnrichmentJobData {
  eventId: string;
}

/**
 * Job result for enrichment queue
 */
export interface EnrichmentJobResult {
  success: boolean;
  eventId: string;
  linkedEventId?: string;
  needsContext: boolean;
  error?: string;
}
