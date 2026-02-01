import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import {
  TelegramAuthRequest,
  TelegramUser,
  TelegramInitData,
} from '../guards/telegram-auth.guard';

/**
 * Decorator to extract the Telegram user from the request.
 *
 * Usage:
 * ```typescript
 * @Get('me')
 * @UseGuards(TelegramAuthGuard)
 * getMe(@TgUser() user: TelegramUser) {
 *   return { userId: user.id, name: user.first_name };
 * }
 * ```
 */
export const TgUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): TelegramUser | undefined => {
    const request = ctx.switchToHttp().getRequest<TelegramAuthRequest>();
    return request.telegramUser;
  },
);

/**
 * Decorator to extract the full initData from the request.
 *
 * Usage:
 * ```typescript
 * @Get('info')
 * @UseGuards(TelegramAuthGuard)
 * getInfo(@TgInitData() initData: TelegramInitData) {
 *   return { startParam: initData.start_param };
 * }
 * ```
 */
export const TgInitData = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): TelegramInitData => {
    const request = ctx.switchToHttp().getRequest<TelegramAuthRequest>();
    return request.telegramInitData;
  },
);
