/**
 * Token refresh utilities for Nuxt server routes
 *
 * Architecture:
 * - Access token stored in httpOnly cookie for SSR support
 * - Refresh token stored in httpOnly cookie (set by PKG Core)
 * - Singleton promise pattern prevents concurrent refresh races
 *
 * Note: H3 functions (getCookie, setCookie, deleteCookie) are auto-imported by Nuxt
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type H3Event = any; // Using any to avoid h3 version conflicts between Nuxt internals

// In-flight refresh promise per request
const refreshPromises = new WeakMap<object, Promise<string | null>>();

/**
 * Get a valid access token, refreshing if necessary
 */
export async function getValidAccessToken(event: H3Event): Promise<string | null> {
  const accessToken = getCookie(event, 'pkg_access_token');

  // Return existing token if valid
  if (accessToken && !isTokenExpiringSoon(accessToken)) {
    return accessToken;
  }

  // Need to refresh
  return refreshTokens(event);
}

/**
 * Refresh access token using refresh token
 */
export async function refreshTokens(event: H3Event): Promise<string | null> {
  // Check if refresh already in progress for this request
  const existingPromise = refreshPromises.get(event);
  if (existingPromise) {
    return existingPromise;
  }

  const refreshToken = getCookie(event, 'pkg_refresh_token');
  if (!refreshToken) {
    return null;
  }

  const promise = performRefresh(event, refreshToken);
  refreshPromises.set(event, promise);

  try {
    return await promise;
  } finally {
    refreshPromises.delete(event);
  }
}

/**
 * Perform the actual token refresh
 */
async function performRefresh(event: H3Event, refreshToken: string): Promise<string | null> {
  const config = useRuntimeConfig();

  try {
    const response = await $fetch<{ accessToken: string; expiresIn: number }>(
      `${config.pkgCoreUrl}/auth/refresh`,
      {
        method: 'POST',
        headers: {
          Cookie: `refreshToken=${refreshToken}`,
        },
      }
    );

    // Store new access token in cookie for SSR
    setCookie(event, 'pkg_access_token', response.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: response.expiresIn,
      path: '/',
    });

    return response.accessToken;
  } catch (error) {
    // Refresh failed - clear tokens
    clearAuthCookies(event);
    return null;
  }
}

/**
 * Store tokens in cookies after login
 */
export function storeAuthTokens(
  event: H3Event,
  accessToken: string,
  refreshToken: string,
  accessExpiresIn: number,
  refreshExpiresIn: number
): void {
  const isProduction = process.env.NODE_ENV === 'production';

  // Access token - shorter lived
  setCookie(event, 'pkg_access_token', accessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    maxAge: accessExpiresIn,
    path: '/',
  });

  // Refresh token - longer lived
  setCookie(event, 'pkg_refresh_token', refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    maxAge: refreshExpiresIn,
    path: '/',
  });
}

/**
 * Clear all auth cookies
 */
export function clearAuthCookies(event: H3Event): void {
  deleteCookie(event, 'pkg_access_token', { path: '/' });
  deleteCookie(event, 'pkg_refresh_token', { path: '/' });
}

/**
 * Check if token is expired or expiring soon
 */
function isTokenExpiringSoon(token: string, thresholdSeconds = 60): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return true;

    const payload = JSON.parse(atob(parts[1]));
    const expiresAt = payload.exp * 1000;

    return Date.now() > expiresAt - thresholdSeconds * 1000;
  } catch {
    return true; // Invalid token
  }
}

/**
 * Check if an error is a 401 Unauthorized
 */
export function isUnauthorizedError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'statusCode' in error) {
    return (error as { statusCode: number }).statusCode === 401;
  }
  return false;
}
