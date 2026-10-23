import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { onTestFinished } from 'vitest';

/**
 * A fresh directory, removed once the test ends.
 * @returns its path
 */
export function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cheminfo-sqlite-'));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/**
 * A connection, closed once the test ends.
 * @param path - the file, or `:memory:`
 * @returns the connection
 */
export function openConnection(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  onTestFinished(() => {
    if (db.isOpen) db.close();
  });
  return db;
}

/**
 * The tables and indexes a database holds, SQLite's own left out.
 * @param db - the connection
 * @returns their names, sorted
 */
export function schemaNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  const names: string[] = [];
  for (const row of rows) names.push(row.name);
  return names;
}

/**
 * The value a pragma answers.
 * @param db - the connection
 * @param pragma - its name
 * @returns the value
 */
export function readPragma(db: DatabaseSync, pragma: string): unknown {
  const row = db.prepare(`PRAGMA ${pragma}`).get();
  return row === undefined ? undefined : Object.values(row)[0];
}
