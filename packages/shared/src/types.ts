// API Response types

export interface ApiResponse<T> {
  data: T;
  meta?: {
    total?: number;
    limit?: number;
    offset?: number;
  };
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// Pagination
export interface PaginationQuery {
  limit?: number;
  offset?: number;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

// Search types
export type SearchType = 'fts' | 'vector' | 'hybrid';

export interface SearchQuery {
  query: string;
  entityId?: string;
  period?: {
    from: string;
    to: string;
  };
  searchType?: SearchType;
  limit?: number;
}

export interface SearchResult {
  type: 'message' | 'segment' | 'summary';
  id: string;
  content: string;
  timestamp: string;
  entity?: {
    id: string;
    name: string;
  };
  interactionId: string;
  score: number;
  highlight?: string;
}

// Context types
export interface ContextRequest {
  entityId: string;
  taskHint?: string;
  maxTokens?: number;
  includeRecentDays?: number;
}

export interface ContextResponse {
  entityId: string;
  entityName: string;
  contextMarkdown: string;
  tokenCount: number;
  sources: {
    interactionsUsed: number;
    messagesAnalyzed: number;
    factsIncluded: number;
  };
  generatedAt: string;
}
