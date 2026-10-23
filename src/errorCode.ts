/** SQLITE_BUSY: another connection holds the lock. */
export const SQLITE_BUSY = 5;

/** SQLITE_LOCKED: a conflict within the same connection's shared cache. */
export const SQLITE_LOCKED = 6;

/**
 * The SQLite result code of an error thrown by `node:sqlite`.
 * @param error - what was thrown
 * @returns its `errcode`, or undefined when it has none
 */
export function errorCode(error: unknown): number | undefined {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' ? code : undefined;
}
