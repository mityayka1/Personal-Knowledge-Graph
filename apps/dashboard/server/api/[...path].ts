export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const path = event.context.params?.path || '';

  // Build target URL
  const targetUrl = `${config.pkgCoreUrl}/${path}`;

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
      ...(config.apiKey && { 'X-API-Key': config.apiKey }),
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
      message: fetchError.message || 'API request failed',
      data: fetchError.data,
    });
  }
});
