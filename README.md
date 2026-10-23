# cheminfo-sqlite

[![NPM version](https://img.shields.io/npm/v/cheminfo-sqlite.svg)](https://www.npmjs.com/package/cheminfo-sqlite)
[![npm download](https://img.shields.io/npm/dm/cheminfo-sqlite.svg)](https://www.npmjs.com/package/cheminfo-sqlite)
[![test coverage](https://img.shields.io/codecov/c/github/cheminfo/cheminfo-sqlite.svg)](https://codecov.io/gh/cheminfo/cheminfo-sqlite)
[![license](https://img.shields.io/npm/l/cheminfo-sqlite.svg)](https://github.com/cheminfo/cheminfo-sqlite/blob/main/LICENSE)

The `node:sqlite` plumbing shared by the cheminfo backends: typed and timed statements, the standard pragmas, Postgrator migrations under the write lock, and the slow-query log.

It runs on Node.js 24 or later, whose `node:sqlite` has `setReturnArrays`, `isTransaction` and `location`. Postgrator 8 is a peer dependency.

## Installation

```console
npm install cheminfo-sqlite postgrator
```

## Usage

A service's `DB` class owns the connection, and builds every statement through one `prepare`:

```ts
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  TypedStatementSync,
  applyPragmasWithRetry,
  createSlowQueryLogger,
  migrateWithPostgrator,
  slowQueryLogPath,
} from 'cheminfo-sqlite';

const file = join(dataDirectory, 'sqlite', 'db.sqlite');
mkdirSync(dirname(file), { recursive: true });
const db = new DatabaseSync(file);
await applyPragmasWithRetry(db);
await migrateWithPostgrator(db, {
  migrationPattern: join(import.meta.dirname, 'migrations', '*'),
});

const logSlow = createSlowQueryLogger(slowQueryLogPath(file));
const byId = new TypedStatementSync<{ id: number; idCode: string }>(
  db.prepare('SELECT id, idCode FROM molecules WHERE id = ?'),
  { onTiming: logSlow },
);
const molecule = byId.getRequired(42);
```

A test database is `new DatabaseSync(':memory:')` migrated the same way, with `createSlowQueryLogger(null)`: the pragmas leave it alone and nothing is written to disk.

## API

### `TypedStatementSync<T>`

`new TypedStatementSync<T>(statement, { onTiming?, fromValues? })` wraps a prepared statement so `get`, `getRequired`, `all`, `iterate` and `run` are typed. `getRequired` throws, naming the statement, when nothing matches. `sql` is the statement as prepared.

Every row is returned as a plain object: `node:sqlite` hands back null-prototype rows kept in V8 dictionary mode, about twelve times slower to read and refused by `toStrictEqual`. A statement reading tens of thousands of rows takes `fromValues`, which builds each row from its values and spares the dictionary-mode object altogether.

`onTiming(tag, milliseconds, sql)` is told how long each `get`, `getRequired` and `all` (`'[read]'`) and `run` (`'[write]'`) took. `iterate` is not timed.

### `applyPragmas(db, { cacheMegabytes? })` and `applyPragmasWithRetry(db, options?)`

The pragmas of every on-disk connection:

```sql
PRAGMA busy_timeout = 30000;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = OFF;
PRAGMA cache_size = -131072; -- 128 MB; node:sqlite ships a 2 MB cache
PRAGMA temp_store = MEMORY;
```

An in-memory or temporary database is left as it is. `applyPragmasWithRetry` also waits out another process converting a new file to WAL, which SQLite refuses at once rather than after the busy timeout (`retryAttempts` 50, `retryDelay` 200 ms).

### `migrateWithPostgrator(db, { migrationPattern, schemaTable?, version?, lockTimeout? })`

Runs Postgrator's `NNN.do.sql` / `NNN.undo.sql` scripts in one `BEGIN IMMEDIATE` transaction, so processes opening the file together run them once, and a failure leaves the file as it was.

- A file already at the version takes no lock: the checksums of its migrations are verified and nothing is written.
- The lock is awaited without blocking the event loop, for up to `lockTimeout` (30 s).
- `schemaTable` (`schemaversion`) lets a package keep its own migration record in a file its host also migrates.
- `version` (`'000'`, `'005'`) runs the undo scripts down to it, for the migration tests.
- It returns the migrations it ran.

A migration script must not open a transaction itself, nor run `VACUUM` or `PRAGMA journal_mode`.

### Slow-query log

- `createSlowQueryLogger(logPath, { threshold? })` appends each operation slower than `SLOW_QUERY_THRESHOLD_MS` (10 ms) to the log, one line each: `2026-10-23T10:00:00.000Z 12.3ms [read] SELECT …`. With a `null` path it writes nothing.
- `slowQueryLogPath(databaseFile)` is `slow-queries.log` beside the database file.
- `timed(logSlow, tag, sql, run)` times any other synchronous operation, such as an `exec`.

### `transaction(db, run)`

Runs a synchronous function inside `BEGIN IMMEDIATE`, committed when it returns and rolled back when it throws. Keep it to a few hundred rows: it holds the write lock throughout.

## License

[MIT](./LICENSE)
