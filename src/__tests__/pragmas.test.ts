import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import {
  BUSY_TIMEOUT,
  CACHE_MEGABYTES,
  applyPragmas,
  applyPragmasWithRetry,
} from '../index.ts';

import {
  openConnection,
  readPragma,
  temporaryDirectory,
} from './testDatabases.ts';

function readPragmas(db: DatabaseSync) {
  return {
    busyTimeout: readPragma(db, 'busy_timeout'),
    journalMode: readPragma(db, 'journal_mode'),
    synchronous: readPragma(db, 'synchronous'),
    cacheSize: readPragma(db, 'cache_size'),
    tempStore: readPragma(db, 'temp_store'),
  };
}

/**
 * Two connections to a new file, the first holding the write lock with a
 * write pending, so the second cannot switch the file to WAL.
 * @returns both connections
 */
function lockedFile() {
  const file = join(temporaryDirectory(), 'db.sqlite');
  const holder = openConnection(file);
  holder.exec('CREATE TABLE molecules (id INTEGER PRIMARY KEY)');
  holder.exec('BEGIN IMMEDIATE');
  holder.exec('INSERT INTO molecules (id) VALUES (1)');
  return { holder, db: openConnection(file) };
}

test('the defaults are the standard block', () => {
  expect(BUSY_TIMEOUT).toBe(30_000);
  expect(CACHE_MEGABYTES).toBe(128);
});

test('applyPragmas configures an on-disk connection', () => {
  const db = openConnection(join(temporaryDirectory(), 'db.sqlite'));

  applyPragmas(db);

  expect(readPragmas(db)).toStrictEqual({
    busyTimeout: 30_000,
    journalMode: 'wal',
    synchronous: 0,
    cacheSize: -131_072,
    tempStore: 2,
  });
});

test('applyPragmas takes another page cache', () => {
  const db = openConnection(join(temporaryDirectory(), 'db.sqlite'));

  applyPragmas(db, { cacheMegabytes: 16 });

  expect(readPragma(db, 'cache_size')).toBe(-16_384);
});

test('applyPragmas leaves an in-memory connection as it is', () => {
  const db = openConnection(':memory:');

  applyPragmas(db);

  expect(readPragmas(db)).toStrictEqual({
    busyTimeout: 0,
    journalMode: 'memory',
    synchronous: 2,
    cacheSize: -2000,
    tempStore: 0,
  });
});

test('switching to WAL fails at once while another connection writes', () => {
  const { db } = lockedFile();

  expect(() => applyPragmas(db)).toThrow('database is locked');
});

test('applyPragmasWithRetry waits for the other connection to commit', async () => {
  const { holder, db } = lockedFile();
  setTimeout(() => holder.exec('COMMIT'), 50);

  await applyPragmasWithRetry(db, { retryDelay: 10 });

  expect(readPragma(db, 'journal_mode')).toBe('wal');
  expect(readPragma(db, 'cache_size')).toBe(-131_072);
});

test('applyPragmasWithRetry gives up after its attempts', async () => {
  const { holder, db } = lockedFile();

  await expect(
    applyPragmasWithRetry(db, { retryAttempts: 3, retryDelay: 5 }),
  ).rejects.toMatchObject({ errcode: 5, message: 'database is locked' });

  holder.exec('COMMIT');

  expect(readPragma(db, 'journal_mode')).toBe('delete');
});

test('applyPragmasWithRetry throws any other error at once', async () => {
  const db = openConnection(':memory:');
  db.close();

  await expect(applyPragmasWithRetry(db)).rejects.toThrow(
    'database is not open',
  );
});
