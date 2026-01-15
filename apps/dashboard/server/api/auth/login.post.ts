import { storeAuthTokens } from '../../utils/auth';

interface LoginRequest {
  username: string;
  password: string;
}

interface LoginResponse {
  accessToken: string;
  expiresIn: number;
}

/**
 * POST /api/auth/login
 *
 * Proxies login request to PKG Core and stores tokens in cookies
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const body = await readBody<LoginRequest>(event);

  if (!body?.username || !body?.password) {
    throw createError({
      statusCode: 400,
      message: 'Username and password are required',
    });
  }

  try {
    // Forward login request to PKG Core
    let capturedRefreshToken = '';
    let refreshTokenMaxAge = 7 * 24 * 60 * 60; // Default 7 days, will be overridden from cookie

    const response = await $fetch<LoginResponse>(`${config.pkgCoreUrl}/auth/login`, {
      method: 'POST',
      body: {
        username: body.username,
        password: body.password,
      },
      // Capture Set-Cookie header from response
      onResponse({ response: fetchResponse }) {
        // PKG Core sets refreshToken as httpOnly cookie
        const setCookieHeader = fetchResponse.headers.get('set-cookie');
        if (setCookieHeader) {
          // Parse refresh token from Set-Cookie header
          const refreshTokenMatch = setCookieHeader.match(/refreshToken=([^;]+)/);
          if (refreshTokenMatch) {
            capturedRefreshToken = refreshTokenMatch[1];
          }
          // Parse max-age to sync with backend TTL
          const maxAgeMatch = setCookieHeader.match(/Max-Age=(\d+)/i);
          if (maxAgeMatch) {
            refreshTokenMaxAge = parseInt(maxAgeMatch[1], 10);
          }
        }
      },
    });

    // Store tokens in cookies after receiving response
    // Uses max-age from backend cookie for consistency
    storeAuthTokens(
      event,
      response.accessToken,
      capturedRefreshToken,
      response.expiresIn,
      refreshTokenMaxAge
    );

    return {
      accessToken: response.accessToken,
      expiresIn: response.expiresIn,
    };
  } catch (error: unknown) {
    // Handle specific error types
    if (error && typeof error === 'object' && 'statusCode' in error) {
      const httpError = error as { statusCode: number; message?: string };
      throw createError({
        statusCode: httpError.statusCode,
        message: httpError.message || 'Authentication failed',
      });
    }

    throw createError({
      statusCode: 500,
      message: 'Internal server error',
    });
  }
});
