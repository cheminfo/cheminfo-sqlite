import { cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { applyPragmas, migrateWithPostgrator } from '../index.ts';

import {
  openConnection,
  readPragma,
  schemaNames,
  temporaryDirectory,
} from './testDatabases.ts';

const MIGRATIONS = join(import.meta.dirname, 'data', 'migrations');
const migrationPattern = join(MIGRATIONS, '*');
const failingPattern = join(import.meta.dirname, 'data', 'failing', '*');

function recordedVersions(db: DatabaseSync, table = 'schemaversion') {
  const rows = db
    .prepare(`SELECT version FROM ${table} ORDER BY version`)
    .all() as Array<{ version: number }>;
  const versions: number[] = [];
  for (const row of rows) versions.push(row.version);
  return versions;
}

/**
 * Two connections to one new file, both configured as a service opens them.
 * @returns them
 */
function sharedFile() {
  const file = join(temporaryDirectory(), 'db.sqlite');
  const first = openConnection(file);
  applyPragmas(first);
  const second = openConnection(file);
  applyPragmas(second);
  return { first, second };
}

test('runs every migration of a new database, in one go', async () => {
  const db = openConnection(':memory:');

  const applied = await migrateWithPostgrator(db, { migrationPattern });

  expect(applied).toStrictEqual([
    {
      version: 1,
      action: 'do',
      name: '',
      filename: join(MIGRATIONS, '001.do.sql'),
    },
    {
      version: 2,
      action: 'do',
      name: '',
      filename: join(MIGRATIONS, '002.do.sql'),
    },
  ]);
  expect(schemaNames(db)).toStrictEqual([
    'molecules',
    'molecules_idCode',
    'schemaversion',
    'sources',
  ]);
  expect(recordedVersions(db)).toStrictEqual([0, 1, 2]);
  expect(db.isTransaction).toBe(false);
});

test('does nothing on a database already up to date', async () => {
  const db = openConnection(':memory:');
  await migrateWithPostgrator(db, { migrationPattern });

  await expect(
    migrateWithPostgrator(db, { migrationPattern }),
  ).resolves.toStrictEqual([]);
  await expect(
    migrateWithPostgrator(db, { migrationPattern, version: 'max' }),
  ).resolves.toStrictEqual([]);
  expect(recordedVersions(db)).toStrictEqual([0, 1, 2]);
});

test('runs the undo scripts down to a version', async () => {
  const db = openConnection(':memory:');
  await migrateWithPostgrator(db, { migrationPattern });

  const undone = await migrateWithPostgrator(db, {
    migrationPattern,
    version: '001',
  });

  expect(undone).toStrictEqual([
    {
      version: 2,
      action: 'undo',
      name: '',
      filename: join(MIGRATIONS, '002.undo.sql'),
    },
  ]);
  expect(schemaNames(db)).toStrictEqual(['molecules', 'schemaversion']);
  await expect(
    migrateWithPostgrator(db, { migrationPattern, version: '001' }),
  ).resolves.toStrictEqual([]);

  await migrateWithPostgrator(db, { migrationPattern, version: '000' });

  expect(schemaNames(db)).toStrictEqual(['schemaversion']);
  expect(recordedVersions(db)).toStrictEqual([0]);
});

test('records the migrations in the schema table it is given', async () => {
  const db = openConnection(':memory:');

  await migrateWithPostgrator(db, {
    migrationPattern,
    schemaTable: 'service_test_version',
  });

  expect(schemaNames(db)).toStrictEqual([
    'molecules',
    'molecules_idCode',
    'service_test_version',
    'sources',
  ]);
  expect(recordedVersions(db, 'service_test_version')).toStrictEqual([0, 1, 2]);
});

test('a failing migration leaves the file as it was', async () => {
  const db = openConnection(':memory:');

  await expect(
    migrateWithPostgrator(db, { migrationPattern: failingPattern }),
  ).rejects.toThrow('no such table: missing');

  expect(schemaNames(db)).toStrictEqual([]);
  expect(db.isTransaction).toBe(false);
});

test('refuses a file whose applied migration was edited since', async () => {
  const folder = temporaryDirectory();
  cpSync(MIGRATIONS, folder, { recursive: true });
  const db = openConnection(':memory:');
  await migrateWithPostgrator(db, { migrationPattern: join(folder, '*') });

  writeFileSync(
    join(folder, '001.do.sql'),
    'CREATE TABLE molecules (id INTEGER PRIMARY KEY);\n',
  );

  await expect(
    migrateWithPostgrator(db, { migrationPattern: join(folder, '*') }),
  ).rejects.toThrow('MD5 checksum failed for migration [1]');
});

test('waits for another connection to stop writing', async () => {
  const { first, second } = sharedFile();
  first.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY)');
  first.exec('BEGIN IMMEDIATE');
  first.exec('INSERT INTO notes (id) VALUES (1)');
  setTimeout(() => first.exec('COMMIT'), 50);

  const applied = await migrateWithPostgrator(second, { migrationPattern });

  expect(applied).toHaveLength(2);
  expect(recordedVersions(first)).toStrictEqual([0, 1, 2]);
  expect(readPragma(second, 'busy_timeout')).toBe(30_000);
});

test('gives up when the lock is still held after lockTimeout', async () => {
  const { first, second } = sharedFile();
  first.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY)');
  first.exec('BEGIN IMMEDIATE');
  first.exec('INSERT INTO notes (id) VALUES (1)');

  await expect(
    migrateWithPostgrator(second, { migrationPattern, lockTimeout: 50 }),
  ).rejects.toMatchObject({ errcode: 5, message: 'database is locked' });

  first.exec('COMMIT');

  expect(schemaNames(second)).toStrictEqual(['notes']);
  expect(readPragma(second, 'busy_timeout')).toBe(30_000);
});

test('two processes migrating at once run the migrations once', async () => {
  const { first, second } = sharedFile();

  const [firstApplied, secondApplied] = await Promise.all([
    migrateWithPostgrator(first, { migrationPattern }),
    migrateWithPostgrator(second, { migrationPattern }),
  ]);

  expect(
    [firstApplied.length, secondApplied.length].toSorted(
      (left, right) => left - right,
    ),
  ).toStrictEqual([0, 2]);
  expect(recordedVersions(second)).toStrictEqual([0, 1, 2]);
});

test('refuses a connection already inside a transaction', async () => {
  const db = openConnection(':memory:');
  db.exec('PRAGMA busy_timeout = 1234');
  db.exec('BEGIN');

  await expect(migrateWithPostgrator(db, { migrationPattern })).rejects.toThrow(
    'cannot start a transaction within a transaction',
  );

  expect(db.isTransaction).toBe(true);
  expect(readPragma(db, 'busy_timeout')).toBe(1234);

  db.exec('ROLLBACK');

  expect(schemaNames(db)).toStrictEqual([]);
});
