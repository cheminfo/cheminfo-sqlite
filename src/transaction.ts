import type { DatabaseSync } from 'node:sqlite';

/**
 * Run a function inside one `BEGIN IMMEDIATE` transaction, committed when it
 * returns and rolled back when it throws.
 *
 * It holds the write lock for as long as the function runs: keep the function
 * short, a few hundred rows at most, and split a bulk write into chunks with
 * the event loop yielded between them. The function must be synchronous: a
 * promise it returns is committed before it settles.
 * @param db - the connection
 * @param run - the work to do
 * @returns what the function returned
 * @throws {Error} What the function threw, after the rollback.
 */
export function transaction<R>(db: DatabaseSync, run: () => R): R {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error: unknown) {
    // SQLite has already rolled back after some errors (a full disk, an
    // interrupt), and a second ROLLBACK would hide the first error.
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
