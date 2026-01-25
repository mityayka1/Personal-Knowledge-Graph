import { Module } from '@nestjs/common';
import { TelegramProxyController } from './telegram-proxy.controller';

/**
 * Module for internal proxy endpoints.
 * Provides unified access to external adapters through PKG Core.
 */
@Module({
  controllers: [TelegramProxyController],
})
export class InternalProxyModule {}
