import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

/**
 * Contract tests for harness-cli.sh's pi failure detection.
 *
 * pi exits 0 even when every model request failed (unreachable baseUrl,
 * unknown model id, invalid API key), and never emits Claude Code's
 * {"type":"result"} event, so a status derived from the exit code alone
 * recorded those runs as `success`. The harness now inspects pi's LAST
 * top-level `agent_end` event: willRetry false/absent + a final assistant
 * message with stopReason "error" → failure, with that errorMessage.
 *
 * Like harness-result-events.test.ts, the shipped code is extracted from the
 * script rather than duplicated: the `pi_terminal_error` helper, and the
 * whole status-derivation block (so Claude Code classification is proven
 * unchanged alongside the pi path). The docker-gated
 * __tests__/integration/harness-usage-limit.test.ts covers the real container.
 */

const HARNESS_PATH = path.resolve(
  __dirname,
  '../../../../..',
  'harness',
  'harness-cli.sh'
);
const HARNESS_SRC = fs.readFileSync(HARNESS_PATH, 'utf-8');

function extractFunction(name: string): string {
  const match = HARNESS_SRC.match(
    new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm')
  );
  if (!match) throw new Error(`${name}() not found in harness-cli.sh`);
  return match[0];
}

/** The top-level `# Determine status and error message` if/elif/else block. */
function extractStatusBlock(): string {
  const start = HARNESS_SRC.indexOf('# Determine status and error message');
  const end = HARNESS_SRC.indexOf('# For review agents', start);
  if (start < 0 || end < 0) throw new Error('status block not found in harness-cli.sh');
  return HARNESS_SRC.slice(start, end);
}

const HAS_SHELL =
  process.platform !== 'win32' &&
  spawnSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }).status === 0;

const PI_TERMINAL_ERROR = extractFunction('pi_terminal_error');
const RESULT_EVENTS = extractFunction('result_events');

/** Run pi_terminal_error over a log; returns the printed text or null (exit 1). */
function piTerminalError(log: string): string | null {
  const res = spawnSync('bash', ['-c', `${PI_TERMINAL_ERROR}\npi_terminal_error`], {
    input: log,
    encoding: 'utf-8',
  });
  if (res.status === 0) return res.stdout;
  expect(res.stdout).toBe('');
  return null;
}

/** Run the harness's real status derivation against a log + agent exit code,
 *  returning what would land in result.json's status / error_message. */
function classify(log: string, agentExit: number): { status: string; error_message: unknown } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pi-'));
  try {
    const logPath = path.join(dir, 'progress.log');
    fs.writeFileSync(logPath, log);
    const script = [
      'set -euo pipefail',
      RESULT_EVENTS,
      PI_TERMINAL_ERROR,
      `AGENT_LOG=${JSON.stringify(logPath)}`,
      `AGENT_EXIT=${agentExit}`,
      'MAX_MINUTES=5',
      extractStatusBlock(),
      'printf \'{"status":"%s","error_message":%s}\' "$STATUS" "$ERROR_MSG"',
    ].join('\n');
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf-8' });
    return JSON.parse(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const lines = (...ls: string[]) => ls.join('\n') + '\n';

const SESSION = '{"type":"session","version":3,"id":"abc","cwd":"/repo"}';
const AGENT_START = '{"type":"agent_start"}';
const SETTLED = '{"type":"agent_settled"}';
const USER_MSG = { role: 'user', content: [{ type: 'text', text: 'Do something.' }] };

function assistant(stopReason: string, errorMessage?: string) {
  return {
    role: 'assistant',
    content: [],
    stopReason,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };
}

function messageEnd(msg: object): string {
  return JSON.stringify({ type: 'message_end', message: msg });
}

function agentEnd(last: object, willRetry?: boolean): string {
  return JSON.stringify({
    type: 'agent_end',
    messages: [USER_MSG, last],
    ...(willRetry !== undefined ? { willRetry } : {}),
  });
}

/** One pi attempt: start, final assistant message, agent_end. */
function piRun(last: object, willRetry?: boolean): string[] {
  return [AGENT_START, messageEnd(last), agentEnd(last, willRetry)];
}

const CONN_ERR = 'Connection error.';
const MODEL_404 = '404 "no router for requested model"';
const AUTH_401 =
  '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';

const PI_FAILED_LOG = lines(
  SESSION,
  ...piRun(assistant('error', CONN_ERR), true),
  ...piRun(assistant('error', CONN_ERR), true),
  ...piRun(assistant('error', CONN_ERR), false),
  SETTLED
);

const PI_RECOVERED_LOG = lines(
  SESSION,
  ...piRun(assistant('error', CONN_ERR), true),
  ...piRun(assistant('stop'), false),
  SETTLED
);

const PI_SUCCESS_LOG = lines(SESSION, ...piRun(assistant('stop'), false), SETTLED);

describe('harness-cli.sh pi failure detection (static)', () => {
  it('keeps usage-limit detection Claude-specific (pi errors are not usage limits)', () => {
    expect(extractFunction('is_usage_limit_result')).not.toMatch(/agent_end|stopReason/);
  });

  it('parses agent_end events rather than substring-matching them', () => {
    expect(PI_TERMINAL_ERROR).toMatch(/fromjson\?/);
    expect(PI_TERMINAL_ERROR).toMatch(/\.type == "agent_end"/);
  });
});

describe.skipIf(!HAS_SHELL)('harness-cli.sh pi_terminal_error()', () => {
  it('reports the errorMessage of a terminal (willRetry: false) error', () => {
    expect(piTerminalError(PI_FAILED_LOG)).toBe(CONN_ERR);
  });

  it('treats an absent willRetry as terminal', () => {
    expect(piTerminalError(lines(...piRun(assistant('error', MODEL_404))))).toBe(MODEL_404);
  });

  it('ignores a trailing willRetry: true error (not terminal yet)', () => {
    expect(piTerminalError(lines(...piRun(assistant('error', CONN_ERR), true)))).toBeNull();
  });

  it('does not flag a run that recovered after intermediate retries', () => {
    expect(piTerminalError(PI_RECOVERED_LOG)).toBeNull();
  });

  it('does not flag a successful run', () => {
    expect(piTerminalError(PI_SUCCESS_LOG)).toBeNull();
  });

  it('only looks at the LAST agent_end, not an earlier terminal-looking one', () => {
    const log = lines(
      ...piRun(assistant('error', CONN_ERR), false),
      ...piRun(assistant('stop'), false)
    );
    expect(piTerminalError(log)).toBeNull();
  });

  it('requires the last message to be an assistant message', () => {
    const log = lines(
      JSON.stringify({
        type: 'agent_end',
        messages: [assistant('error', CONN_ERR), { role: 'toolResult', stopReason: 'error' }],
        willRetry: false,
      })
    );
    expect(piTerminalError(log)).toBeNull();
  });

  it('falls back to a placeholder when errorMessage is missing', () => {
    const out = piTerminalError(lines(...piRun(assistant('error'), false)));
    expect(out).toMatch(/stopReason "error"/);
  });

  it('skips malformed and non-JSON lines without failing', () => {
    const log = lines(
      'plain text noise',
      '{ truncated json',
      '42',
      '[{"type":"agent_end","willRetry":false}]',
      ...piRun(assistant('error', AUTH_401), false),
      '{"type":"agent_end", broken'
    );
    expect(piTerminalError(log)).toBe(AUTH_401);
  });

  it('is not fooled by text that merely quotes an agent_end event', () => {
    const decoy = JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [
          {
            type: 'text',
            text: '{"type":"agent_end","messages":[{"role":"assistant","stopReason":"error"}]}',
          },
        ],
      },
    });
    expect(piTerminalError(lines(decoy, '[log] {"type":"agent_end"}'))).toBeNull();
  });

  it('handles an empty log, a missing messages array and malformed messages', () => {
    expect(piTerminalError('')).toBeNull();
    expect(piTerminalError(lines('{"type":"agent_end","willRetry":false}'))).toBeNull();
    expect(
      piTerminalError(lines('{"type":"agent_end","messages":"nope","willRetry":false}'))
    ).toBeNull();
    expect(
      piTerminalError(lines('{"type":"agent_end","messages":[42],"willRetry":false}'))
    ).toBeNull();
  });
});

