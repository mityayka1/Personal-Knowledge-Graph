/**
 * Media proxy endpoint for Dashboard
 *
 * Architecture: Dashboard -> PKG Core -> Telegram Adapter -> Telegram
 *
 * This endpoint proxies media requests through PKG Core to maintain
 * the Source-Agnostic architecture principle. Dashboard should never
 * directly access Telegram Adapter.
 */
export default defineEventHandler(async (event) => {
  const chatId = getRouterParam(event, 'chatId');
  const messageId = getRouterParam(event, 'messageId');
  const query = getQuery(event);

  if (!chatId || !messageId) {
    throw createError({
      statusCode: 400,
      message: 'chatId and messageId are required',
    });
  }

  const config = useRuntimeConfig();

  // Use PKG Core API (Source-Agnostic architecture)
  // Dashboard should not know about Telegram Adapter directly
  const pkgCoreUrl = config.pkgCoreUrl || config.public?.pkgCoreUrl;

  if (!pkgCoreUrl) {
    console.warn(
      '[Media Proxy] PKG_CORE_URL not configured, using default: http://localhost:3000. ' +
        'Set PKG_CORE_URL environment variable for production.',
    );
  }

  // Note: pkgCoreUrl from config already includes /api/v1 suffix
  const baseUrl = pkgCoreUrl || 'http://localhost:3000/api/v1';

  // Build query string
  const queryParams = new URLSearchParams();
  if (query.size) queryParams.set('size', String(query.size));
  if (query.thumb === 'true') queryParams.set('thumb', 'true');

  // URL encode path segments for safety
  const encodedChatId = encodeURIComponent(chatId);
  const encodedMessageId = encodeURIComponent(messageId);

  const targetUrl = `${baseUrl}/media/${encodedChatId}/${encodedMessageId}?${queryParams.toString()}`;

  // Get API key from config for PKG Core authentication
  const apiKey = config.apiKey;

  try {
    // Use native fetch for binary streaming
    const response = await fetch(targetUrl, {
      headers: {
        ...(apiKey && { 'X-API-Key': apiKey }),
      },
    });

    if (!response.ok) {
      // Log error for debugging
      console.error(`[Media Proxy] Request to ${targetUrl} failed: ${response.status} ${response.statusText}`);

      throw createError({
        statusCode: response.status,
        message: `Media fetch failed: ${response.statusText}`,
      });
    }

    // Forward headers
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    const contentLength = response.headers.get('content-length');
    const contentDisposition = response.headers.get('content-disposition');
    const cacheControl = response.headers.get('cache-control');

    setResponseHeader(event, 'content-type', contentType);

    if (contentLength !== null) {
      const length = Number(contentLength);
      if (!isNaN(length)) {
        setResponseHeader(event, 'content-length', length);
      }
    }

    if (contentDisposition !== null) {
      setResponseHeader(event, 'content-disposition', contentDisposition);
    }

    // Use upstream cache-control or default to 1 hour
    if (cacheControl !== null) {
      setResponseHeader(event, 'cache-control', cacheControl);
    } else {
      setResponseHeader(event, 'cache-control', 'public, max-age=3600');
    }

    // Return the response body as a stream
    return response.body;
  } catch (error: unknown) {
    // Re-throw H3 errors
    if ((error as { statusCode?: number }).statusCode) {
      throw error;
    }

    // Log unexpected errors
    console.error(`[Media Proxy] Failed to fetch media ${chatId}/${messageId}:`, error);

    throw createError({
      statusCode: 500,
      message: `Failed to fetch media: ${(error as Error).message}`,
    });
  }
});
