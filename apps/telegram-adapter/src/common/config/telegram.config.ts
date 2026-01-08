import { registerAs } from '@nestjs/config';

export default registerAs('telegram', () => ({
  apiId: parseInt(process.env.TELEGRAM_API_ID || '0', 10),
  apiHash: process.env.TELEGRAM_API_HASH || '',
  sessionString: process.env.TELEGRAM_SESSION_STRING || '',

  // Connection settings
  connectionRetries: parseInt(process.env.TELEGRAM_CONNECTION_RETRIES || '5', 10),

  // Session gap threshold in hours (default 4 hours)
  sessionGapThreshold: parseInt(process.env.SESSION_GAP_THRESHOLD || '4', 10),

  // Phone number for authentication (if session string is not provided)
  phoneNumber: process.env.TELEGRAM_PHONE_NUMBER || '',
}));
