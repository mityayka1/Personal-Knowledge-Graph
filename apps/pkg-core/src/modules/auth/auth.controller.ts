import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Req,
  Res,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { AuthResponseDto, UserResponseDto } from './dto/auth-response.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { AuthenticatedUser } from './interfaces/jwt-payload.interface';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';

// Request with authenticated user
interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

@Controller('auth')
export class AuthController {
  private readonly isProduction: boolean;
  private readonly refreshTokenTtl: number;

  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {
    this.isProduction = process.env.NODE_ENV === 'production';
    this.refreshTokenTtl = this.configService.get<number>('auth.refreshTokenTtlSeconds') || 604800;
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } }) // 10 attempts per minute
  async login(
    @Body() loginDto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const { accessToken, refreshToken, expiresIn } = await this.authService.login(loginDto);

    // Set refresh token as httpOnly cookie
    this.setRefreshTokenCookie(res, refreshToken);

    return {
      accessToken,
      expiresIn,
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body() refreshTokenDto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    // Get refresh token from cookie or body
    const refreshToken = req.cookies?.refreshToken || refreshTokenDto.refreshToken;

    if (!refreshToken) {
      throw new Error('Refresh token not provided');
    }

    const { accessToken, refreshToken: newRefreshToken, expiresIn } =
      await this.authService.refreshTokens(refreshToken);

    // Set new refresh token cookie
    this.setRefreshTokenCookie(res, newRefreshToken);

    return {
      accessToken,
      expiresIn,
    };
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const refreshToken = req.cookies?.refreshToken;

    if (refreshToken && req.user) {
      await this.authService.logout(req.user.id, refreshToken);
    }

    // Clear refresh token cookie
    this.clearRefreshTokenCookie(res);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMe(@Req() req: AuthenticatedRequest): Promise<UserResponseDto> {
    if (!req.user) {
      throw new Error('User not authenticated');
    }
    const user = await this.authService.getMe(req.user.id);

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    };
  }

  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutAll(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    if (!req.user) {
      throw new Error('User not authenticated');
    }
    await this.authService.revokeAllUserTokens(req.user.id);
    this.clearRefreshTokenCookie(res);
  }

  private setRefreshTokenCookie(res: Response, token: string): void {
    res.cookie('refreshToken', token, {
      httpOnly: true,
      secure: this.isProduction,
      sameSite: 'strict',
      path: '/api/v1/auth',
      maxAge: this.refreshTokenTtl * 1000,
    });
  }

  private clearRefreshTokenCookie(res: Response): void {
    res.cookie('refreshToken', '', {
      httpOnly: true,
      secure: this.isProduction,
      sameSite: 'strict',
      path: '/api/v1/auth',
      maxAge: 0,
    });
  }
}
