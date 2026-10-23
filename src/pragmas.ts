import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

import { SQLITE_BUSY, errorCode } from './errorCode.ts';

/** How long a statement waits for the write lock before giving up, in ms. */
export const BUSY_TIMEOUT = 30_000;

/** The page cache of a connection, in MB. */
export const CACHE_MEGABYTES = 128;

/** How a connection is configured. */
export interface PragmaOptions {
  /**
   * The page cache, in MB. `node:sqlite` ships SQLite's stock 2 MB one.
   * @default 128
   */
  cacheMegabytes?: number;
}

/** How long `applyPragmasWithRetry` waits for the file to be free. */
export interface PragmaRetryOptions extends PragmaOptions {
  /**
   * How many times the pragmas are tried.
   * @default 50
   */
  retryAttempts?: number;
  /**
   * The wait between two tries, in ms.
   * @default 200
   */
  retryDelay?: number;
}

/**
 * Apply the pragmas every on-disk connection needs: a 30 s busy timeout, the
 * write-ahead log, no fsync (the data of our services can be rebuilt), a
 * 128 MB page cache and temporary tables in memory.
 *
 * A connection to an in-memory or temporary database is left as it is: WAL is
 * silently ignored there, and a test database needs none of it.
 * @param db - the connection to configure
 * @param options - the page cache
 */
export function applyPragmas(
  db: DatabaseSync,
  options: PragmaOptions = {},
): void {
  if (!db.location()) return;
  const { cacheMegabytes = CACHE_MEGABYTES } = options;
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT}`);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = OFF');
  db.exec(`PRAGMA cache_size = ${-Math.round(cacheMegabytes * 1024)}`);
  db.exec('PRAGMA temp_store = MEMORY');
}

/**
 * Apply the pragmas, waiting out the lock of another connection converting the
 * file to WAL. SQLite answers that conversion's SQLITE_BUSY at once rather
 * than after the busy timeout, so when several processes open a new file
 * together, those that lose the race retry instead of dying.
 * @param db - the connection to configure
 * @param options - the page cache, and how long to keep trying
 * @throws {Error} The last SQLITE_BUSY once every attempt failed, or at once
 * any other error.
 */
export async function applyPragmasWithRetry(
  db: DatabaseSync,
  options: PragmaRetryOptions = {},
): Promise<void> {
  const { retryAttempts = 50, retryDelay = 200 } = options;
  for (let attempt = 1; ; attempt++) {
    try {
      applyPragmas(db, options);
      return;
    } catch (error: unknown) {
      if (errorCode(error) !== SQLITE_BUSY || attempt >= retryAttempts) {
        throw error;
      }
    }
    // eslint-disable-next-line no-await-in-loop -- waiting out the lock is the point
    await delay(retryDelay);
  }
}
