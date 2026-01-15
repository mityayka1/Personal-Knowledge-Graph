import { getValidAccessToken } from '../../utils/auth';

interface User {
  id: string;
  username: string;
  email: string | null;
  displayName: string | null;
  role: string;
}

/**
 * GET /api/auth/me
 *
 * Get current authenticated user info
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();

  // Get valid access token (will refresh if needed)
  const accessToken = await getValidAccessToken(event);

  if (!accessToken) {
    throw createError({
      statusCode: 401,
      message: 'Not authenticated',
    });
  }

  try {
    const user = await $fetch<User>(`${config.pkgCoreUrl}/auth/me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    return user;
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'statusCode' in error) {
      const httpError = error as { statusCode: number; message?: string };
      throw createError({
        statusCode: httpError.statusCode,
        message: httpError.message || 'Failed to get user info',
      });
    }

    throw createError({
      statusCode: 500,
      message: 'Internal server error',
    });
  }
});
