import type { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { transaction } from '../index.ts';

import { openConnection } from './testDatabases.ts';

function notesDatabase(): DatabaseSync {
  const db = openConnection(':memory:');
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)');
  return db;
}

function noteIds(db: DatabaseSync): number[] {
  const rows = db.prepare('SELECT id FROM notes ORDER BY id').all() as Array<{
    id: number;
  }>;
  const ids: number[] = [];
  for (const row of rows) ids.push(row.id);
  return ids;
}

test('commits and returns what the function returned', () => {
  const db = notesDatabase();
  const insert = db.prepare('INSERT INTO notes (id, text) VALUES (?, ?)');

  const result = transaction(db, () => {
    expect(db.isTransaction).toBe(true);

    insert.run(1, 'first');
    insert.run(2, 'second');
    return 'done';
  });

  expect(result).toBe('done');
  expect(db.isTransaction).toBe(false);
  expect(noteIds(db)).toStrictEqual([1, 2]);
});

test('rolls back and rethrows when the function throws', () => {
  const db = notesDatabase();
  const insert = db.prepare('INSERT INTO notes (id, text) VALUES (?, ?)');

  expect(() =>
    transaction(db, () => {
      insert.run(1, 'first');
      insert.run(1, 'again');
    }),
  ).toThrow('UNIQUE constraint failed: notes.id');

  expect(db.isTransaction).toBe(false);
  expect(noteIds(db)).toStrictEqual([]);
});

test('keeps the error when the transaction has already ended', () => {
  const db = notesDatabase();

  expect(() =>
    transaction(db, () => {
      db.exec('ROLLBACK');
      throw new Error('the work failed');
    }),
  ).toThrow('the work failed');
});
