import type {
  SQLInputValue,
  SQLOutputValue,
  StatementResultingChanges,
  StatementSync,
} from 'node:sqlite';

/**
 * The parameters of a statement: values bound to its placeholders in order,
 * or an object binding its named parameters, optionally followed by
 * positional ones. `node:sqlite` checks the names when the statement runs, so
 * any object shape is accepted here, interfaces included.
 */
export type StatementParameters =
  | SQLInputValue[]
  | [namedParameters: object, ...anonymousParameters: SQLInputValue[]];

/**
 * Called after a statement ran, with what it did, how long it took and its
 * SQL: `'[read]'` for `get` and `all`, `'[write]'` for `run`. A
 * `SlowQueryLogger` is one.
 */
export type TimingSink = (
  tag: string,
  milliseconds: number,
  sql: string,
) => void;

/** Builds a row from its values, in the order the statement selects them. */
export type RowFromValues<T> = (values: SQLOutputValue[]) => T;

/** How a statement is timed and how its rows are built. */
export interface TypedStatementOptions<T> {
  /**
   * Told how long every `get`, `getRequired`, `all` and `run` took.
   * @default undefined — nothing is timed
   */
  onTiming?: TimingSink;
  /**
   * Builds each row from its values. The statement is then switched to return
   * arrays, so `node:sqlite` never builds its dictionary-mode object: give it
   * to a statement that reads tens of thousands of rows.
   * @default undefined — each row is copied from the object `node:sqlite`
   * returns
   */
  fromValues?: RowFromValues<T>;
}

/**
 * A `node:sqlite` prepared statement whose rows have a known shape, so no call
 * site has to cast `Record<string, SQLOutputValue>`.
 *
 * Every row it returns is a plain object. `node:sqlite` hands back
 * null-prototype rows whose properties stay in V8 dictionary mode: each read
 * costs about twelve times a normal one, and `toStrictEqual` refuses them. So
 * `get`, `getRequired`, `all` and `iterate` copy each row into a plain object,
 * which costs about 0.5 ms per 1000 rows of four columns, or build it with
 * `fromValues` when that is given.
 */
export class TypedStatementSync<T extends object> {
  readonly #statement: StatementSync;
  readonly #sql: string;
  readonly #onTiming: TimingSink | undefined;
  readonly #fromValues: RowFromValues<T> | undefined;

  /**
   * Wrap a prepared statement.
   * @param statement - what `DatabaseSync.prepare` returned
   * @param options - how it is timed and how its rows are built
   */
  constructor(
    statement: StatementSync,
    options: TypedStatementOptions<T> = {},
  ) {
    this.#statement = statement;
    this.#sql = statement.sourceSQL;
    this.#onTiming = options.onTiming;
    this.#fromValues = options.fromValues;
    if (options.fromValues !== undefined) statement.setReturnArrays(true);
  }

  /**
   * The SQL the statement was prepared from, to read its query plan.
   * @returns it, as written
   */
  get sql(): string {
    return this.#sql;
  }

  /**
   * Run the statement and return its first row.
   * @param parameters - the statement's parameters
   * @returns the row, or undefined when the query matched nothing
   */
  get(...parameters: StatementParameters): T | undefined {
    const start = performance.now();
    const row = this.#statement.get(...(parameters as SQLInputValue[]));
    this.#onTiming?.('[read]', performance.now() - start, this.#sql);
    return row === undefined ? undefined : this.#rowOf(row);
  }

  /**
   * Run the statement and return its first row, throwing when there is none.
   * @param parameters - the statement's parameters
   * @returns the row
   * @throws {Error} When the query matched nothing, naming the statement.
   */
  getRequired(...parameters: StatementParameters): T {
    const row = this.get(...parameters);
    if (row === undefined) {
      throw new Error(
        `expected a row but found none: ${this.#sql.replaceAll(/\s+/g, ' ')}`,
      );
    }
    return row;
  }

  /**
   * Run the statement and return every row.
   * @param parameters - the statement's parameters
   * @returns the rows, in the order the query produced them
   */
  all(...parameters: StatementParameters): T[] {
    const start = performance.now();
    const rows = this.#statement.all(...(parameters as SQLInputValue[]));
    this.#onTiming?.('[read]', performance.now() - start, this.#sql);
    const result = new Array<T>(rows.length);
    for (let index = 0; index < rows.length; index++) {
      result[index] = this.#rowOf(rows[index] as object);
    }
    return result;
  }

  /**
   * Run the statement and read its rows one at a time, so a caller that has
   * enough can stop before SQLite has produced the rest. Not timed: the time
   * between two rows is the caller's, not the query's.
   * @param parameters - the statement's parameters
   * @yields {T} each row, in the order the query produces them
   */
  *iterate(...parameters: StatementParameters): Generator<T> {
    for (const row of this.#statement.iterate(
      ...(parameters as SQLInputValue[]),
    )) {
      yield this.#rowOf(row);
    }
  }

  /**
   * Run the statement for its side effect.
   * @param parameters - the statement's parameters
   * @returns the number of rows changed and the last inserted row id
   */
  run(...parameters: StatementParameters): StatementResultingChanges {
    const start = performance.now();
    const result = this.#statement.run(...(parameters as SQLInputValue[]));
    this.#onTiming?.('[write]', performance.now() - start, this.#sql);
    return result;
  }

  #rowOf(row: object): T {
    return this.#fromValues === undefined
      ? ({ ...row } as T)
      : this.#fromValues(row as SQLOutputValue[]);
  }
}
