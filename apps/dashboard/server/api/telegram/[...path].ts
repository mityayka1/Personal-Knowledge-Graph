export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const path = event.context.params?.path || '';

  // Telegram adapter URL (default to localhost:3001)
  const telegramAdapterUrl = process.env.TELEGRAM_ADAPTER_URL || 'http://localhost:3001';
  const targetUrl = `${telegramAdapterUrl}/api/v1/${path}`;

  // Get query params
  const query = getQuery(event);

  // Get HTTP method with proper typing
  const method = event.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

  // Build fetch options
  const fetchOptions: {
    method: typeof method;
    headers: Record<string, string>;
    body?: string;
  } = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
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
      message: fetchError.message || 'Telegram adapter request failed',
      data: fetchError.data,
    });
  }
});
