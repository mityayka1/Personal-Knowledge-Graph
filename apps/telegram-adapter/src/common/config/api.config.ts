import { registerAs } from '@nestjs/config';

export default registerAs('api', () => ({
  // PKG Core API URL
  pkgCoreUrl: process.env.PKG_CORE_URL || 'http://localhost:3000/api/v1',

  // Request timeout in ms
  timeout: parseInt(process.env.API_TIMEOUT || '30000', 10),

  // Retry settings
  retryAttempts: parseInt(process.env.API_RETRY_ATTEMPTS || '3', 10),
  retryDelay: parseInt(process.env.API_RETRY_DELAY || '1000', 10),
}));
