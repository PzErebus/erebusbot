// 简单的内存缓存实现

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const NEGATIVE_CACHE_SENTINEL = Symbol('NEGATIVE_CACHE');

export class MemoryCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private defaultTTL: number;
  private lastCleanup = Date.now();
  private readonly CLEANUP_INTERVAL = 120000;
  private setCount = 0;
  private readonly CLEANUP_SET_THRESHOLD = 100;
  private readonly MAX_CACHE_SIZE = 2000;

  constructor(defaultTTLSeconds = 60) {
    this.defaultTTL = defaultTTLSeconds * 1000;
  }

  private maybeCleanup() {
    const now = Date.now();
    if (now - this.lastCleanup < this.CLEANUP_INTERVAL && this.setCount < this.CLEANUP_SET_THRESHOLD) return;
    this.lastCleanup = now;
    this.setCount = 0;
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlSeconds?: number): void {
    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      this.maybeCleanup();
      if (this.cache.size >= this.MAX_CACHE_SIZE) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey !== undefined) this.cache.delete(firstKey);
      }
    }
    const ttl = (ttlSeconds ?? this.defaultTTL / 1000) * 1000;
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttl
    });
    this.setCount++;
    this.maybeCleanup();
  }

  setNegative(key: string, ttlSeconds: number = 30): void {
    this.set(key, NEGATIVE_CACHE_SENTINEL, ttlSeconds);
  }

  isNegative(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }
    return entry.value === NEGATIVE_CACHE_SENTINEL;
  }

  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  getOrSet<T>(key: string, factory: () => Promise<T>, ttlSeconds?: number): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }

    return factory().then(value => {
      this.set(key, value, ttlSeconds);
      return value;
    });
  }
}
