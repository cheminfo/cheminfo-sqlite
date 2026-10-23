import type { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { TypedStatementSync } from '../index.ts';

import { openConnection } from './testDatabases.ts';

interface MoleculeRow {
  id: number;
  idCode: string;
}

function moleculesDatabase(): DatabaseSync {
  const db = openConnection(':memory:');
  db.exec(
    'CREATE TABLE molecules (id INTEGER PRIMARY KEY, idCode TEXT NOT NULL)',
  );
  const insert = db.prepare('INSERT INTO molecules (id, idCode) VALUES (?, ?)');
  insert.run(1, 'gC`@Dij@@');
  insert.run(2, 'gGQ@@eKtrAkDH');
  insert.run(3, 'fHdP@');
  return db;
}

test('get returns the first row as a plain object', () => {
  const db = moleculesDatabase();
  const statement = new TypedStatementSync<MoleculeRow>(
    db.prepare('SELECT id, idCode FROM molecules WHERE id = ?'),
  );

  const row = statement.get(2);

  expect(row).toStrictEqual({ id: 2, idCode: 'gGQ@@eKtrAkDH' });
  expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
  expect(statement.get(4)).toBeUndefined();
});

test('get binds named parameters', () => {
  const db = moleculesDatabase();
  const statement = new TypedStatementSync<MoleculeRow>(
    db.prepare('SELECT id, idCode FROM molecules WHERE id = :id'),
  );

  expect(statement.get({ id: 3 })).toStrictEqual({ id: 3, idCode: 'fHdP@' });
});

test('getRequired throws a clear error when nothing matches', () => {
  const db = moleculesDatabase();
  const statement = new TypedStatementSync<MoleculeRow>(
    db.prepare(`SELECT id, idCode
                FROM molecules
                WHERE id = ?`),
  );

  expect(statement.getRequired(1)).toStrictEqual({
    id: 1,
    idCode: 'gC`@Dij@@',
  });
  expect(() => statement.getRequired(9)).toThrow(
    'expected a row but found none: SELECT id, idCode FROM molecules WHERE id = ?',
  );
});

test('all returns every row as a plain object, in order', () => {
  const db = moleculesDatabase();
  const statement = new TypedStatementSync<MoleculeRow>(
    db.prepare('SELECT id, idCode FROM molecules WHERE id >= ? ORDER BY id'),
  );

  const rows = statement.all(2);

  expect(rows).toStrictEqual([
    { id: 2, idCode: 'gGQ@@eKtrAkDH' },
    { id: 3, idCode: 'fHdP@' },
  ]);
  expect(Object.getPrototypeOf(rows[0])).toBe(Object.prototype);
});

test('iterate yields plain rows and stops when the caller stops', () => {
  const db = moleculesDatabase();
  const statement = new TypedStatementSync<{ id: number }>(
    db.prepare('SELECT id FROM molecules ORDER BY id'),
  );

  const read: Array<{ id: number }> = [];
  for (const row of statement.iterate()) {
    read.push(row);
    if (row.id === 2) break;
  }

  expect(read).toStrictEqual([{ id: 1 }, { id: 2 }]);
});

test('run reports the changes and the last row id', () => {
  const db = moleculesDatabase();
  const statement = new TypedStatementSync(
    db.prepare('INSERT INTO molecules (idCode) VALUES (?)'),
  );

  expect(statement.run('eF@Hp')).toStrictEqual({
    changes: 1,
    lastInsertRowid: 4,
  });
});

test('fromValues builds each row from its values', () => {
  const db = moleculesDatabase();
  const statement = new TypedStatementSync<MoleculeRow>(
    db.prepare('SELECT id, idCode FROM molecules WHERE id <= ? ORDER BY id'),
    {
      fromValues: (values) => ({
        id: values[0] as number,
        idCode: values[1] as string,
      }),
    },
  );

  expect(statement.get(1)).toStrictEqual({ id: 1, idCode: 'gC`@Dij@@' });
  expect(statement.all(2)).toStrictEqual([
    { id: 1, idCode: 'gC`@Dij@@' },
    { id: 2, idCode: 'gGQ@@eKtrAkDH' },
  ]);
  expect([...statement.iterate(1)]).toStrictEqual([
    { id: 1, idCode: 'gC`@Dij@@' },
  ]);
});

test('sql is the statement as it was prepared', () => {
  const db = moleculesDatabase();
  const statement = new TypedStatementSync(
    db.prepare('SELECT count(*) AS count FROM molecules'),
  );

  expect(statement.sql).toBe('SELECT count(*) AS count FROM molecules');
});

test('onTiming is told about every get, all and run, but not iterate', () => {
  const db = moleculesDatabase();
  const calls: Array<[string, string]> = [];
  const durations: number[] = [];
  const onTiming = (tag: string, milliseconds: number, sql: string) => {
    calls.push([tag, sql]);
    durations.push(milliseconds);
  };
  const select = new TypedStatementSync<MoleculeRow>(
    db.prepare('SELECT id, idCode FROM molecules WHERE id = ?'),
    { onTiming },
  );
  const insert = new TypedStatementSync(
    db.prepare('INSERT INTO molecules (idCode) VALUES (?)'),
    { onTiming },
  );

  select.get(1);
  select.getRequired(2);
  select.all(3);

  expect([...select.iterate(1)]).toStrictEqual([
    { id: 1, idCode: 'gC`@Dij@@' },
  ]);

  insert.run('eF@Hp');

  const selectSql = 'SELECT id, idCode FROM molecules WHERE id = ?';

  expect(calls).toStrictEqual([
    ['[read]', selectSql],
    ['[read]', selectSql],
    ['[read]', selectSql],
    ['[write]', 'INSERT INTO molecules (idCode) VALUES (?)'],
  ]);
  expect(Math.min(...durations)).toBeGreaterThanOrEqual(0);
});
