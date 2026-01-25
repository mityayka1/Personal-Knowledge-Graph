import { getValidAccessToken, isUnauthorizedError, refreshTokens } from '../utils/auth';

/**
 * API Proxy to PKG Core
 *
 * Authentication strategy:
 * 1. Try JWT token from cookies (for authenticated users)
 * 2. Fall back to API key (for service-to-service or development)
 *
 * Token refresh is handled automatically on 401 responses.
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const path = event.context.params?.path || '';

  console.log(`[API Proxy] Request: ${event.method} /api/${path}`);
  console.log(`[API Proxy] PKG Core URL: ${config.pkgCoreUrl}`);

  // Skip auth proxy for auth endpoints (handled by separate routes)
  if (path.startsWith('auth/')) {
    console.log(`[API Proxy] Auth endpoint, skipping token`);
    return proxyRequest(event, path, config, null);
  }

  // Try to get JWT token for authenticated requests
  const accessToken = await getValidAccessToken(event);
  console.log(`[API Proxy] Has access token: ${!!accessToken}`);

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
  // Build target URL
  const targetUrl = `${config.pkgCoreUrl}/${path}`;
  console.log(`[API Proxy] Target URL: ${targetUrl}`);

  // Get query params
  const query = getQuery(event);

  // Get HTTP method with proper typing
  const method = event.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

  // Build headers - prefer JWT, fallback to API key
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (accessToken) {
    // Use JWT Bearer token
    headers['Authorization'] = `Bearer ${accessToken}`;
  } else if (config.apiKey) {
    // Fallback to API key (for unauthenticated requests or development)
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
    console.log(`[API Proxy] Fetching: ${targetUrl}`);
    const response = await $fetch(targetUrl, {
      ...fetchOptions,
      query,
    });

    console.log(`[API Proxy] Response received, type: ${typeof response}`);
    return response;
  } catch (error: unknown) {
    console.error(`[API Proxy] Fetch error:`, error);
    const fetchError = error as { statusCode?: number; data?: unknown; message?: string };

    // Forward error status and message
    throw createError({
      statusCode: fetchError.statusCode || 500,
      message: fetchError.message || 'API request failed',
      data: fetchError.data,
    });
  }
}
