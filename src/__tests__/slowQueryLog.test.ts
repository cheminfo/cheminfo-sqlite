import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, onTestFinished, test, vi } from 'vitest';

import {
  SLOW_QUERY_THRESHOLD_MS,
  TypedStatementSync,
  createSlowQueryLogger,
  slowQueryLogPath,
  timed,
} from '../index.ts';

import { openConnection, temporaryDirectory } from './testDatabases.ts';

function fixTheClock() {
  vi.setSystemTime(new Date('2026-10-23T10:00:00.000Z'));
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

test('the threshold is 10 ms', () => {
  expect(SLOW_QUERY_THRESHOLD_MS).toBe(10);
});

test('logs what is slower than the threshold, on one line', () => {
  fixTheClock();
  const logPath = join(temporaryDirectory(), 'slow-queries.log');
  const logSlow = createSlowQueryLogger(logPath);

  logSlow('[read]', 9.99, 'SELECT 1');
  logSlow('[read]', 10, 'SELECT 2');
  logSlow('[read]', 12.34, 'SELECT id\n  FROM molecules\n  WHERE id = ?');
  logSlow('[write]', 250, 'DELETE FROM molecules');

  expect(readFileSync(logPath, 'utf8')).toBe(
    '2026-10-23T10:00:00.000Z 12.3ms [read] SELECT id FROM molecules WHERE id = ?\n' +
      '2026-10-23T10:00:00.000Z 250.0ms [write] DELETE FROM molecules\n',
  );
});

test('takes another threshold', () => {
  fixTheClock();
  const logPath = join(temporaryDirectory(), 'slow-queries.log');
  const logSlow = createSlowQueryLogger(logPath, { threshold: 100 });

  logSlow('[read]', 50, 'SELECT 1');
  logSlow('[read]', 150, 'SELECT 2');

  expect(readFileSync(logPath, 'utf8')).toBe(
    '2026-10-23T10:00:00.000Z 150.0ms [read] SELECT 2\n',
  );
});

test('a logger without a log path writes nothing', () => {
  const folder = temporaryDirectory();
  const logSlow = createSlowQueryLogger(null);

  logSlow('[read]', 5000, 'SELECT 1');

  expect(existsSync(join(folder, 'slow-queries.log'))).toBe(false);
});

test('a statement reports to the logger', () => {
  const logPath = join(temporaryDirectory(), 'slow-queries.log');
  const db = openConnection(':memory:');
  const statement = new TypedStatementSync<{ one: number }>(
    db.prepare('SELECT 1 AS one'),
    { onTiming: createSlowQueryLogger(logPath, { threshold: -1 }) },
  );

  statement.get();

  expect(readFileSync(logPath, 'utf8')).toMatch(
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \d+\.\dms \[read\] SELECT 1 AS one\n$/,
  );
});

test('timed runs the operation and reports how long it took', () => {
  const calls: Array<[string, string]> = [];
  const durations: number[] = [];

  const result = timed(
    (tag, milliseconds, sql) => {
      calls.push([tag, sql]);
      durations.push(milliseconds);
    },
    '[exec]',
    'CREATE TABLE notes (id INTEGER)',
    () => 42,
  );

  expect(result).toBe(42);
  expect(calls).toStrictEqual([['[exec]', 'CREATE TABLE notes (id INTEGER)']]);
  expect(durations).toHaveLength(1);
  expect(durations[0]).toBeGreaterThanOrEqual(0);
});

test('the log sits beside the database file', () => {
  expect(slowQueryLogPath('/app/data/sqlite/db.sqlite')).toBe(
    '/app/data/sqlite/slow-queries.log',
  );
});
