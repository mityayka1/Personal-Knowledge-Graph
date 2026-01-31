import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Request } from 'express';

/**
 * Telegram user data from initData
 */
export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
}

/**
 * Parsed and validated initData from Telegram Mini App
 */
export interface TelegramInitData {
  query_id?: string;
  user?: TelegramUser;
  auth_date: number;
  hash: string;
  start_param?: string;
}

/**
 * Extended Express Request with Telegram data
 */
export interface TelegramAuthRequest extends Request {
  telegramInitData: TelegramInitData;
  telegramUser?: TelegramUser;
}

/**
 * Guard for validating Telegram Mini App initData.
 *
 * Validates the HMAC-SHA256 signature using the bot token as described in:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Usage:
 * ```typescript
 * @UseGuards(TelegramAuthGuard)
 * @Controller('mini-app')
 * export class MiniAppController {
 *   @Get('me')
 *   getMe(@Req() req: TelegramAuthRequest) {
 *     return req.telegramUser;
 *   }
 * }
 * ```
 *
 * Client should send Authorization header in format:
 * `Authorization: tma <initData>`
 *
 * Where initData is the raw string from Telegram.WebApp.initData
 */
@Injectable()
export class TelegramAuthGuard implements CanActivate {
  private readonly logger = new Logger(TelegramAuthGuard.name);
  private readonly botToken: string;
  private readonly maxAgeSeconds: number;
  private readonly allowedUserIds: Set<number>;

  constructor(private readonly configService: ConfigService) {
    this.botToken = this.configService.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
    this.maxAgeSeconds = this.configService.get<number>(
      'TG_INIT_DATA_MAX_AGE',
      86400, // 24 hours default
    );

    // Parse whitelist of allowed Telegram user IDs
    // Format: comma-separated list of IDs, e.g., "123456789,987654321"
    const allowedIdsStr = this.configService.get<string>('ALLOWED_TELEGRAM_IDS', '');
    this.allowedUserIds = new Set(
      allowedIdsStr
        .split(',')
        .map((id) => parseInt(id.trim(), 10))
        .filter((id) => !isNaN(id) && id > 0),
    );

    if (this.allowedUserIds.size > 0) {
      this.logger.log(
        `Mini App access whitelist enabled: ${this.allowedUserIds.size} user(s)`,
      );
    } else {
      this.logger.warn(
        'ALLOWED_TELEGRAM_IDS not configured - Mini App is open to all bot users!',
      );
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TelegramAuthRequest>();
    const authHeader = request.headers['authorization'];

    if (!authHeader) {
      this.logger.warn('Missing Authorization header');
      throw new UnauthorizedException('Missing Authorization header');
    }

    const [authType, initDataRaw] = authHeader.split(' ');

    if (authType !== 'tma' || !initDataRaw) {
      this.logger.warn(`Invalid auth format: ${authType}`);
      throw new UnauthorizedException(
        'Invalid Authorization format. Expected: tma <initData>',
      );
    }

    try {
      const initData = this.validateAndParse(initDataRaw);
      request.telegramInitData = initData;
      request.telegramUser = initData.user;

      // Check whitelist if configured
      if (this.allowedUserIds.size > 0) {
        const userId = initData.user?.id;
        if (!userId || !this.allowedUserIds.has(userId)) {
          this.logger.warn(
            `Access denied for user ${userId} (@${initData.user?.username}) - not in whitelist`,
          );
          throw new UnauthorizedException(
            'Access denied. You are not authorized to use this app.',
          );
        }
      }

      this.logger.debug(
        `Authenticated Telegram user: ${initData.user?.id} (@${initData.user?.username})`,
      );

      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      this.logger.error('initData validation failed', error);
      throw new UnauthorizedException('Invalid initData');
    }
  }

  /**
   * Validates the initData signature and parses the data.
   *
   * Algorithm:
   * 1. Parse initData as URLSearchParams
   * 2. Extract hash and auth_date
   * 3. Check auth_date is not expired
   * 4. Build data-check-string (sorted params without hash)
   * 5. Create secret key: HMAC-SHA256(botToken, "WebAppData")
   * 6. Create hash: HMAC-SHA256(secret, data-check-string)
   * 7. Compare with provided hash
   */
  private validateAndParse(initDataRaw: string): TelegramInitData {
    const decoded = decodeURIComponent(initDataRaw);
    const params = new URLSearchParams(decoded);

    // Extract hash
    const hash = params.get('hash');
    if (!hash) {
      throw new UnauthorizedException('Missing hash in initData');
    }

    // Extract and validate auth_date
    const authDateStr = params.get('auth_date');
    if (!authDateStr) {
      throw new UnauthorizedException('Missing auth_date in initData');
    }

    const authDate = parseInt(authDateStr, 10);
    if (isNaN(authDate)) {
      throw new UnauthorizedException('Invalid auth_date format');
    }

    const now = Math.floor(Date.now() / 1000);
    if (now - authDate > this.maxAgeSeconds) {
      throw new UnauthorizedException(
        `initData expired (age: ${now - authDate}s, max: ${this.maxAgeSeconds}s)`,
      );
    }

    // Build data-check-string: sorted params without hash, joined by \n
    const checkParams: string[] = [];
    params.forEach((value, key) => {
      if (key !== 'hash') {
        checkParams.push(`${key}=${value}`);
      }
    });
    checkParams.sort();
    const dataCheckString = checkParams.join('\n');

    // Calculate expected hash
    // secret_key = HMAC-SHA256("WebAppData", bot_token)
    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(this.botToken)
      .digest();

    // hash = HMAC-SHA256(secret_key, data_check_string)
    const expectedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    // Constant-time comparison to prevent timing attacks
    if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expectedHash))) {
      this.logger.warn('Invalid signature');
      throw new UnauthorizedException('Invalid signature');
    }

    // Parse user data
    const userStr = params.get('user');
    let user: TelegramUser | undefined;
    if (userStr) {
      try {
        user = JSON.parse(userStr) as TelegramUser;
      } catch {
        this.logger.warn('Failed to parse user JSON');
        throw new UnauthorizedException('Invalid user data');
      }
    }

    return {
      query_id: params.get('query_id') || undefined,
      user,
      auth_date: authDate,
      hash,
      start_param: params.get('start_param') || undefined,
    };
  }
}
