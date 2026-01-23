/**
 * Common utilities for bot handlers
 */

/**
 * Check if error is a timeout-related error
 */
export function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.message.includes('timeout') ||
      error.message.includes('ETIMEDOUT') ||
      error.message.includes('ECONNABORTED')
    );
  }
  return false;
}

/**
 * Convert Markdown to Telegram HTML format.
 * Supports: bold, italic, code, links, headers, list items.
 */
export function markdownToTelegramHtml(text: string): string {
  return (
    text
      // Remove backslash escapes first
      .replace(/\\([_*\[\]()~`>#+\-=|{}.!])/g, '$1')
      // Headers -> bold with emoji
      .replace(/^### (.+)$/gm, '📌 <b>$1</b>')
      .replace(/^## (.+)$/gm, '\n📋 <b>$1</b>')
      .replace(/^# (.+)$/gm, '\n🔷 <b>$1</b>')
      // Bold: **text** -> <b>text</b>
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      // Italic: *text* or _text_ -> <i>text</i>
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<i>$1</i>')
      .replace(/_(.+?)_/g, '<i>$1</i>')
      // Inline code: `code` -> <code>code</code>
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // Links: [text](url) -> <a href="url">text</a>
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      // List items: - text -> * text
      .replace(/^- /gm, '• ')
      // Clean up multiple newlines
      .replace(/\n{3,}/g, '\n\n')
  );
}

/**
 * Truncate text to specified length with ellipsis
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}
