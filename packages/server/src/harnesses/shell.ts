/** Shell-quote helpers for building `agent_command` strings.
 *
 *  The agent container runs `bash -c "$AGENT_COMMAND"` (see
 *  `harness/harness-cli.sh`), so any value interpolated into the command
 *  string is subject to shell metacharacter interpretation. Most values
 *  that flow in here (model id, file paths) are derived from operator-
 *  controlled DB rows. We treat all of them as untrusted and wrap in
 *  single quotes, escaping any embedded single quote with the standard
 *  `'\''` sequence.
 *
 *  Use `sq()` for any value that ends up in an `agent_command` string.
 *  Numeric values that have been integer-validated (e.g. `max_turns`)
 *  can be inlined without quoting since `Number.isInteger` guarantees
 *  no shell metacharacters. */

/** Single-quote-wrap a value for safe shell interpolation.
 *  `foo bar` -> `'foo bar'`
 *  `it's fine` -> `'it'\''s fine'` */
export function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
