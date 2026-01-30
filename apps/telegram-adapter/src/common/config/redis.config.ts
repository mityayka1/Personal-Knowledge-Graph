import { registerAs } from '@nestjs/config';

export default registerAs('redis', () => ({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  // TTL for daily context cache (24 hours in seconds)
  dailyContextTtl: parseInt(process.env.DAILY_CONTEXT_TTL || '86400', 10),
}));
