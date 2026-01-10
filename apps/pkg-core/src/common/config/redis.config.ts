import { registerAs } from '@nestjs/config';
import { BullRootModuleOptions } from '@nestjs/bullmq';

export default registerAs('redis', (): BullRootModuleOptions => ({
  connection: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  prefix: process.env.REDIS_PREFIX || 'bull',
  defaultJobOptions: {
    removeOnComplete: 1000,
    removeOnFail: 5000,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
  },
}));
