export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export class LogLevelError extends Error {
  override name = "LogLevelError";
}

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

/** Parse `PULSE_LOG_LEVEL`: unset or empty gives `info`. */
export function parseLogLevel(raw: string | undefined): LogLevel {
  const text = raw?.trim() ?? "";
  if (text === "") return "info";
  const level = LOG_LEVELS.find((l) => l === text);
  if (level === undefined) {
    throw new LogLevelError(
      `PULSE_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, got "${text}"`,
    );
  }
  return level;
}

export interface LoggerDeps {
  level: LogLevel;
  now: () => number;
  /** Receives one JSON line without the newline. */
  write: (line: string, level: LogLevel) => void;
}

/** A JSON-lines logger: `{"time":<ISO 8601>,"level":...,"msg":...,<fields>}`. */
export function createLogger({ level, now, write }: LoggerDeps): Logger {
  const min = LOG_LEVELS.indexOf(level);
  const emit = (at: LogLevel, msg: string, fields: LogFields = {}): void => {
    if (LOG_LEVELS.indexOf(at) < min) return;
    write(JSON.stringify({ time: new Date(now()).toISOString(), level: at, msg, ...fields }), at);
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}
