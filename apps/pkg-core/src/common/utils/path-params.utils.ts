/**
 * Utilities for handling route path parameters.
 *
 * These utilities handle the breaking changes in path-to-regexp v8+
 * where wildcard params return arrays instead of strings.
 *
 * @see https://github.com/pillarjs/path-to-regexp/blob/master/History.md#800--2024-06-09
 */

/**
 * Extract path from wildcard route param.
 * Handles both path-to-regexp v6 (string) and v8+ (array) formats.
 *
 * @example
 * // Route: @All('*path')
 * const path = extractWildcardPath(req.params, 'path');
 *
 * // v6 format: "/foo/bar" → "foo/bar"
 * // v8 format: ["foo", "bar"] → "foo/bar"
 *
 * @param params - The route params object (req.params)
 * @param paramName - The name of the wildcard param (default: 'path')
 * @returns The path as a string, with segments joined by '/'
 */
export function extractWildcardPath(
  params: Record<string, string | string[] | undefined>,
  paramName: string = 'path',
): string {
  const raw = params[paramName];

  if (Array.isArray(raw)) {
    // path-to-regexp v8+ format: ["foo", "bar", "baz"]
    return raw.join('/');
  }

  if (typeof raw === 'string') {
    // path-to-regexp v6 format: "/foo/bar/baz" or "foo/bar/baz"
    return raw.startsWith('/') ? raw.slice(1) : raw;
  }

  return '';
}

/**
 * Type guard for path-to-regexp v8 array params.
 *
 * @example
 * if (isArrayParam(req.params.path)) {
 *   // TypeScript knows it's string[]
 *   const joined = req.params.path.join('/');
 * }
 */
export function isArrayParam(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Type for wildcard route params that handles both v6 and v8+ formats.
 * Use this when typing req.params in wildcard routes.
 *
 * @example
 * @All('*path')
 * async handler(@Req() req: Request & { params: WildcardParams }) {
 *   const path = extractWildcardPath(req.params);
 * }
 */
export type WildcardParams<T extends string = 'path'> = {
  [K in T]?: string | string[];
};
