import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

/**
 * Fast contract tests for harness-cli.sh's `result_events` helper — the single
 * place the harness locates the agent CLI's final stream-json result event.
 *
 * Why these exist: on 2026-08-04 Claude Code 2.1.221 reordered the keys of that
 * event (it now starts `{"is_error":true,...}` with `"type":"result"` near the
 * end), and the harness's start-anchored `grep '^{"type":"result"'` silently
 * matched nothing — usage-limit 429s became hard failures and the usage columns
 * went NULL. The docker-gated tests in
 * __tests__/integration/harness-usage-limit.test.ts cover the whole retry loop;
 * these run everywhere docker isn't available and fail fast if the selection
 * ever goes back to being order-dependent (or degrades to a substring match).
 *
 * The helper is extracted from the script rather than duplicated here, so the
 * assertions are about the shipped code.
 */

const HARNESS_PATH = path.resolve(
  __dirname,
  '../../../../..',
  'harness',
  'harness-cli.sh'
);
const HARNESS_SRC = fs.readFileSync(HARNESS_PATH, 'utf-8');

/** Pull one `name() { ... }` block out of the script. The harness runs its
 *  whole pipeline at load time, so it can't simply be sourced. */
function extractFunction(name: string): string {
  const match = HARNESS_SRC.match(
    new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm')
  );
  if (!match) throw new Error(`${name}() not found in harness-cli.sh`);
  return match[0];
}

// bash + jq are Linux-container tools; skip the execution tests on hosts
// without them (Windows dev boxes). The static assertions below always run.
const HAS_SHELL =
  process.platform !== 'win32' &&
  spawnSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }).status === 0;

const RESULT_EVENTS = extractFunction('result_events');
const IS_USAGE_LIMIT = extractFunction('is_usage_limit_result');

/** Run the extracted helper(s) over a log body, returning the selected lines. */
function selectResultEvents(log: string): string[] {
  const out = execFileSync('bash', ['-c', `${RESULT_EVENTS}\nresult_events`], {
    input: log,
    encoding: 'utf-8',
  });
  return out.split('\n').filter((l) => l.length > 0);
}

/** Full classification path: select the run's last result event, then ask the
 *  harness's usage-limit detector about it (exit 0 = usage limit). */
function classifiesAsUsageLimit(log: string): boolean {
  const script = [
    RESULT_EVENTS,
    IS_USAGE_LIMIT,
    'LINE=$(result_events | tail -1 || true)',
    'if is_usage_limit_result "$LINE"; then echo YES; else echo NO; fi',
  ].join('\n');
  const out = execFileSync('bash', ['-c', script], {
    input: log,
    encoding: 'utf-8',
  });
  return out.trim() === 'YES';
}

// Old key order: "type" first (Claude Code <= 2.1.220).
const OLD_ORDER_LINE =
  '{"type":"result","subtype":"error_during_execution","is_error":true,' +
  '"api_error_status":429,"result":"Claude AI usage limit reached",' +
  '"num_turns":1,"usage":{"input_tokens":10,"output_tokens":5}}';

// New key order: "type" near the END (Claude Code 2.1.221) — verbatim shape of
// the production line that broke the start-anchored grep.
const NEW_ORDER_LINE =
  '{"is_error":true,"duration_api_ms":0,"num_turns":2,' +
  '"api_error_status":429,' +
  '"result":"You\'ve hit your session limit · resets 3:10pm (UTC)",' +
  '"type":"result","usage":{"input_tokens":20,"output_tokens":7}}';

// An assistant message that merely QUOTES the substring in its text. A plain
// unanchored `grep '"type":"result"'` would (wrongly) select this.
const DECOY_ASSISTANT_LINE =
  '{"type":"assistant","message":{"content":[{"type":"text",' +
  '"text":"the harness used to grep for \\"type\\":\\"result\\" at line start"}]}}';

// Non-JSON log noise that also contains the substring.
const DECOY_PLAIN_LINE = '[info] emitting {"type":"result"} shortly';

/** The comment block immediately above the helper definition. */
function resultEventsComment(): string {
  const idx = HARNESS_SRC.indexOf('result_events() {');
  return HARNESS_SRC.slice(Math.max(0, idx - 1200), idx);
}

