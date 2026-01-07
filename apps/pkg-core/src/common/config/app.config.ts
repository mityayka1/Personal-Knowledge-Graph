import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  apiPrefix: process.env.API_PREFIX || '/api/v1',
  apiKey: process.env.API_KEY,

  // OpenAI
  openaiApiKey: process.env.OPENAI_API_KEY,
  embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',

  // Worker (n8n)
  workerWebhookUrl: process.env.WORKER_WEBHOOK_URL || 'http://n8n:5678/webhook',

  // File storage
  fileStoragePath: process.env.FILE_STORAGE_PATH || '/data/files',

  // Session settings
  sessionGapHours: parseInt(process.env.SESSION_GAP_HOURS || '4', 10),

  // Context settings
  defaultContextMaxTokens: parseInt(process.env.DEFAULT_CONTEXT_MAX_TOKENS || '2000', 10),
  defaultContextRecentDays: parseInt(process.env.DEFAULT_CONTEXT_RECENT_DAYS || '30', 10),

  // Entity resolution
  autoResolveConfidenceThreshold: parseFloat(process.env.AUTO_RESOLVE_CONFIDENCE_THRESHOLD || '0.9'),
}));
