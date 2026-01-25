import {
  Controller,
  All,
  Req,
  Res,
  Logger,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { extractWildcardPath, WildcardParams } from '../../common/utils';

/**
 * Proxy controller for Telegram Adapter requests.
 * Routes: /internal/telegram/* → Telegram Adapter /api/v1/*
 *
 * This maintains the architectural principle that Dashboard
 * communicates only with PKG Core, not directly with adapters.
 *
 * @see docs/solutions/integration-issues/source-agnostic-architecture-prevention.md
 */
@Controller('internal/telegram')
export class TelegramProxyController {
  private readonly logger = new Logger(TelegramProxyController.name);
  private readonly telegramAdapterUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.telegramAdapterUrl = this.configService.get<string>(
      'TELEGRAM_ADAPTER_URL',
      'http://telegram-adapter:3001',
    );
  }

  @All('*path')
  async proxy(@Req() req: Request, @Res() res: Response) {
    // Extract the path after /internal/telegram/
    // Uses extractWildcardPath to handle path-to-regexp v8+ array format
    const path = extractWildcardPath(req.params as WildcardParams);
    const targetUrl = `${this.telegramAdapterUrl}/api/v1/${path}`;

    this.logger.debug(`Proxying ${req.method} ${path} → ${targetUrl}`);

    try {
      // Build fetch options
      const fetchOptions: RequestInit = {
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          // Forward API key if present
          ...(req.headers['x-api-key'] && {
            'x-api-key': req.headers['x-api-key'] as string,
          }),
        },
      };

      // Add body for non-GET requests
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
        fetchOptions.body = JSON.stringify(req.body);
      }

      // Build URL with query params
      const url = new URL(targetUrl);
      Object.entries(req.query).forEach(([key, value]) => {
        if (typeof value === 'string') {
          url.searchParams.append(key, value);
        }
      });

      const response = await fetch(url.toString(), fetchOptions);
      const data = await response.json().catch(() => null);

      // Forward response status and data
      res.status(response.status).json(data);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Proxy error for ${path}: ${errorMessage}`);

      res.status(HttpStatus.BAD_GATEWAY).json({
        statusCode: HttpStatus.BAD_GATEWAY,
        message: `Telegram Adapter unavailable: ${errorMessage}`,
        error: 'Bad Gateway',
      });
    }
  }
}
