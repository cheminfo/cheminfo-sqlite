import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** An operation slower than this, in ms, is written to the slow-query log. */
export const SLOW_QUERY_THRESHOLD_MS = 10;

/**
 * Told how long an operation took. Writes it to the slow-query log when it
 * took longer than the threshold, and does nothing otherwise.
 */
export type SlowQueryLogger = (
  tag: string,
  milliseconds: number,
  sql: string,
) => void;

/** How slow an operation must be to be logged. */
export interface SlowQueryLoggerOptions {
  /**
   * The duration above which an operation is logged, in ms. Raise it only for a
   * deliberately write-heavy service, and say why where it is set.
   * @default 10
   */
  threshold?: number;
}

/**
 * The logger of a database's slow operations: each one slower than the
 * threshold is appended to the log as a line holding the instant, the
 * duration, the tag and the SQL on one line, as in
 * `2026-10-23T10:00:00.000Z 12.3ms [read] SELECT * FROM molecules WHERE id = ?`.
 * @param logPath - the log file, `slowQueryLogPath(databaseFile)`; null for an
 * in-memory or test database, whose logger never writes anything
 * @param options - the threshold
 * @returns the logger, to hand to `TypedStatementSync` as its `onTiming`
 */
export function createSlowQueryLogger(
  logPath: string | null,
  options: SlowQueryLoggerOptions = {},
): SlowQueryLogger {
  const { threshold = SLOW_QUERY_THRESHOLD_MS } = options;
  if (logPath === null) return () => undefined;
  return (tag, milliseconds, sql) => {
    if (milliseconds > threshold) {
      const line = `${new Date().toISOString()} ${milliseconds.toFixed(1)}ms ${tag} ${sql.replaceAll(/\s+/g, ' ')}\n`;
      appendFileSync(logPath, line);
    }
  };
}

/**
 * Run a synchronous operation and tell the logger how long it took. For what
 * is not a prepared statement: a script run with `exec`, a bulk import, a
 * statistics pass.
 * @param logSlow - the logger
 * @param tag - what the operation is, e.g. `'[exec]'`
 * @param sql - the SQL, or a description of the operation
 * @param run - the operation; a promise it returns is not awaited, so time an
 * asynchronous operation around its `await` instead
 * @returns what the operation returned
 */
export function timed<R>(
  logSlow: SlowQueryLogger,
  tag: string,
  sql: string,
  run: () => R,
): R {
  const start = performance.now();
  const result = run();
  logSlow(tag, performance.now() - start, sql);
  return result;
}

/**
 * Where the slow operations of a database are logged: `slow-queries.log`
 * beside the database file.
 * @param databaseFile - the database path
 * @returns the log path
 */
export function slowQueryLogPath(databaseFile: string): string {
  return join(dirname(databaseFile), 'slow-queries.log');
}
