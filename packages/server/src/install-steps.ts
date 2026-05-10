import { INSTALL_STEP_KINDS, type InstallStep } from '@orchestrator/shared';

const SAFE_KINDS = new Set<string>(INSTALL_STEP_KINDS);

/** Validate a relative path within /repo. Rejects absolute paths, parent
 *  refs (`..` segments), and non-string inputs. Returns the trimmed value
 *  if valid; throws otherwise. Empty string is allowed and treated as `/repo` root. */
function validateRelativePath(value: unknown, field: string): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.startsWith('/')) {
    throw new Error(`${field} must be relative (no leading '/')`);
  }
  const segments = trimmed.split(/[\\/]/);
  if (segments.includes('..')) {
    throw new Error(`${field} must not contain '..'`);
  }
  return trimmed;
}

/** Validate the JSON-decoded install_steps array submitted from the UI.
 *  Throws on the first issue with a human-readable message; the route
 *  handler converts that into a 400. */
export function validateInstallSteps(
  raw: unknown,
  allowScriptSteps: boolean
): InstallStep[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error('install_steps must be an array');
  }
  const out: InstallStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    const step = raw[i];
    if (!step || typeof step !== 'object') {
      throw new Error(`install_steps[${i}] must be an object`);
    }
    const s = step as Record<string, unknown>;
    const kind = s.kind;
    if (typeof kind !== 'string') {
      throw new Error(`install_steps[${i}].kind must be a string`);
    }
    const cwd = validateRelativePath(s.cwd, `install_steps[${i}].cwd`);
    if (kind === 'script') {
      if (!allowScriptSteps) {
        throw new Error(
          `install_steps[${i}] uses kind 'script' but this repo's allow_script_steps is false. Toggle it on under Settings → Repositories first.`
        );
      }
      const path = validateRelativePath(s.path, `install_steps[${i}].path`);
      if (!path) {
        throw new Error(`install_steps[${i}].path is required for script steps`);
      }
      out.push({ kind: 'script', path, ...(cwd ? { cwd } : {}) });
    } else if (SAFE_KINDS.has(kind)) {
      out.push({
        kind: kind as Exclude<InstallStep, { kind: 'script' }>['kind'],
        ...(cwd ? { cwd } : {}),
      });
    } else {
      throw new Error(
        `install_steps[${i}].kind '${kind}' is not a recognised step kind`
      );
    }
  }
  return out;
}

/** Hardcoded mapping from typed kind to the literal command string. The
 *  harness builds the actual exec'd command from this table — operators
 *  cannot influence the command string, only which entry runs and where. */
export const INSTALL_STEP_COMMANDS: Record<
  Exclude<InstallStep, { kind: 'script' }>['kind'],
  string
> = {
  'npm-ci': 'npm ci',
  'npm-install': 'npm install',
  'yarn-install': 'yarn install',
  'pnpm-install': 'pnpm install',
  'pip-requirements': 'pip install -r requirements.txt',
  'pip-pyproject': 'pip install -e .',
  'uv-sync': 'uv sync',
  'cargo-fetch': 'cargo fetch',
  'go-mod-download': 'go mod download',
};
