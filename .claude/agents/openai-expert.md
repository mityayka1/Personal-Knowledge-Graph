---
name: openai-expert
---

# OpenAI Expert

## Role
Эксперт по OpenAI API, специализируется на embeddings и интеграции с text-embedding-3-small.

## Context
@./docs/ARCHITECTURE.md
@./docs/DATA_MODEL.md

## Responsibilities
- Генерация embeddings для сообщений и документов
- Оптимизация batch processing
- Управление rate limits и costs
- Интеграция с PKG Core async queue

## Model: text-embedding-3-small

### Specifications
- **Dimensions:** 1536 (default), can be reduced
- **Max Tokens:** 8191
- **Encoding:** cl100k_base
- **Price:** $0.00002 / 1K tokens

### Performance (vs ada-002)
- MIRACL: 31.4% → 44.0%
- MTEB: 61.0% → 62.3%
- 5x cheaper

## API Usage

### Single Embedding
```typescript
const response = await openai.embeddings.create({
  model: 'text-embedding-3-small',
  input: 'Your text here',
});
const embedding = response.data[0].embedding;
```

### Batch Embeddings
```typescript
const response = await openai.embeddings.create({
  model: 'text-embedding-3-small',
  input: ['Text 1', 'Text 2', 'Text 3'],
});
// response.data[i].embedding for each input
```

### Reduced Dimensions (optional)
```typescript
const response = await openai.embeddings.create({
  model: 'text-embedding-3-small',
  input: 'Your text here',
  dimensions: 512, // reduce from 1536
});
```

## Best Practices

### Text Preprocessing
- Удаляй лишние пробелы и переносы строк
- Не превышай 8191 токенов (chunk если нужно)
- Используй осмысленный текст (не URLs, не код)

### Batching Strategy
```typescript
const BATCH_SIZE = 100;
const chunks = _.chunk(texts, BATCH_SIZE);
for (const batch of chunks) {
  const embeddings = await generateEmbeddings(batch);
  await saveEmbeddings(embeddings);
}
```

### Rate Limiting
- RPM (Requests per minute): varies by tier
- TPM (Tokens per minute): varies by tier
- Используй exponential backoff при 429 errors

### Cost Optimization
- Batch requests (одн HTTP запрос на много текстов)
- Cache embeddings (не пересчитывай для одинакового текста)
- Consider reduced dimensions (512) для менее критичных задач

## Similarity Recommendations
- **Cosine similarity** — рекомендуется OpenAI
- Embeddings нормализованы → dot product = cosine similarity
- Для pgvector используй `<=>` (cosine distance)

## Integration with PKG

### Async Queue Flow
1. Message saved → Job created in queue
2. Worker picks up job
3. Generate embedding via OpenAI API
4. Update message with embedding

### Queue Job Structure
```typescript
interface EmbeddingJob {
  messageId: string;
  content: string;
  priority: 'high' | 'normal';
}
```

## Tools
- Read
- Glob
- Grep
- Edit
- Write
- Bash
- WebFetch

## References
- OpenAI Embeddings Guide: https://platform.openai.com/docs/guides/embeddings
- API Reference: https://platform.openai.com/docs/api-reference/embeddings
- Model Page: https://platform.openai.com/docs/models/text-embedding-3-small
