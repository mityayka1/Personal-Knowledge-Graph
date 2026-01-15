import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { User, UserRole, UserStatus } from '@pkg/entities';
import { AuthConfig } from '../../common/config/auth.config';

// Mock bcrypt
jest.mock('bcrypt');

// Mock uuid
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'test-uuid-1234'),
}));

// Helper to create a mock scanStream that emits keys
function createMockScanStream(keys: string[]) {
  const { EventEmitter } = require('events');
  const stream = new EventEmitter();
  // Emit keys in next tick to simulate async behavior
  process.nextTick(() => {
    if (keys.length > 0) {
      stream.emit('data', keys);
    }
    stream.emit('end');
  });
  return stream;
}

describe('AuthService', () => {
  let service: AuthService;
  let userRepository: jest.Mocked<Repository<User>>;
  let jwtService: jest.Mocked<JwtService>;
  let redis: jest.Mocked<{
    get: jest.Mock;
    setex: jest.Mock;
    del: jest.Mock;
    keys: jest.Mock;
    scanStream: jest.Mock;
  }>;

  describe('constructor', () => {
    it('should throw error if auth config is not found', async () => {
      const mockConfigService = {
        get: jest.fn().mockReturnValue(undefined),
      };

      await expect(
        Test.createTestingModule({
          providers: [
            AuthService,
            {
              provide: getRepositoryToken(User),
              useValue: {},
            },
            {
              provide: JwtService,
              useValue: {},
            },
            {
              provide: ConfigService,
              useValue: mockConfigService,
            },
            {
              provide: 'default_IORedisModuleConnectionToken',
              useValue: {},
            },
          ],
        }).compile(),
      ).rejects.toThrow('Auth configuration not found');
    });
  });

  const mockAuthConfig: AuthConfig = {
    jwtSecret: 'test-secret',
    jwtAccessExpiration: '15m',
    jwtRefreshExpiration: '7d',
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 604800,
    maxLoginAttempts: 5,
    lockoutDurationMinutes: 15,
  };

  const createMockUser = (overrides: Partial<User> = {}): User => ({
    id: 'user-uuid-1234',
    username: 'testuser',
    email: 'test@example.com',
    passwordHash: '$2b$12$hashedpassword',
    displayName: 'Test User',
    role: UserRole.USER,
    status: UserStatus.ACTIVE,
    lastLoginAt: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
    metadata: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  });

  beforeEach(async () => {
    // Create mocks
    const mockUserRepository = {
      findOne: jest.fn(),
      update: jest.fn(),
    };

    const mockJwtService = {
      sign: jest.fn(),
      verify: jest.fn(),
    };

    const mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'auth') return mockAuthConfig;
        return undefined;
      }),
    };

    redis = {
      get: jest.fn(),
      setex: jest.fn(),
      del: jest.fn(),
      keys: jest.fn(),
      scanStream: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: getRepositoryToken(User),
          useValue: mockUserRepository,
        },
        {
          provide: JwtService,
          useValue: mockJwtService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: 'default_IORedisModuleConnectionToken',
          useValue: redis,
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    userRepository = module.get(getRepositoryToken(User));
    jwtService = module.get(JwtService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('login', () => {
    const loginDto = { username: 'testuser', password: 'validPassword123' };

    it('should login successfully with valid credentials', async () => {
      const mockUser = createMockUser();
      userRepository.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      jwtService.sign
        .mockReturnValueOnce('access-token-123')
        .mockReturnValueOnce('refresh-token-456');
      redis.setex.mockResolvedValue('OK');
      userRepository.update.mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] });

      const result = await service.login(loginDto);

      expect(result).toEqual({
        accessToken: 'access-token-123',
        refreshToken: 'refresh-token-456',
        expiresIn: mockAuthConfig.accessTokenTtlSeconds,
      });
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { username: loginDto.username },
      });
      expect(bcrypt.compare).toHaveBeenCalledWith(loginDto.password, mockUser.passwordHash);
      expect(jwtService.sign).toHaveBeenCalledTimes(2);
      expect(redis.setex).toHaveBeenCalled();
      expect(userRepository.update).toHaveBeenCalledWith(mockUser.id, {
        lastLoginAt: expect.any(Date),
      });
    });

    it('should throw UnauthorizedException for non-existent user', async () => {
      userRepository.findOne.mockResolvedValue(null);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(service.login(loginDto)).rejects.toThrow(UnauthorizedException);
      await expect(service.login(loginDto)).rejects.toThrow('Invalid credentials');

      // Should still perform dummy hash comparison for timing safety
      expect(bcrypt.compare).toHaveBeenCalled();
    });

    it('should throw UnauthorizedException for invalid password', async () => {
      const mockUser = createMockUser();
      userRepository.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      userRepository.update.mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] });

      await expect(service.login(loginDto)).rejects.toThrow(UnauthorizedException);
      await expect(service.login(loginDto)).rejects.toThrow('Invalid credentials');

      // Should increment failed login attempts
      expect(userRepository.update).toHaveBeenCalledWith(mockUser.id, {
        failedLoginAttempts: 1,
      });
    });

    it('should throw ForbiddenException for locked user with active lockout', async () => {
      const futureDate = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now
      const mockUser = createMockUser({
        status: UserStatus.LOCKED,
        lockedUntil: futureDate,
      });
      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(service.login(loginDto)).rejects.toThrow(ForbiddenException);
      await expect(service.login(loginDto)).rejects.toThrow(/Account is locked/);
    });

    it('should reset lockout and allow login when lockout has expired', async () => {
      const pastDate = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
      const mockUser = createMockUser({
        status: UserStatus.LOCKED,
        lockedUntil: pastDate,
      });
      userRepository.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      jwtService.sign
        .mockReturnValueOnce('access-token-123')
        .mockReturnValueOnce('refresh-token-456');
      redis.setex.mockResolvedValue('OK');
      userRepository.update.mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] });

      const result = await service.login(loginDto);

      expect(result.accessToken).toBe('access-token-123');
      // Should reset lockout status
      expect(userRepository.update).toHaveBeenCalledWith(mockUser.id, {
        status: UserStatus.ACTIVE,
        failedLoginAttempts: 0,
        lockedUntil: null,
      });
    });

    it('should lock account after max failed attempts', async () => {
      const mockUser = createMockUser({
        failedLoginAttempts: 4, // One attempt away from lockout
      });
      userRepository.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      userRepository.update.mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] });

      await expect(service.login(loginDto)).rejects.toThrow(UnauthorizedException);

      // Should lock the account
      expect(userRepository.update).toHaveBeenCalledWith(mockUser.id, {
        failedLoginAttempts: 5,
        status: UserStatus.LOCKED,
        lockedUntil: expect.any(Date),
      });
    });

    it('should reset failed attempts on successful login', async () => {
      const mockUser = createMockUser({
        failedLoginAttempts: 3,
      });
      userRepository.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      jwtService.sign
        .mockReturnValueOnce('access-token-123')
        .mockReturnValueOnce('refresh-token-456');
      redis.setex.mockResolvedValue('OK');
      userRepository.update.mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] });

      await service.login(loginDto);

      // Should reset failed attempts
      expect(userRepository.update).toHaveBeenCalledWith(mockUser.id, {
        failedLoginAttempts: 0,
      });
    });
  });

  describe('refreshTokens', () => {
    const refreshToken = 'valid-refresh-token';

    it('should refresh tokens successfully with valid refresh token', async () => {
      const mockUser = createMockUser();
      const mockPayload = {
        sub: mockUser.id,
        username: mockUser.username,
        role: mockUser.role,
        type: 'refresh' as const,
        jti: 'old-jti-1234',
      };

      jwtService.verify.mockReturnValue(mockPayload);
      redis.get.mockResolvedValue(
        JSON.stringify({
          tokenHash: expect.any(String),
          createdAt: new Date().toISOString(),
        }),
      );
      // Mock the hash comparison - in real scenario this would match
      redis.get.mockResolvedValue(
        JSON.stringify({
          tokenHash: require('crypto').createHash('sha256').update(refreshToken).digest('hex'),
          createdAt: new Date().toISOString(),
        }),
      );
      redis.del.mockResolvedValue(1);
      userRepository.findOne.mockResolvedValue(mockUser);
      jwtService.sign
        .mockReturnValueOnce('new-access-token')
        .mockReturnValueOnce('new-refresh-token');
      redis.setex.mockResolvedValue('OK');

      const result = await service.refreshTokens(refreshToken);

      expect(result).toEqual({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresIn: mockAuthConfig.accessTokenTtlSeconds,
      });
      expect(jwtService.verify).toHaveBeenCalledWith(refreshToken, {
        secret: mockAuthConfig.jwtSecret,
      });
      expect(redis.del).toHaveBeenCalledWith(
        `auth:refresh:${mockUser.id}:${mockPayload.jti}`,
      );
    });

    it('should throw UnauthorizedException for invalid token type', async () => {
      const mockPayload = {
        sub: 'user-id',
        username: 'testuser',
        role: 'user',
        type: 'access' as const, // Wrong type
        jti: 'jti-1234',
      };

      jwtService.verify.mockReturnValue(mockPayload);

      await expect(service.refreshTokens(refreshToken)).rejects.toThrow(UnauthorizedException);
      await expect(service.refreshTokens(refreshToken)).rejects.toThrow('Invalid token type');
    });

    it('should throw UnauthorizedException for revoked token', async () => {
      const mockPayload = {
        sub: 'user-id',
        username: 'testuser',
        role: 'user',
        type: 'refresh' as const,
        jti: 'jti-1234',
      };

      jwtService.verify.mockReturnValue(mockPayload);
      redis.get.mockResolvedValue(null); // Token not in Redis (revoked)

      await expect(service.refreshTokens(refreshToken)).rejects.toThrow(UnauthorizedException);
      await expect(service.refreshTokens(refreshToken)).rejects.toThrow('Token has been revoked');
    });

    it('should throw UnauthorizedException for inactive user', async () => {
      const mockUser = createMockUser({ status: UserStatus.INACTIVE });
      const mockPayload = {
        sub: mockUser.id,
        username: mockUser.username,
        role: mockUser.role,
        type: 'refresh' as const,
        jti: 'jti-1234',
      };

      jwtService.verify.mockReturnValue(mockPayload);
      redis.get.mockResolvedValue(
        JSON.stringify({
          tokenHash: require('crypto').createHash('sha256').update(refreshToken).digest('hex'),
          createdAt: new Date().toISOString(),
        }),
      );
      redis.del.mockResolvedValue(1);
      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(service.refreshTokens(refreshToken)).rejects.toThrow(UnauthorizedException);
      await expect(service.refreshTokens(refreshToken)).rejects.toThrow(
        'User not found or inactive',
      );
    });

    it('should throw UnauthorizedException for expired token', async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('jwt expired');
      });

      await expect(service.refreshTokens(refreshToken)).rejects.toThrow(UnauthorizedException);
      await expect(service.refreshTokens(refreshToken)).rejects.toThrow('Invalid refresh token');
    });

    it('should handle non-Error thrown objects gracefully', async () => {
      // Test edge case where something other than Error is thrown
      jwtService.verify.mockImplementation(() => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'string error'; // Throw non-Error object
      });

      await expect(service.refreshTokens(refreshToken)).rejects.toThrow(UnauthorizedException);
      await expect(service.refreshTokens(refreshToken)).rejects.toThrow('Invalid refresh token');
    });

    it('should detect and handle token reuse attack', async () => {
      const mockUser = createMockUser();
      const mockPayload = {
        sub: mockUser.id,
        username: mockUser.username,
        role: mockUser.role,
        type: 'refresh' as const,
        jti: 'jti-1234',
      };
      const tokenKeys = [`auth:refresh:${mockUser.id}:jti-1`, `auth:refresh:${mockUser.id}:jti-2`];

      jwtService.verify.mockReturnValue(mockPayload);
      // Token hash doesn't match (token reuse)
      redis.get.mockResolvedValue(
        JSON.stringify({
          tokenHash: 'different-hash-indicating-reuse',
          createdAt: new Date().toISOString(),
        }),
      );
      // Return new stream on each call
      redis.scanStream.mockImplementation(() => createMockScanStream(tokenKeys));
      redis.del.mockResolvedValue(2);

      await expect(service.refreshTokens(refreshToken)).rejects.toThrow(UnauthorizedException);
      await expect(service.refreshTokens(refreshToken)).rejects.toThrow('Token reuse detected');

      // Should revoke all user tokens using scanStream
      expect(redis.scanStream).toHaveBeenCalledWith({
        match: `auth:refresh:${mockUser.id}:*`,
        count: 100,
      });
    });
  });

  describe('logout', () => {
    it('should delete refresh token from Redis on logout', async () => {
      const userId = 'user-uuid-1234';
      const refreshToken = 'valid-refresh-token';
      const mockPayload = {
        sub: userId,
        username: 'testuser',
        role: 'user',
        type: 'refresh' as const,
        jti: 'jti-1234',
      };

      jwtService.verify.mockReturnValue(mockPayload);
      redis.del.mockResolvedValue(1);

      await service.logout(userId, refreshToken);

      expect(jwtService.verify).toHaveBeenCalledWith(refreshToken, {
        secret: mockAuthConfig.jwtSecret,
      });
      expect(redis.del).toHaveBeenCalledWith(`auth:refresh:${userId}:${mockPayload.jti}`);
    });

    it('should handle logout gracefully with invalid token', async () => {
      const userId = 'user-uuid-1234';
      const refreshToken = 'invalid-token';

      jwtService.verify.mockImplementation(() => {
        throw new Error('invalid token');
      });

      // Should not throw
      await expect(service.logout(userId, refreshToken)).resolves.not.toThrow();
    });
  });

  describe('revokeAllUserTokens', () => {
    it('should revoke all refresh tokens for a user using scanStream', async () => {
      const userId = 'user-uuid-1234';
      const tokenKeys = [
        `auth:refresh:${userId}:jti-1`,
        `auth:refresh:${userId}:jti-2`,
        `auth:refresh:${userId}:jti-3`,
      ];

      redis.scanStream.mockReturnValue(createMockScanStream(tokenKeys));
      redis.del.mockResolvedValue(3);

      await service.revokeAllUserTokens(userId);

      expect(redis.scanStream).toHaveBeenCalledWith({
        match: `auth:refresh:${userId}:*`,
        count: 100,
      });
      expect(redis.del).toHaveBeenCalledWith(...tokenKeys);
    });

    it('should handle case when user has no tokens', async () => {
      const userId = 'user-uuid-1234';

      redis.scanStream.mockReturnValue(createMockScanStream([]));

      await service.revokeAllUserTokens(userId);

      expect(redis.scanStream).toHaveBeenCalledWith({
        match: `auth:refresh:${userId}:*`,
        count: 100,
      });
      expect(redis.del).not.toHaveBeenCalled();
    });
  });

  describe('validateUser', () => {
    it('should return user for valid active user', async () => {
      const mockUser = createMockUser();
      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.validateUser(mockUser.id);

      expect(result).toEqual(mockUser);
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: mockUser.id, status: UserStatus.ACTIVE },
      });
    });

    it('should return null for non-existent user', async () => {
      userRepository.findOne.mockResolvedValue(null);

      const result = await service.validateUser('non-existent-id');

      expect(result).toBeNull();
    });

    it('should return null for inactive user', async () => {
      userRepository.findOne.mockResolvedValue(null); // Because status filter won't match

      const result = await service.validateUser('inactive-user-id');

      expect(result).toBeNull();
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'inactive-user-id', status: UserStatus.ACTIVE },
      });
    });
  });

  describe('getMe', () => {
    it('should return user data for valid user', async () => {
      const mockUser = createMockUser();
      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.getMe(mockUser.id);

      expect(result).toEqual(mockUser);
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: mockUser.id },
        select: ['id', 'username', 'email', 'displayName', 'role', 'createdAt'],
      });
    });

    it('should throw UnauthorizedException for non-existent user', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(service.getMe('non-existent-id')).rejects.toThrow(UnauthorizedException);
      await expect(service.getMe('non-existent-id')).rejects.toThrow('User not found');
    });
  });
});
