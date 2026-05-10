import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryCache } from '../src/cache';

describe('MemoryCache', () => {
  let cache: MemoryCache;

  beforeEach(() => {
    cache = new MemoryCache(60);
  });

  it('should store and retrieve values', () => {
    cache.set('key1', 'value1');
    expect(cache.get('key1')).toBe('value1');
  });

  it('should return undefined for missing keys', () => {
    expect(cache.get('nonexistent')).toBeUndefined();
  });

  it('should respect custom TTL and expire entries', () => {
    cache.set('short', 'data', 1);
    expect(cache.get('short')).toBe('data');

    return new Promise<void>(resolve => {
      setTimeout(() => {
        expect(cache.get('short')).toBeUndefined();
        resolve();
      }, 1100);
    });
  });

  it('should overwrite existing keys', () => {
    cache.set('key', 'v1');
    cache.set('key', 'v2');
    expect(cache.get('key')).toBe('v2');
  });

  it('should handle different value types', () => {
    cache.set('num', 42);
    cache.set('obj', { a: 1 });
    cache.set('arr', [1, 2, 3]);
    cache.set('bool', true);
    expect(cache.get('num')).toBe(42);
    expect(cache.get('obj')).toEqual({ a: 1 });
    expect(cache.get('arr')).toEqual([1, 2, 3]);
    expect(cache.get('bool')).toBe(true);
  });

  it('should delete entries', () => {
    cache.set('key', 'value');
    cache.delete('key');
    expect(cache.get('key')).toBeUndefined();
  });

  it('should handle delete on non-existent key gracefully', () => {
    expect(() => cache.delete('nonexistent')).not.toThrow();
  });

  it('should clean up expired entries periodically', () => {
    cache.set('temp', 'data', 0);
    cache.set('permanent', 'data', 3600);
    cache.set('trigger', 'cleanup', 3600);

    expect(cache.get('permanent')).toBe('data');
  });
});
