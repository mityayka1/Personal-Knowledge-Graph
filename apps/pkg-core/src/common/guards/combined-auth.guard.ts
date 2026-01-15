import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { JwtPayload, AuthenticatedUser } from '../../modules/auth/interfaces/jwt-payload.interface';

/**
 * CombinedAuthGuard supports two authentication methods:
 * 1. JWT Bearer token - for Dashboard and future clients
 * 2. API Key - for service-to-service communication (Telegram Adapter, n8n, etc.)
 *
 * Detection logic:
 * - Bearer token with 3 parts separated by '.' -> JWT
 * - X-API-Key header or Bearer without JWT format -> API Key
 */
@Injectable()
export class CombinedAuthGuard implements CanActivate {
  private readonly logger = new Logger(CombinedAuthGuard.name);
  private readonly isProduction: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
  ) {
    this.isProduction = process.env.NODE_ENV === 'production';
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const { authType, token } = this.extractAuth(request);

    if (!authType || !token) {
      throw new UnauthorizedException('Authentication required');
    }

    if (authType === 'jwt') {
      return this.validateJwt(token, request);
    } else {
      return this.validateApiKey(token);
    }
  }

  private extractAuth(request: Request): { authType: 'jwt' | 'apikey' | null; token: string | null } {
    // Check X-API-Key header first (explicit API key)
    const apiKeyHeader = request.headers['x-api-key'];
    if (apiKeyHeader) {
      const token = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
      return { authType: 'apikey', token };
    }

    // Check Authorization header
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);

      // Check if it looks like a JWT (3 parts separated by '.')
      if (this.isJwtFormat(token)) {
        return { authType: 'jwt', token };
      } else {
        // Treat as API key
        return { authType: 'apikey', token };
      }
    }

    // Check query parameter (for webhooks)
    const queryKey = request.query['api_key'];
    if (queryKey) {
      const token = Array.isArray(queryKey) ? String(queryKey[0]) : String(queryKey);
      return { authType: 'apikey', token };
    }

    return { authType: null, token: null };
  }

  private isJwtFormat(token: string): boolean {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return false;
    }

    // Check if first part looks like a JWT header (starts with 'eyJ')
    return parts[0].startsWith('eyJ');
  }

  private async validateJwt(token: string, request: Request): Promise<boolean> {
    try {
      const jwtSecret = this.configService.get<string>('auth.jwtSecret');

      if (!jwtSecret) {
        throw new UnauthorizedException('JWT not configured');
      }

      const payload = this.jwtService.verify<JwtPayload>(token, {
        secret: jwtSecret,
      });

      // Only accept access tokens
      if (payload.type !== 'access') {
        throw new UnauthorizedException('Invalid token type');
      }

      // Attach user to request
      const user: AuthenticatedUser = {
        id: payload.sub,
        username: payload.username,
        role: payload.role,
      };

      request.user = user;

      return true;
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'TokenExpiredError') {
          throw new UnauthorizedException('Token has expired');
        }
        if (error.name === 'JsonWebTokenError') {
          throw new UnauthorizedException('Invalid token');
        }
      }
      throw error;
    }
  }

  private validateApiKey(token: string): boolean {
    const validApiKey = this.configService.get<string>('API_KEY');

    if (!validApiKey) {
      if (this.isProduction) {
        this.logger.error('API_KEY not configured in production - rejecting request');
        throw new UnauthorizedException('API key authentication not configured');
      }
      // Development mode: warn but allow
      this.logger.warn('API_KEY not configured - allowing request in development mode');
      return true;
    }

    if (token !== validApiKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    return true;
  }
}
