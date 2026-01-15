import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, ConsoleLogger, LogLevel } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

/**
 * Get log levels based on LOG_LEVEL environment variable
 * LOG_LEVEL=debug includes: debug, log, warn, error
 * LOG_LEVEL=verbose includes: verbose, debug, log, warn, error
 */
function getLogLevels(): LogLevel[] {
  const level = process.env.LOG_LEVEL?.toLowerCase();
  switch (level) {
    case 'verbose':
      return ['verbose', 'debug', 'log', 'warn', 'error'];
    case 'debug':
      return ['debug', 'log', 'warn', 'error'];
    case 'warn':
      return ['warn', 'error'];
    case 'error':
      return ['error'];
    default:
      return ['log', 'warn', 'error'];
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // NestJS 11: Built-in JSON logging support
    logger: new ConsoleLogger({
      json: process.env.NODE_ENV === 'production',
      colors: process.env.NODE_ENV !== 'production',
      logLevels: getLogLevels(),
    }),
  });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port', 3000);
  const apiPrefix = configService.get<string>('app.apiPrefix', '/api/v1');

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Cookie parser for refresh tokens
  app.use(cookieParser());

  // API prefix
  app.setGlobalPrefix(apiPrefix);

  // CORS configuration
  app.enableCors({
    origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3003'],
    credentials: true, // Allow cookies
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  });

  await app.listen(port);

  console.log(`PKG Core running on http://localhost:${port}${apiPrefix}`);
}

bootstrap();
