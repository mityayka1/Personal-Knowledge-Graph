#!/usr/bin/env node
/**
 * Protection against running telegram-adapter locally when session is used on production.
 *
 * Running the same Telegram session from multiple locations simultaneously
 * can result in session ban from Telegram.
 *
 * To allow local development:
 *   ALLOW_LOCAL_TELEGRAM=true pnpm start:dev
 */

const ALLOW_LOCAL = process.env.ALLOW_LOCAL_TELEGRAM === 'true';
const IS_DOCKER = process.env.IS_DOCKER === 'true' ||
                  require('fs').existsSync('/.dockerenv');

if (IS_DOCKER) {
  // Inside container - always allow
  process.exit(0);
}

if (!ALLOW_LOCAL) {
  console.error(`
╔═══════════════════════════════════════════════════════════════════════════╗
║  ⚠️  TELEGRAM SESSION PROTECTION                                          ║
╠═══════════════════════════════════════════════════════════════════════════╣
║                                                                           ║
║  Local development is BLOCKED to prevent session collision with PROD.     ║
║                                                                           ║
║  Running the same session from multiple locations can cause:              ║
║  - Message delivery issues                                                ║
║  - Session invalidation                                                   ║
║  - Temporary or permanent Telegram ban                                    ║
║                                                                           ║
╠═══════════════════════════════════════════════════════════════════════════╣
║  TO ALLOW LOCAL DEVELOPMENT (use separate session!):                      ║
║                                                                           ║
║    ALLOW_LOCAL_TELEGRAM=true pnpm start:dev                               ║
║                                                                           ║
║  RECOMMENDED: Use different TELEGRAM_SESSION_STRING for dev/prod          ║
╚═══════════════════════════════════════════════════════════════════════════╝
`);
  process.exit(1);
}

// Allowed - show warning and continue
console.log(`
⚠️  Local Telegram development enabled.
    Make sure PROD service is stopped or using different session!
`);
process.exit(0);
