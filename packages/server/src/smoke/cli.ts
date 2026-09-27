import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_IDS } from '@orchestrator/shared';
import type { HarnessSpec } from '../harnesses/index.js';
import {
  buildCases,
  findUncoveredHarnesses,
  parseBuiltinConfig,
  type SmokeConfigSource,
} from './cases.js';
import { formatSummary, hasFailures, makeRedactor } from './outcome.js';
import { runSmoke, type SmokeDriver } from './runner.js';
import { buildProviderEnv } from '../providers/kinds.js';

// ---------------------------------------------------------------------------
// CLI front end for the harness smoke test (entry point:
// scripts/harness-smoke.ts). Dependencies are injected so the whole flow —
// arguments, coverage rule, exit codes, redaction — is testable without a
// DB file or a Docker daemon.
// ---------------------------------------------------------------------------

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_RUNNER_ERROR = 2;

export const USAGE = `Usage: node packages/server/dist/scripts/harness-smoke.js --image <tag> [options]

Smoke-tests every harness against the agent CLIs in <tag>. Run inside the
orchestrator container (docker exec orchestrator …).

Options:
  --image <tag>              Agent image to test (required)
  --json <path>              Also write the JSON report to <path>
  --config <path>            Built-in cases file (default: the checked-in
                             scripts/harness-smoke.config.json)
  --case-timeout <minutes>   Per live attempt (default 10)
  --overall-timeout <min>    Whole run (default 60)
  --db <path>                Orchestrator DB, opened read-only
                             (default: $DB_PATH or /data/orchestrator.db)

Exit codes: 0 no failures, 1 at least one failure, 2 runner error.`;

export interface CliArgs {
  image: string;
  jsonPath: string | null;
  configPath: string | null;
  caseTimeoutMs: number;
  overallTimeoutMs: number;
  dbPath: string;
}

export class UsageError extends Error {}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const args: CliArgs = {
    image: '',
    jsonPath: null,
    configPath: null,
    caseTimeoutMs: 10 * 60_000,
    overallTimeoutMs: 60 * 60_000,
    dbPath: env.DB_PATH ?? '/data/orchestrator.db',
  };
  const minutes = (flag: string, v: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag} must be a positive number of minutes`);
    return n * 60_000;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') throw new UsageError('');
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`${flag} needs a value`);
    }
    i++;
    switch (flag) {
      case '--image': args.image = value; break;
      case '--json': args.jsonPath = value; break;
      case '--config': args.configPath = value; break;
      case '--case-timeout': args.caseTimeoutMs = minutes(flag, value); break;
      case '--overall-timeout': args.overallTimeoutMs = minutes(flag, value); break;
      case '--db': args.dbPath = value; break;
      default: throw new UsageError(`unknown argument ${flag}`);
    }
  }
  if (!args.image) throw new UsageError('--image is required');
  return args;
}

/** The checked-in config lives in src/ (tsc doesn't copy JSON to dist/);
 *  look next to this module first (tsx/vitest), then in the source tree
 *  from dist/ (the orchestrator image ships both). */
export function defaultConfigPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '../scripts/harness-smoke.config.json'),
    path.join(here, '../../src/scripts/harness-smoke.config.json'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

export interface CliDeps {
  harnesses: HarnessSpec[];
  openConfigSource(dbPath: string): SmokeConfigSource;
  /** Connect to Docker and check the image exists; throw on failure. */
  prepareDocker(image: string): Promise<SmokeDriver>;
  workspacesRoot: string;
  cachesRoot: string;
  stdout(text: string): void;
  stderr(text: string): void;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      if (err.message) deps.stderr(`error: ${err.message}\n\n`);
      deps.stderr(`${USAGE}\n`);
      return err.message ? EXIT_RUNNER_ERROR : EXIT_OK;
    }
    throw err;
  }

  // Runner errors can carry provider data; scrub any credential we can see.
  let redact = makeRedactor([]);
  const runnerError = (msg: string): number => {
    deps.stderr(`runner error: ${redact(msg)}\n`);
    return EXIT_RUNNER_ERROR;
  };

  try {
    const source = deps.openConfigSource(args.dbPath);
    const configPath = args.configPath ?? defaultConfigPath();
    const builtins = parseBuiltinConfig(JSON.parse(await fsp.readFile(configPath, 'utf-8')));
    const cases = buildCases(source, builtins, HARNESS_IDS);
    redact = makeRedactor(
      cases.flatMap((c) => (c.provider ? Object.values(buildProviderEnv(c.provider)) : []))
    );

    const uncovered = findUncoveredHarnesses(
      deps.harnesses.map((h) => h.id),
      cases
    );
    if (uncovered.length > 0) {
      return runnerError(
        `no smoke case for harness(es): ${uncovered.join(', ')}. Add an agent ` +
        `profile or an entry in ${configPath} for each.`
      );
    }

    const driver = await deps.prepareDocker(args.image);
    const report = await runSmoke({
      image: args.image,
      cases,
      harnesses: deps.harnesses,
      driver,
      workspacesRoot: deps.workspacesRoot,
      cachesRoot: deps.cachesRoot,
      caseTimeoutMs: args.caseTimeoutMs,
      overallTimeoutMs: args.overallTimeoutMs,
      progress: (line) => deps.stderr(`${line}\n`),
    });

    // Every field was redacted as it was built; this pass is the backstop.
    const json = redact(JSON.stringify(report, null, 2));
    if (args.jsonPath) await fsp.writeFile(args.jsonPath, `${json}\n`, 'utf-8');
    deps.stdout(`${redact(formatSummary(report))}\n`);
    return hasFailures(report) ? EXIT_FAIL : EXIT_OK;
  } catch (err) {
    return runnerError(err instanceof Error ? err.message : String(err));
  }
}
