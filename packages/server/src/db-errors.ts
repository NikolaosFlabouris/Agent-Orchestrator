/** Helpers for classifying better-sqlite3 errors at route boundaries.
 *
 *  Routes that insert a row with a TOCTOU window between an existence
 *  check and the INSERT use these to convert constraint violations into
 *  friendly 4xx responses instead of letting a 500 leak to the client.
 */

/** True when an exception is any SQLite constraint violation — UNIQUE,
 *  PRIMARY KEY, NOT NULL, CHECK, FOREIGN KEY, etc. better-sqlite3 surfaces
 *  the extended error code as `err.code`, e.g. `SQLITE_CONSTRAINT_UNIQUE`
 *  for a UNIQUE collision and `SQLITE_CONSTRAINT_PRIMARYKEY` for a PK
 *  collision (different codes! — H1).
 *
 *  Previously this only matched `SQLITE_CONSTRAINT_UNIQUE`, which caught
 *  the (provider_id, model_id) composite-UNIQUE race on `models` but
 *  missed the `providers.id`/`agent_profiles.id` PK races because those
 *  tables have `TEXT PRIMARY KEY`, not a UNIQUE constraint. Two
 *  near-simultaneous POSTs of the same id then leaked a 500.
 *
 *  Widening the prefix to `SQLITE_CONSTRAINT_` covers both cases plus
 *  every other constraint-shape SQLite produces. The trade-off: this
 *  also matches FK/NOT NULL/CHECK violations, so callers should ONLY
 *  use it after an explicit existence check on the natural key — the
 *  catch-all interpretation "row with that id already exists" is
 *  appropriate when the race is the only realistic source of a
 *  constraint hit at that line. */
export function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    (err as { code: string }).code.startsWith('SQLITE_CONSTRAINT_')
  );
}
