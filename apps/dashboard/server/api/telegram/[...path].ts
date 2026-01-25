import { getValidAccessToken, isUnauthorizedError, refreshTokens } from '../../utils/auth';

/**
 * Telegram API Proxy through PKG Core
 *
 * Routes: /api/telegram/* → PKG Core /internal/telegram/*
 *
 * This maintains the architectural principle that Dashboard
 * communicates only with PKG Core, not directly with adapters.
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const path = event.context.params?.path || '';

  // Try to get JWT token for authenticated requests
  const accessToken = await getValidAccessToken(event);

  try {
    return await proxyRequest(event, path, config, accessToken);
  } catch (error: unknown) {
    // Handle 401 - try token refresh
    if (isUnauthorizedError(error) && accessToken) {
      const newToken = await refreshTokens(event);
      if (newToken) {
        return await proxyRequest(event, path, config, newToken);
      }
    }
    throw error;
  }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function proxyRequest(
  event: any,
  path: string,
  config: ReturnType<typeof useRuntimeConfig>,
  accessToken: string | null
) {
  // Build target URL through PKG Core proxy
  // pkgCoreUrl is http://localhost:3000/api/v1, routes through /api/v1/internal/telegram
  const targetUrl = `${config.pkgCoreUrl}/internal/telegram/${path}`;

  // Get query params
  const query = getQuery(event);

  // Get HTTP method with proper typing
  const method = event.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

  // Build headers - prefer JWT, fallback to API key
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  } else if (config.apiKey) {
    headers['X-API-Key'] = config.apiKey;
  }

  // Build fetch options
  const fetchOptions: {
    method: typeof method;
    headers: Record<string, string>;
    body?: string;
  } = {
    method,
    headers,
  };

  // Add body for non-GET requests
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      const body = await readBody(event);
      if (body) {
        fetchOptions.body = JSON.stringify(body);
      }
    } catch {
      // No body
    }
  }

  try {
    const response = await $fetch(targetUrl, {
      ...fetchOptions,
      query,
    });

    return response;
  } catch (error: unknown) {
    const fetchError = error as { statusCode?: number; data?: unknown; message?: string };

    // Forward error status and message
    throw createError({
      statusCode: fetchError.statusCode || 500,
      message: fetchError.message || 'Telegram API request failed',
      data: fetchError.data,
    });
  }
}
