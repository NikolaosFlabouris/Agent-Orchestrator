import { describe, it, expect } from 'vitest';
import {
  validateInstallSteps,
  INSTALL_STEP_COMMANDS,
} from '../../install-steps.js';
import { INSTALL_STEP_KINDS } from '@orchestrator/shared';

describe('validateInstallSteps', () => {
  it('returns [] for null/undefined input', () => {
    expect(validateInstallSteps(null, false)).toEqual([]);
    expect(validateInstallSteps(undefined, false)).toEqual([]);
  });

  it('rejects a non-array input', () => {
    expect(() => validateInstallSteps('npm-ci', false)).toThrow(
      /must be an array/
    );
    expect(() => validateInstallSteps({ kind: 'npm-ci' }, false)).toThrow(
      /must be an array/
    );
  });

  it('rejects array entries that are not objects', () => {
    expect(() => validateInstallSteps([null], false)).toThrow(/must be an object/);
    expect(() => validateInstallSteps(['npm-ci'], false)).toThrow(/must be an object/);
  });

  it('rejects a missing or non-string kind', () => {
    expect(() => validateInstallSteps([{}], false)).toThrow(
      /kind must be a string/
    );
    expect(() => validateInstallSteps([{ kind: 42 }], false)).toThrow(
      /kind must be a string/
    );
  });

  it('rejects an unrecognised kind', () => {
    expect(() =>
      validateInstallSteps([{ kind: 'evil-rm-rf' }], false)
    ).toThrow(/is not a recognised step kind/);
  });

  it('accepts every typed (non-script) kind without a cwd', () => {
    for (const kind of INSTALL_STEP_KINDS) {
      const result = validateInstallSteps([{ kind }], false);
      expect(result).toEqual([{ kind }]);
    }
  });

  it('passes through a relative cwd', () => {
    expect(
      validateInstallSteps([{ kind: 'npm-ci', cwd: 'packages/web' }], false)
    ).toEqual([{ kind: 'npm-ci', cwd: 'packages/web' }]);
  });

  it('rejects absolute cwd', () => {
    expect(() =>
      validateInstallSteps([{ kind: 'npm-ci', cwd: '/etc' }], false)
    ).toThrow(/must be relative/);
  });

  it('rejects cwd with .. segments', () => {
    expect(() =>
      validateInstallSteps([{ kind: 'npm-ci', cwd: '../escape' }], false)
    ).toThrow(/must not contain '\.\.'/);
    // Also catches embedded `..` after another segment.
    expect(() =>
      validateInstallSteps([{ kind: 'npm-ci', cwd: 'sub/../etc' }], false)
    ).toThrow(/must not contain '\.\.'/);
  });

  it('rejects cwd traversal via backslash separators (Windows-style paths)', () => {
    expect(() =>
      validateInstallSteps([{ kind: 'npm-ci', cwd: 'sub\\..\\etc' }], false)
    ).toThrow(/must not contain '\.\.'/);
  });

  it('rejects a non-string cwd', () => {
    expect(() =>
      validateInstallSteps([{ kind: 'npm-ci', cwd: 42 }], false)
    ).toThrow(/must be a string/);
  });

  describe('script kind', () => {
    it('rejects script steps when allow_script_steps is false', () => {
      expect(() =>
        validateInstallSteps([{ kind: 'script', path: 'scripts/setup.sh' }], false)
      ).toThrow(/allow_script_steps is false/);
    });

    it('accepts a script step with a relative path when allowed', () => {
      expect(
        validateInstallSteps(
          [{ kind: 'script', path: 'scripts/setup.sh' }],
          true
        )
      ).toEqual([{ kind: 'script', path: 'scripts/setup.sh' }]);
    });

    it('rejects a script step with an empty path even when allowed', () => {
      expect(() =>
        validateInstallSteps([{ kind: 'script', path: '' }], true)
      ).toThrow(/path is required/);
      expect(() =>
        validateInstallSteps([{ kind: 'script' }], true)
      ).toThrow(/path is required/);
    });

    it('rejects script paths that try to escape the repo root', () => {
      expect(() =>
        validateInstallSteps(
          [{ kind: 'script', path: '../scripts/setup.sh' }],
          true
        )
      ).toThrow(/must not contain '\.\.'/);
      expect(() =>
        validateInstallSteps(
          [{ kind: 'script', path: '/etc/setup.sh' }],
          true
        )
      ).toThrow(/must be relative/);
    });

    it('preserves cwd alongside path on script steps', () => {
      expect(
        validateInstallSteps(
          [{ kind: 'script', path: 'scripts/setup.sh', cwd: 'pkgs/api' }],
          true
        )
      ).toEqual([
        { kind: 'script', path: 'scripts/setup.sh', cwd: 'pkgs/api' },
      ]);
    });
  });

  it('reports the offending index in error messages', () => {
    expect(() =>
      validateInstallSteps(
        [
          { kind: 'npm-ci' },
          { kind: 'evil' }, // index 1
        ],
        false
      )
    ).toThrow(/install_steps\[1\]/);
  });
});

describe('INSTALL_STEP_COMMANDS', () => {
  it('has a literal command for every non-script kind', () => {
    for (const kind of INSTALL_STEP_KINDS) {
      const cmd = INSTALL_STEP_COMMANDS[
        kind as keyof typeof INSTALL_STEP_COMMANDS
      ];
      expect(cmd, `missing command for ${kind}`).toBeTypeOf('string');
      expect(cmd.length).toBeGreaterThan(0);
    }
  });

  it('does not contain operator-influenceable variables in any command', () => {
    // The whole point of the typed-kind→literal-command mapping is that
    // operators can never inject a shell command via install_steps —
    // they pick a kind and the command is fixed. Make that guarantee
    // a test invariant: nothing in the table should look like a
    // template placeholder.
    for (const cmd of Object.values(INSTALL_STEP_COMMANDS)) {
      expect(cmd).not.toMatch(/\$\{|\$\(|`/);
    }
  });
});
