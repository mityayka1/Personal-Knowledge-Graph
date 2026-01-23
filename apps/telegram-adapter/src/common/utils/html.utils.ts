/**
 * HTML utilities for safe content rendering in Telegram messages.
 *
 * IMPORTANT: Use these functions instead of local implementations to ensure
 * consistent HTML encoding across the entire codebase.
 */

/**
 * Escapes HTML special characters to prevent XSS attacks and Telegram parse errors.
 *
 * Encodes: & < > " '
 *
 * @param text - Raw text to escape
 * @returns HTML-safe text
 *
 * @example
 * escapeHtml('<script>alert("xss")</script>')
 * // Returns: '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sanitizes URL to allow only safe protocols.
 * Returns null if URL has disallowed protocol.
 *
 * Default allowed protocols: https://, tg://
 *
 * @param url - URL to sanitize
 * @param allowedProtocols - List of allowed protocols (default: ['https://', 'tg://'])
 * @returns Sanitized URL or null if protocol is not allowed
 *
 * @example
 * sanitizeUrl('https://example.com')
 * // Returns: 'https://example.com'
 *
 * sanitizeUrl('javascript:alert(1)')
 * // Returns: null
 *
 * sanitizeUrl('tg://user?id=123')
 * // Returns: 'tg://user?id=123'
 */
export function sanitizeUrl(
  url: string,
  allowedProtocols: string[] = ['https://', 'tg://'],
): string | null {
  if (!allowedProtocols.some((protocol) => url.startsWith(protocol))) {
    return null;
  }
  // Escape quotes to prevent attribute injection
  return url.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
