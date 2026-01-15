import {
  Injectable,
  UnauthorizedException,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';
import { User, UserStatus } from '@pkg/entities';
import { JwtPayload, TokenResponse } from './interfaces/jwt-payload.interface';
import { LoginDto } from './dto/login.dto';
import { AuthConfig } from '../../common/config/auth.config';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly REFRESH_TOKEN_PREFIX = 'auth:refresh:';
  private readonly authConfig: AuthConfig;
  private dummyHash: string;

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @InjectRedis()
    private readonly redis: Redis,
  ) {
    const config = this.configService.get<AuthConfig>('auth');
    if (!config) {
      throw new Error('Auth configuration not found');
    }
    this.authConfig = config;

    // Generate a valid dummy hash for timing-safe comparison
    // This is async but we store the promise result synchronously via IIFE
    this.dummyHash = '';
    this.initDummyHash();
  }

  private async initDummyHash(): Promise<void> {
    // Generate a valid bcrypt hash for timing-safe password comparison
    this.dummyHash = await bcrypt.hash('dummy-password-for-timing-safety', 12);
  }

  async login(loginDto: LoginDto): Promise<TokenResponse & { refreshToken: string }> {
    const { username, password } = loginDto;

    // Find user
    const user = await this.userRepository.findOne({
      where: { username },
    });

    // Check user exists (timing-safe: don't reveal if user exists)
    if (!user) {
      // Perform dummy hash comparison to prevent timing attacks
      // Use pre-generated valid bcrypt hash (falls back to inline generation if not ready)
      const hashToCompare = this.dummyHash || await bcrypt.hash('fallback', 12);
      await bcrypt.compare(password, hashToCompare);
      throw new UnauthorizedException('Invalid credentials');
    }

    // Check if account is locked
    if (user.status === UserStatus.LOCKED) {
      if (user.lockedUntil && user.lockedUntil > new Date()) {
        const remainingMinutes = Math.ceil(
          (user.lockedUntil.getTime() - Date.now()) / 60000,
        );
        throw new ForbiddenException(
          `Account is locked. Try again in ${remainingMinutes} minutes`,
        );
      }
      // Lockout expired, reset status
      await this.resetLockout(user);
    }

    // Validate password
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordValid) {
      await this.handleFailedLogin(user);
      throw new UnauthorizedException('Invalid credentials');
    }

    // Reset failed attempts on successful login
    await this.resetFailedAttempts(user);

    // Generate tokens
    const tokens = await this.generateTokens(user);

    // Update last login
    await this.userRepository.update(user.id, {
      lastLoginAt: new Date(),
    });

    this.logger.log(`User ${username} logged in successfully`);

    return tokens;
  }

  async refreshTokens(refreshToken: string): Promise<TokenResponse & { refreshToken: string }> {
    try {
      // Verify token
      const payload = this.jwtService.verify<JwtPayload>(refreshToken, {
        secret: this.authConfig.jwtSecret,
      });

      // Check token type
      if (payload.type !== 'refresh') {
        throw new UnauthorizedException('Invalid token type');
      }

      // Check if token is in Redis (not revoked)
      const storedToken = await this.redis.get(
        `${this.REFRESH_TOKEN_PREFIX}${payload.sub}:${payload.jti}`,
      );

      if (!storedToken) {
        throw new UnauthorizedException('Token has been revoked');
      }

      // Verify token hash matches
      const tokenData = JSON.parse(storedToken);
      const tokenHash = this.hashToken(refreshToken);

      if (tokenData.tokenHash !== tokenHash) {
        // Possible token reuse attack - revoke all user tokens
        this.logger.warn(`Possible token reuse attack for user ${payload.sub}`);
        await this.revokeAllUserTokens(payload.sub);
        throw new UnauthorizedException('Token reuse detected');
      }

      // Revoke old token
      await this.redis.del(`${this.REFRESH_TOKEN_PREFIX}${payload.sub}:${payload.jti}`);

      // Get user
      const user = await this.userRepository.findOne({
        where: { id: payload.sub },
      });

      if (!user || user.status !== UserStatus.ACTIVE) {
        throw new UnauthorizedException('User not found or inactive');
      }

      // Generate new tokens
      return this.generateTokens(user);
    } catch (error) {
      if (error instanceof UnauthorizedException || error instanceof ForbiddenException) {
        throw error;
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Token refresh failed: ${errorMessage}`);
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async logout(userId: string, refreshToken: string): Promise<void> {
    try {
      const payload = this.jwtService.verify<JwtPayload>(refreshToken, {
        secret: this.authConfig.jwtSecret,
      });

      if (payload.jti) {
        await this.redis.del(`${this.REFRESH_TOKEN_PREFIX}${userId}:${payload.jti}`);
      }

      this.logger.log(`User ${userId} logged out`);
    } catch {
      // Token may already be invalid, just log
      this.logger.debug(`Logout with invalid token for user ${userId}`);
    }
  }

  async revokeAllUserTokens(userId: string): Promise<void> {
    const pattern = `${this.REFRESH_TOKEN_PREFIX}${userId}:*`;
    const keys: string[] = [];

    // Use scanStream instead of keys() to avoid blocking Redis
    const stream = this.redis.scanStream({
      match: pattern,
      count: 100,
    });

    await new Promise<void>((resolve, reject) => {
      stream.on('data', (resultKeys: string[]) => {
        keys.push(...resultKeys);
      });
      stream.on('end', () => resolve());
      stream.on('error', (err) => reject(err));
    });

    if (keys.length > 0) {
      // Delete in batches to avoid memory issues with large key sets
      const batchSize = 100;
      for (let i = 0; i < keys.length; i += batchSize) {
        const batch = keys.slice(i, i + batchSize);
        await this.redis.del(...batch);
      }
    }

    this.logger.log(`Revoked all tokens for user ${userId} (${keys.length} tokens)`);
  }

  async validateUser(userId: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { id: userId, status: UserStatus.ACTIVE },
    });
  }

  async getMe(userId: string): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      select: ['id', 'username', 'email', 'displayName', 'role', 'createdAt'],
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return user;
  }

  private async generateTokens(user: User): Promise<TokenResponse & { refreshToken: string }> {
    const jti = uuidv4();

    // Access token payload - cast to object for jwtService.sign
    const accessPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      type: 'access',
    };

    // Refresh token payload
    const refreshPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      type: 'refresh',
      jti,
    };

    const accessToken = this.jwtService.sign(accessPayload, {
      expiresIn: this.authConfig.accessTokenTtlSeconds,
    });

    const refreshToken = this.jwtService.sign(refreshPayload, {
      expiresIn: this.authConfig.refreshTokenTtlSeconds,
    });

    // Store refresh token hash in Redis
    const tokenHash = this.hashToken(refreshToken);
    await this.redis.setex(
      `${this.REFRESH_TOKEN_PREFIX}${user.id}:${jti}`,
      this.authConfig.refreshTokenTtlSeconds,
      JSON.stringify({
        tokenHash,
        createdAt: new Date().toISOString(),
      }),
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: this.authConfig.accessTokenTtlSeconds,
    };
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private async handleFailedLogin(user: User): Promise<void> {
    const newAttempts = user.failedLoginAttempts + 1;

    if (newAttempts >= this.authConfig.maxLoginAttempts) {
      // Lock account
      const lockedUntil = new Date(Date.now() + this.authConfig.lockoutDurationMinutes * 60000);
      await this.userRepository.update(user.id, {
        failedLoginAttempts: newAttempts,
        status: UserStatus.LOCKED,
        lockedUntil,
      });
      this.logger.warn(`User ${user.username} locked due to too many failed attempts`);
    } else {
      await this.userRepository.update(user.id, {
        failedLoginAttempts: newAttempts,
      });
    }
  }

  private async resetFailedAttempts(user: User): Promise<void> {
    if (user.failedLoginAttempts > 0) {
      await this.userRepository.update(user.id, {
        failedLoginAttempts: 0,
      });
    }
  }

  private async resetLockout(user: User): Promise<void> {
    await this.userRepository.update(user.id, {
      status: UserStatus.ACTIVE,
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
  }
}
