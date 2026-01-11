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
  const telegramAdapterUrl = config.telegramAdapterUrl || 'http://localhost:3001';

  // Build query string
  const queryParams = new URLSearchParams();
  if (query.size) queryParams.set('size', String(query.size));
  if (query.thumb === 'true') queryParams.set('thumb', 'true');

  const targetUrl = `${telegramAdapterUrl}/api/v1/chats/${chatId}/messages/${messageId}/download?${queryParams.toString()}`;

  try {
    // Use native fetch for binary streaming
    const response = await fetch(targetUrl);

    if (!response.ok) {
      throw createError({
        statusCode: response.status,
        message: `Media fetch failed: ${response.statusText}`,
      });
    }

    // Forward headers
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    const contentLength = response.headers.get('content-length');
    const contentDisposition = response.headers.get('content-disposition');

    setResponseHeader(event, 'content-type', contentType);
    if (contentLength !== null) {
      setResponseHeader(event, 'content-length', parseInt(contentLength, 10));
    }
    if (contentDisposition !== null) {
      setResponseHeader(event, 'content-disposition', contentDisposition);
    }

    // Cache media for 1 hour
    setResponseHeader(event, 'cache-control', 'public, max-age=3600');

    // Return the response body as a stream
    return response.body;
  } catch (error: unknown) {
    if ((error as { statusCode?: number }).statusCode) {
      throw error;
    }
    throw createError({
      statusCode: 500,
      message: `Failed to fetch media: ${(error as Error).message}`,
    });
  }
});
