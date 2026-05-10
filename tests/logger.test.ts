import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../src/logger';

describe('createLogger', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should create a logger with all log levels', () => {
    const log = createLogger('test');
    expect(log.debug).toBeDefined();
    expect(log.info).toBeDefined();
    expect(log.warn).toBeDefined();
    expect(log.error).toBeDefined();
  });

  it('should output structured JSON for error logs', () => {
    const log = createLogger('test');
    log.error('something went wrong');

    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    const raw = consoleErrorSpy.mock.calls[0][0] as string;
    const output = JSON.parse(raw);
    expect(output.level).toBe('error');
    expect(output.module).toBe('test');
    expect(output.message).toBe('something went wrong');
    expect(output.timestamp).toBeDefined();
  });

  it('should output structured JSON for warn logs', () => {
    const log = createLogger('api');
    log.warn('deprecated call');

    expect(consoleWarnSpy).toHaveBeenCalledOnce();
    const raw = consoleWarnSpy.mock.calls[0][0] as string;
    const output = JSON.parse(raw);
    expect(output.level).toBe('warn');
    expect(output.module).toBe('api');
  });

  it('should serialize Error objects in extra fields', () => {
    const log = createLogger('bot');
    const err = new Error('test error');
    log.error('operation failed', { error: err });

    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    const raw = consoleErrorSpy.mock.calls[0][0] as string;
    const output = JSON.parse(raw);
    expect(typeof output.error).toBe('string');
    expect(output.error as string).toContain('test error');
  });

  it('should include extra fields in log entry', () => {
    const log = createLogger('db');
    log.error('query failed', { operation: 'getStats', duration: 500 });

    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    const raw = consoleErrorSpy.mock.calls[0][0] as string;
    const output = JSON.parse(raw);
    expect(output.operation).toBe('getStats');
    expect(output.duration).toBe(500);
  });

  it('should serialize non-Error values in error field', () => {
    const log = createLogger('test');
    log.error('failed', { error: 'string error' });

    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    const raw = consoleErrorSpy.mock.calls[0][0] as string;
    const output = JSON.parse(raw);
    expect(output.error).toBe('string error');
  });
});
