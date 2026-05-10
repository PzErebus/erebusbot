type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel = 'info';

function serializeError(err: unknown): string | undefined {
  if (err instanceof Error) return err.stack || err.message;
  if (err !== undefined && err !== null) return String(err);
  return undefined;
}

export function createLogger(module: string) {
  function log(level: LogLevel, message: string, extra?: Record<string, unknown>) {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[currentLevel]) return;

    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      module,
      message,
    };

    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        entry[key] = key === 'error' ? serializeError(value) : value;
      }
    }

    const output = JSON.stringify(entry);

    if (level === 'error') {
      console.error(output);
    } else if (level === 'warn') {
      console.warn(output);
    } else {
      console.log(output);
    }
  }

  return {
    debug(message: string, extra?: Record<string, unknown>) { log('debug', message, extra); },
    info(message: string, extra?: Record<string, unknown>) { log('info', message, extra); },
    warn(message: string, extra?: Record<string, unknown>) { log('warn', message, extra); },
    error(message: string, extra?: Record<string, unknown>) { log('error', message, extra); },
  };
}
