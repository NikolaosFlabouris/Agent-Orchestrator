import { describe, it, expect } from 'vitest';
import { sq } from '../../harnesses/shell.js';
import { execSync } from 'node:child_process';

/** Pathological-input contract tests for `sq()`. The function is the
 *  defence-in-depth layer that protects every harness `agent_command`
 *  string against shell-metacharacter smuggling from operator-supplied
 *  DB rows (model ids, base URLs, file paths). Worth pinning the
 *  contract so a well-intentioned refactor can't loosen the quoting.
 */

describe('sq() shell-quoting', () => {
  it('wraps a plain string in single quotes', () => {
    expect(sq('foo')).toBe("'foo'");
  });

  it('handles strings with spaces by quoting once around the whole value', () => {
    expect(sq('hello world')).toBe("'hello world'");
  });

  it("escapes embedded single quotes via the '\\'' close-reopen sequence", () => {
    // Standard POSIX trick: there is no escape character inside single
    // quotes, so an embedded ' becomes '\''  — close, escape, reopen.
    expect(sq("it's")).toBe("'it'\\''s'");
    expect(sq("a'b")).toBe("'a'\\''b'");
  });

  it('handles consecutive single quotes', () => {
    expect(sq("a''b")).toBe("'a'\\'''\\''b'");
  });

  it('passes through shell metacharacters that are harmless inside single quotes', () => {
    // $, `, \\, &, |, ;, > etc. lose their special meaning inside ''
    // — sq() doesn't need to escape them, just contain them.
    expect(sq('$(rm -rf /)')).toBe("'$(rm -rf /)'");
    expect(sq('`whoami`')).toBe("'`whoami`'");
    expect(sq('a; rm -rf / #')).toBe("'a; rm -rf / #'");
    expect(sq('|cat /etc/passwd')).toBe("'|cat /etc/passwd'");
  });

  it('handles empty string', () => {
    expect(sq('')).toBe("''");
  });

  it('handles a single-quote-only input', () => {
    expect(sq("'")).toBe("''\\'''");
  });

  // Round-trip via a real shell (where available). Confirms the produced
  // value is exactly one literal argument, regardless of metacharacters.
  it('round-trips through a real shell as a single literal argument', () => {
    // Skip on platforms without /bin/sh — Windows test runners.
    if (process.platform === 'win32') return;
    const pathological = [
      'plain',
      'with spaces',
      "with ' single quote",
      '$(whoami)',
      '`hostname`',
      '`whoami` $(id) | tee /tmp/x; #',
      '\\\\backslashes\\\\',
      '"double" \'single\'',
    ];
    for (const input of pathological) {
      // printf %s emits the arg verbatim. If sq() leaks any metachar,
      // the printed value diverges from the input.
      const printed = execSync(`/bin/sh -c "printf %s ${sq(input)}"`, {
        encoding: 'utf-8',
      });
      expect(printed).toBe(input);
    }
  });
});
