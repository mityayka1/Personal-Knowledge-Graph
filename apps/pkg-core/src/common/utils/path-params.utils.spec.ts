import {
  extractWildcardPath,
  isArrayParam,
  WildcardParams,
} from './path-params.utils';

describe('path-params.utils', () => {
  describe('extractWildcardPath', () => {
    describe('path-to-regexp v8+ format (array)', () => {
      it('should join array segments with /', () => {
        const params = { path: ['foo', 'bar', 'baz'] };
        expect(extractWildcardPath(params)).toBe('foo/bar/baz');
      });

      it('should handle empty array', () => {
        const params = { path: [] as string[] };
        expect(extractWildcardPath(params)).toBe('');
      });

      it('should handle single segment', () => {
        const params = { path: ['health'] };
        expect(extractWildcardPath(params)).toBe('health');
      });

      it('should handle deep nested paths', () => {
        const params = { path: ['chats', '123', 'messages', '456', 'download'] };
        expect(extractWildcardPath(params)).toBe(
          'chats/123/messages/456/download',
        );
      });
    });

    describe('path-to-regexp v6 format (string)', () => {
      it('should return string as-is', () => {
        const params = { path: 'foo/bar/baz' };
        expect(extractWildcardPath(params)).toBe('foo/bar/baz');
      });

      it('should remove leading slash', () => {
        const params = { path: '/foo/bar' };
        expect(extractWildcardPath(params)).toBe('foo/bar');
      });

      it('should handle empty string', () => {
        const params = { path: '' };
        expect(extractWildcardPath(params)).toBe('');
      });

      it('should handle single segment with leading slash', () => {
        const params = { path: '/health' };
        expect(extractWildcardPath(params)).toBe('health');
      });
    });

    describe('edge cases', () => {
      it('should handle undefined param', () => {
        const params = { other: 'value' };
        expect(extractWildcardPath(params)).toBe('');
      });

      it('should use custom param name', () => {
        const params = { wildcard: ['a', 'b'] };
        expect(extractWildcardPath(params, 'wildcard')).toBe('a/b');
      });

      it('should handle missing param with custom name', () => {
        const params = { path: ['a', 'b'] };
        expect(extractWildcardPath(params, 'notExists')).toBe('');
      });

      it('should handle null-ish values', () => {
        const params: WildcardParams = { path: undefined };
        expect(extractWildcardPath(params)).toBe('');
      });
    });

    describe('real-world scenarios', () => {
      it('should handle telegram proxy path', () => {
        // Route: /internal/telegram/*path → telegram-adapter/api/v1/*
        const params = { path: ['chats', 'channel_123', 'info'] };
        const path = extractWildcardPath(params);
        const targetUrl = `http://telegram-adapter:3001/api/v1/${path}`;
        expect(targetUrl).toBe(
          'http://telegram-adapter:3001/api/v1/chats/channel_123/info',
        );
      });

      it('should handle media download path with query', () => {
        const params = { path: ['media', 'channel_123', '456'] };
        const path = extractWildcardPath(params);
        expect(path).toBe('media/channel_123/456');
      });
    });
  });

  describe('isArrayParam', () => {
    it('should return true for string array', () => {
      expect(isArrayParam(['a', 'b', 'c'])).toBe(true);
    });

    it('should return true for empty array', () => {
      expect(isArrayParam([])).toBe(true);
    });

    it('should return false for string', () => {
      expect(isArrayParam('foo/bar')).toBe(false);
    });

    it('should return false for number array', () => {
      expect(isArrayParam([1, 2, 3])).toBe(false);
    });

    it('should return false for mixed array', () => {
      expect(isArrayParam(['a', 1, 'b'])).toBe(false);
    });

    it('should return false for null', () => {
      expect(isArrayParam(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isArrayParam(undefined)).toBe(false);
    });

    it('should return false for object', () => {
      expect(isArrayParam({ foo: 'bar' })).toBe(false);
    });
  });
});