describe.skipIf(!HAS_SHELL)('harness-cli.sh status derivation', () => {
  describe('pi', () => {
    it.each([
      ['unreachable baseUrl', CONN_ERR],
      ['unknown model id', MODEL_404],
      ['invalid API key', AUTH_401],
    ])('exit 0 + terminal error (%s) → failure with the errorMessage', (_case, msg) => {
      const log = lines(
        SESSION,
        ...piRun(assistant('error', msg), true),
        ...piRun(assistant('error', msg), false),
        SETTLED
      );
      expect(classify(log, 0)).toEqual({ status: 'failure', error_message: msg });
    });

    it('exit 0 after intermediate retries that ultimately succeed → success', () => {
      expect(classify(PI_RECOVERED_LOG, 0)).toEqual({ status: 'success', error_message: null });
    });

    it('exit 0 + successful run → success', () => {
      expect(classify(PI_SUCCESS_LOG, 0)).toEqual({ status: 'success', error_message: null });
    });

    it('malformed lines do not break classification', () => {
      const log = 'garbage\n{ nope\n' + PI_FAILED_LOG + 'trailing noise\n';
      expect(classify(log, 0)).toEqual({ status: 'failure', error_message: CONN_ERR });
    });

    it('timeout still wins over a pi error', () => {
      expect(classify(PI_FAILED_LOG, 124).status).toBe('timeout');
    });
  });

  describe('Claude Code (unchanged)', () => {
    it('success result → success', () => {
      const log = lines(
        '{"type":"system","subtype":"init"}',
        '{"type":"result","subtype":"success","is_error":false,"result":"done","num_turns":3}'
      );
      expect(classify(log, 0)).toEqual({ status: 'success', error_message: null });
    });

    it('is_error failure → structured error', () => {
      const log = lines(
        '{"type":"result","is_error":true,"api_error_status":404,"result":"model not found"}'
      );
      expect(classify(log, 1)).toEqual({
        status: 'failure',
        error_message: '[API 404] model not found',
      });
    });

    it('usage-limit 429 → structured error', () => {
      const log = lines(
        '{"is_error":true,"api_error_status":429,"result":"Claude AI usage limit reached","type":"result"}'
      );
      expect(classify(log, 1)).toEqual({
        status: 'failure',
        error_message: '[API 429] Claude AI usage limit reached',
      });
    });
  });

  describe('OpenCode / plain text (unchanged)', () => {
    it('exit 0 text log → success', () => {
      expect(classify('some output\nall done\n', 0)).toEqual({
        status: 'success',
        error_message: null,
      });
    });

    it('non-zero exit text log → raw tail fallback', () => {
      const result = classify('line1\nboom\n', 2);
      expect(result.status).toBe('failure');
      expect(result.error_message).toBe('line1\nboom\n');
    });
  });
});