describe('harness-cli.sh result event selection (static)', () => {
  it('no longer locates result events with a start-anchored grep', () => {
    // Guards against a reintroduced `grep '^{"type":"result"'` anywhere in the
    // script — the exact regression this helper exists to prevent. Comment
    // lines are stripped first: the helper's own comment quotes the old,
    // broken pattern on purpose.
    const code = HARNESS_SRC.split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).not.toMatch(/\^\{"type":"result"/);
  });

  it('routes every result-event consumer through the one helper', () => {
    // Three sites: usage-limit classification, structured error extraction,
    // per-run usage summing. Plus the definition itself.
    const uses = HARNESS_SRC.match(/result_events/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(4);
  });

  it('documents why the selection is order-agnostic', () => {
    // The incident that motivated the helper must stay next to it, so the next
    // person reading this code knows what broke last time.
    expect(resultEventsComment()).toMatch(/2\.1\.221/);
  });
});

describe.skipIf(!HAS_SHELL)('harness-cli.sh result_events()', () => {
  it('selects a result event with "type" as the FIRST key (old format)', () => {
    const events = selectResultEvents(
      ['{"type":"system","subtype":"init"}', OLD_ORDER_LINE].join('\n') + '\n'
    );
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]).result).toBe('Claude AI usage limit reached');
  });

  it('selects a result event with "type" mid-object (Claude Code 2.1.221)', () => {
    const events = selectResultEvents(
      ['{"type":"system","subtype":"init"}', NEW_ORDER_LINE].join('\n') + '\n'
    );
    expect(events).toHaveLength(1);
    const parsed = JSON.parse(events[0]);
    expect(parsed.type).toBe('result');
    expect(parsed.api_error_status).toBe(429);
  });

  it('does NOT select a line that merely quotes the substring in a text field', () => {
    const events = selectResultEvents(
      [DECOY_ASSISTANT_LINE, DECOY_PLAIN_LINE].join('\n') + '\n'
    );
    expect(events).toEqual([]);
  });

  it('ignores non-object JSON and unparseable lines without failing', () => {
    const events = selectResultEvents(
      [
        'plain text progress output',
        '42',
        '"a bare string"',
        '[{"type":"result"}]',
        '{"type":"result","is_error":false,"result":"done"}',
        '{ truncated json',
      ].join('\n') + '\n'
    );
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]).result).toBe('done');
  });

  it('emits one line per event so tail -1 picks the newest, decoys included', () => {
    // Decoy AFTER the real event: if it were selected, `tail -1` would hand the
    // usage-limit classifier the wrong line — exactly the false positive that
    // makes a plain substring grep unsafe.
    const events = selectResultEvents(
      [OLD_ORDER_LINE, NEW_ORDER_LINE, DECOY_ASSISTANT_LINE].join('\n') + '\n'
    );
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[1]).type).toBe('result');
    expect(JSON.parse(events[1]).duration_api_ms).toBe(0);
  });

  it('produces slurpable output for the per-run usage sum, both orders', () => {
    const events = selectResultEvents(
      [OLD_ORDER_LINE, DECOY_ASSISTANT_LINE, NEW_ORDER_LINE].join('\n') + '\n'
    );
    const parsed = events.map((e) => JSON.parse(e));
    expect(parsed.reduce((a, e) => a + e.num_turns, 0)).toBe(3);
    expect(parsed.reduce((a, e) => a + e.usage.input_tokens, 0)).toBe(30);
    expect(parsed.reduce((a, e) => a + e.usage.output_tokens, 0)).toBe(12);
  });
});

describe.skipIf(!HAS_SHELL)('usage-limit classification end to end', () => {
  it('classifies the old key order as a usage limit', () => {
    expect(classifiesAsUsageLimit(OLD_ORDER_LINE + '\n')).toBe(true);
  });

  it('classifies the new key order as a usage limit', () => {
    expect(classifiesAsUsageLimit(NEW_ORDER_LINE + '\n')).toBe(true);
  });

  it('is not fooled by a decoy emitted after the real result event', () => {
    expect(
      classifiesAsUsageLimit([NEW_ORDER_LINE, DECOY_ASSISTANT_LINE].join('\n') + '\n')
    ).toBe(true);
  });

  it('leaves a non-usage failure unclassified in either key order', () => {
    const notes = [
      '{"type":"result","is_error":true,"api_error_status":404,"result":"model not found"}',
      '{"is_error":true,"api_error_status":404,"result":"model not found","type":"result"}',
    ];
    for (const line of notes) {
      expect(classifiesAsUsageLimit(line + '\n')).toBe(false);
    }
  });
});
