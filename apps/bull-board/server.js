const express = require('express');
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const { Queue } = require('bullmq');

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const PORT = parseInt(process.env.PORT || '3002', 10);

// Connect to Redis
const redisConnection = {
  host: REDIS_HOST,
  port: REDIS_PORT,
};

// Create queues to monitor
const embeddingQueue = new Queue('embedding', { connection: redisConnection });

// Setup Bull Board
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/');

createBullBoard({
  queues: [
    new BullMQAdapter(embeddingQueue),
  ],
  serverAdapter,
});

// Create Express app
const app = express();

app.use('/', serverAdapter.getRouter());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Bull Board running on http://localhost:${PORT}`);
  console.log(`Connected to Redis at ${REDIS_HOST}:${REDIS_PORT}`);
});
