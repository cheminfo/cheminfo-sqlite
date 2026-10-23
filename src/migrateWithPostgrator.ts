import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

import Postgrator from 'postgrator';

import { SQLITE_BUSY, SQLITE_LOCKED, errorCode } from './errorCode.ts';

/** Which migrations to run, and how long to wait for the file. */
export interface MigrateOptions {
  /**
   * The migration files, as a glob: `join(import.meta.dirname, 'migrations',
   * '*')` for a folder of matched `NNN.do.sql` / `NNN.undo.sql` pairs.
   */
  migrationPattern: string;
  /**
   * The table the applied migrations are recorded in. A package keeping its
   * own tables in a file it shares with its host gives them a table of their
   * own, so the host migrates its tables under the default one.
   * @default 'schemaversion'
   */
  schemaTable?: string;
  /**
   * The version to end at, as Postgrator takes it: `'005'`, or `'000'` to run
   * every undo script. A version below the file's runs the undo scripts down
   * to it.
   * @default undefined — the latest version
   */
  version?: string;
  /**
   * How long to wait for another connection's write to end, in ms. Raise it
   * when the processes sharing the file may have to wait for a long migration
   * of another one, such as an index built over millions of rows.
   * @default 30000
   */
  lockTimeout?: number;
}

/** A migration that was run. */
export interface AppliedMigration {
  /** Its number. */
  version: number;
  /** Whether its do or its undo script was run. */
  action: 'do' | 'undo';
  /** What follows the action in its file name, if anything. */
  name: string;
  /** Its file. */
  filename: string;
}

/**
 * Bring a `node:sqlite` database to a schema version with Postgrator, in one
 * transaction: several processes opening the file at once wait for one another,
 * and the ones that lose the race find every migration recorded and have
 * nothing left to do.
 *
 * A file already at the version takes no lock at all: the checksums of its
 * applied migrations are verified, and nothing is written. Otherwise the write
 * lock is awaited rather than waited for: Postgrator reads its files between
 * statements, and a connection of this same process blocking the event loop on
 * the lock would keep the one holding it from ever finishing.
 *
 * A migration script must not open a transaction of its own, nor run what
 * SQLite refuses inside one (`VACUUM`, `PRAGMA journal_mode`).
 * @param db - the connection to migrate
 * @param options - the migration files, the version and the lock timeout
 * @returns the migrations run, in the order they ran; none when the file was
 * already at the version
 * @throws {Error} When a migration fails, which leaves the file as it was; when
 * an applied migration's file changed since it ran; or when the lock is still
 * held after `lockTimeout`.
 */
export async function migrateWithPostgrator(
  db: DatabaseSync,
  options: MigrateOptions,
): Promise<AppliedMigration[]> {
  const {
    migrationPattern,
    schemaTable = 'schemaversion',
    version,
    lockTimeout = 30_000,
  } = options;
  const postgrator = new Postgrator({
    migrationPattern,
    driver: 'sqlite3',
    schemaTable,
    execQuery: (query: string) =>
      Promise.resolve({ rows: db.prepare(query).all() }),
    execSqlScript: (script: string) => {
      db.exec(script);
      return Promise.resolve();
    },
  });

  const databaseVersion = await postgrator.getDatabaseVersion();
  const latest = version === undefined || version.toLowerCase() === 'max';
  const targetVersion = latest
    ? await postgrator.getMaxVersion()
    : Number(version);
  const isCurrent = latest
    ? databaseVersion >= targetVersion
    : databaseVersion === targetVersion;
  if (isCurrent) {
    await postgrator.validateMigrations(databaseVersion);
    return [];
  }

  await beginImmediate(db, lockTimeout);
  try {
    // Postgrator reads the version again, under the lock: another process may
    // have run the migrations since.
    const migrations = await postgrator.migrate(version);
    db.exec('COMMIT');
    const applied: AppliedMigration[] = [];
    for (const migration of migrations) {
      applied.push({
        version: migration.version,
        action: migration.action,
        name: migration.name,
        filename: migration.filename,
      });
    }
    return applied;
  } catch (error: unknown) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Begin a write transaction, retrying while another connection writes,
 * without blocking the event loop.
 * @param db - the connection
 * @param timeout - how long to keep trying, in ms
 */
async function beginImmediate(db: DatabaseSync, timeout: number) {
  const { timeout: busyTimeout } = db.prepare('PRAGMA busy_timeout').get() as {
    timeout: number;
  };
  db.exec('PRAGMA busy_timeout = 0');
  try {
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        db.exec('BEGIN IMMEDIATE');
        return;
      } catch (error: unknown) {
        const code = errorCode(error);
        const busy = code === SQLITE_BUSY || code === SQLITE_LOCKED;
        if (!busy || Date.now() > deadline) throw error;
      }
      // eslint-disable-next-line no-await-in-loop -- waiting for the other writer is the point
      await delay(20);
    }
  } finally {
    db.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
  }
}
