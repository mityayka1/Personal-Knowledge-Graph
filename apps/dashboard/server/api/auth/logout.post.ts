import { clearAuthCookies, getValidAccessToken } from '../../utils/auth';

/**
 * POST /api/auth/logout
 *
 * Logout user and clear auth cookies
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();

  try {
    // Get current access token
    const accessToken = await getValidAccessToken(event);

    if (accessToken) {
      // Notify PKG Core to invalidate refresh token
      await $fetch(`${config.pkgCoreUrl}/auth/logout`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }).catch(() => {
        // Ignore errors - logout should always succeed locally
      });
    }
  } finally {
    // Always clear local cookies
    clearAuthCookies(event);
  }

  return { success: true };
});
