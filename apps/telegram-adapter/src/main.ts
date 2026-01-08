import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3001);

  app.setGlobalPrefix('api/v1');

  await app.listen(port);
  console.log(`Telegram Adapter running on http://localhost:${port}/api/v1`);
}

bootstrap();
