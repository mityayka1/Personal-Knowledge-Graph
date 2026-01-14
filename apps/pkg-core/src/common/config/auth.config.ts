import { registerAs } from '@nestjs/config';

export interface AuthConfig {
  jwtSecret: string;
  jwtAccessExpiration: string;
  jwtRefreshExpiration: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  maxLoginAttempts: number;
  lockoutDurationMinutes: number;
}

export default registerAs('auth', (): AuthConfig => {
  const accessExpiration = process.env.JWT_ACCESS_EXPIRATION || '15m';
  const refreshExpiration = process.env.JWT_REFRESH_EXPIRATION || '7d';

  return {
    jwtSecret: process.env.JWT_SECRET || 'development-secret-change-in-production',
    jwtAccessExpiration: accessExpiration,
    jwtRefreshExpiration: refreshExpiration,
    accessTokenTtlSeconds: parseExpiration(accessExpiration),
    refreshTokenTtlSeconds: parseExpiration(refreshExpiration),
    maxLoginAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS || '5', 10),
    lockoutDurationMinutes: parseInt(process.env.LOCKOUT_DURATION_MINUTES || '15', 10),
  };
});

function parseExpiration(exp: string): number {
  const match = exp.match(/^(\d+)([smhd])$/);
  if (!match) {
    return 900; // default 15 minutes
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's':
      return value;
    case 'm':
      return value * 60;
    case 'h':
      return value * 60 * 60;
    case 'd':
      return value * 60 * 60 * 24;
    default:
      return 900;
  }
}
