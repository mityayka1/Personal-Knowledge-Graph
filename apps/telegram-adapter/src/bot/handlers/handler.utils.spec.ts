import { isTimeoutError, markdownToTelegramHtml, truncate } from './handler.utils';

describe('handler.utils', () => {
  describe('isTimeoutError', () => {
    it('should return true for ETIMEDOUT', () => {
      expect(isTimeoutError(new Error('ETIMEDOUT'))).toBe(true);
    });

    it('should return true for timeout keyword', () => {
      expect(isTimeoutError(new Error('Request timeout'))).toBe(true);
    });

    it('should return true for ECONNABORTED', () => {
      expect(isTimeoutError(new Error('ECONNABORTED'))).toBe(true);
    });

    it('should return true for mixed case timeout', () => {
      expect(isTimeoutError(new Error('Connection ETIMEDOUT after 30s'))).toBe(true);
    });

    it('should return false for network error', () => {
      expect(isTimeoutError(new Error('Network error'))).toBe(false);
    });

    it('should return false for connection refused', () => {
      expect(isTimeoutError(new Error('ECONNREFUSED'))).toBe(false);
    });

    it('should return false for non-Error objects', () => {
      expect(isTimeoutError('timeout')).toBe(false);
      expect(isTimeoutError({ message: 'timeout' })).toBe(false);
      expect(isTimeoutError(null)).toBe(false);
      expect(isTimeoutError(undefined)).toBe(false);
    });
  });

  describe('markdownToTelegramHtml', () => {
    it('should convert bold **text** to <b>text</b>', () => {
      expect(markdownToTelegramHtml('Hello **world**')).toBe('Hello <b>world</b>');
    });

    it('should convert italic *text* to <i>text</i>', () => {
      expect(markdownToTelegramHtml('Hello *world*')).toBe('Hello <i>world</i>');
    });

    it('should convert italic _text_ to <i>text</i>', () => {
      expect(markdownToTelegramHtml('Hello _world_')).toBe('Hello <i>world</i>');
    });

    it('should convert inline code `code` to <code>code</code>', () => {
      expect(markdownToTelegramHtml('Use `npm install`')).toBe('Use <code>npm install</code>');
    });

    it('should convert links [text](url) to <a href="url">text</a>', () => {
      expect(markdownToTelegramHtml('Visit [Google](https://google.com)')).toBe(
        'Visit <a href="https://google.com">Google</a>',
      );
    });

    it('should convert list items - to bullets', () => {
      expect(markdownToTelegramHtml('- Item 1\n- Item 2')).toBe('• Item 1\n• Item 2');
    });

    it('should convert h1 headers', () => {
      expect(markdownToTelegramHtml('# Header')).toContain('<b>Header</b>');
    });

    it('should convert h2 headers', () => {
      expect(markdownToTelegramHtml('## Header')).toContain('<b>Header</b>');
    });

    it('should convert h3 headers', () => {
      expect(markdownToTelegramHtml('### Header')).toContain('<b>Header</b>');
    });

    it('should remove backslash escapes', () => {
      // Note: After removing backslash, *text* still matches italic pattern
      // This tests that the backslash itself is removed
      expect(markdownToTelegramHtml('Hello \\[link\\]')).toBe('Hello [link]');
    });

    it('should collapse multiple newlines', () => {
      expect(markdownToTelegramHtml('Line1\n\n\n\nLine2')).toBe('Line1\n\nLine2');
    });

    it('should handle complex markdown', () => {
      const input = '## Title\n\n**Bold** and *italic* text\n- Item 1\n- Item 2';
      const result = markdownToTelegramHtml(input);
      expect(result).toContain('<b>Title</b>');
      expect(result).toContain('<b>Bold</b>');
      expect(result).toContain('<i>italic</i>');
      expect(result).toContain('• Item 1');
    });
  });

  describe('truncate', () => {
    it('should return original text if shorter than maxLength', () => {
      expect(truncate('Hello', 10)).toBe('Hello');
    });

    it('should return original text if equal to maxLength', () => {
      expect(truncate('Hello', 5)).toBe('Hello');
    });

    it('should truncate and add ellipsis if longer than maxLength', () => {
      expect(truncate('Hello World', 8)).toBe('Hello...');
    });

    it('should handle empty string', () => {
      expect(truncate('', 10)).toBe('');
    });

    it('should handle maxLength of 3 (minimum for ellipsis)', () => {
      expect(truncate('Hello', 3)).toBe('...');
    });
  });
});
