import { escapeHtml, sanitizeUrl } from './html.utils';

describe('escapeHtml', () => {
  it('should escape less than sign', () => {
    expect(escapeHtml('<')).toBe('&lt;');
  });

  it('should escape greater than sign', () => {
    expect(escapeHtml('>')).toBe('&gt;');
  });

  it('should escape ampersand', () => {
    expect(escapeHtml('&')).toBe('&amp;');
  });

  it('should escape double quotes', () => {
    expect(escapeHtml('"')).toBe('&quot;');
  });

  it('should escape single quotes', () => {
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('should handle empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('should handle string without special characters', () => {
    expect(escapeHtml('Hello World')).toBe('Hello World');
  });

  it('should escape multiple special characters', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('should escape complex HTML with all special chars', () => {
    expect(escapeHtml("<a href='test'>O'Brien & Co</a>")).toBe(
      "&lt;a href=&#39;test&#39;&gt;O&#39;Brien &amp; Co&lt;/a&gt;",
    );
  });
});

describe('sanitizeUrl', () => {
  it('should allow https:// URLs', () => {
    expect(sanitizeUrl('https://example.com')).toBe('https://example.com');
  });

  it('should allow tg:// URLs', () => {
    expect(sanitizeUrl('tg://user?id=123')).toBe('tg://user?id=123');
  });

  it('should block javascript: URLs', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBeNull();
  });

  it('should block http:// URLs by default', () => {
    expect(sanitizeUrl('http://example.com')).toBeNull();
  });

  it('should block data: URLs', () => {
    expect(sanitizeUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('should block file:// URLs', () => {
    expect(sanitizeUrl('file:///etc/passwd')).toBeNull();
  });

  it('should escape quotes in URLs', () => {
    expect(sanitizeUrl('https://example.com?q="test"')).toBe(
      'https://example.com?q=&quot;test&quot;',
    );
  });

  it('should escape single quotes in URLs', () => {
    expect(sanitizeUrl("https://example.com?q='test'")).toBe(
      "https://example.com?q=&#39;test&#39;",
    );
  });

  it('should allow custom protocols', () => {
    expect(sanitizeUrl('http://example.com', ['http://', 'https://'])).toBe(
      'http://example.com',
    );
  });

  it('should block URLs not in allowed protocols', () => {
    expect(sanitizeUrl('ftp://example.com', ['http://', 'https://'])).toBeNull();
  });
});
