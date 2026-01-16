import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Guard to protect internal API endpoints with API key authentication.
 * Expects X-API-Key header with valid key matching PKG_CORE_API_KEY env variable.
 *
 * If PKG_CORE_API_KEY is not set, the guard allows all requests (dev mode).
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly apiKey: string | undefined;

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('PKG_CORE_API_KEY');
  }

  canActivate(context: ExecutionContext): boolean {
    // Dev mode: if no API key configured, allow all requests
    if (!this.apiKey) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const providedKey = request.headers['x-api-key'];

    if (!providedKey) {
      throw new UnauthorizedException('Missing X-API-Key header');
    }

    if (providedKey !== this.apiKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    return true;
  }
}
