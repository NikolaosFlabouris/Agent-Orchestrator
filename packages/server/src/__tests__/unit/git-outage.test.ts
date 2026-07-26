import { describe, it, expect, vi } from 'vitest';
import {
  classifyGitFailure,
  isInfraGitFailure,
  isGitOperationError,
  isExecTimeout,
  describeGitExecFailure,
  redactCredentials,
  sanitizeGitError,
  computeBackoffMs,
  nextAttemptAt,
  backoffElapsed,
  formatDelay,
  GitHostHealth,
} from '../../git-outage.js';
import {
  GIT_BACKOFF_BASE_SECONDS,
  GIT_BACKOFF_MAX_SECONDS,
} from '../../constants.js';

// ---------------------------------------------------------------------------
// Unit tests for the git-outage primitives (#144).
//
// The classifier decides whether a failed clone/fetch/push means "the host is
// down, wait" or "this task is broken, fail it". Getting that wrong in either
// direction is expensive: too eager and a genuinely broken task retries
// forever; too conservative and a git-host outage permanently fails the whole
// queue (which is exactly what happened during the 2026-07-23 incident).
// The literal strings below are copied from that incident's logs.
// ---------------------------------------------------------------------------

describe('classifyGitFailure', () => {
  describe('outage-shaped (infra) failures', () => {
    const INFRA_CASES: Array<[string, string]> = [
      [
        'the canonical Forgejo-down signature from the incident',
        'git fetch failed: fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.',
      ],
      [
        'remote-side repository corruption (also from the incident)',
        'git fetch failed: remote: fatal: bad tree object 1a2b3c4d5e6f7890 remote: aborting due to possible repository corruption on the remote side.',
      ],
      ['connection refused', "git clone failed: fatal: unable to access 'http://forgejo:3000/nik/repo.git/': Failed to connect to forgejo port 3000: Connection refused"],
      ['connection reset', 'git push failed: fatal: the remote end hung up unexpectedly: Connection reset by peer'],
      ['DNS resolution failure', "git fetch failed: fatal: unable to access 'http://forgejo:3000/x.git/': Could not resolve host: forgejo"],
      ['transient DNS (EAI_AGAIN)', 'git fetch failed: getaddrinfo EAI_AGAIN forgejo'],
      ['our own timeout wrapper', 'git fetch timed out after 120s (git host unresponsive)'],
      ['early EOF / RPC failure on a big fetch', 'git clone failed: error: RPC failed; curl 56 GnuTLS recv error\nfatal: early EOF'],
      ['a 502 from a reverse proxy in front of Forgejo', "git push failed: error: unable to access 'http://forgejo:3000/x.git/': The requested URL returned error: 502 Bad Gateway"],
      ['raw socket errno', 'connect ECONNREFUSED 192.168.1.30:3000'],
      [
        'a bare 5xx with no reason phrase (Forgejo mid-restart)',
        "git fetch failed: fatal: unable to access 'http://forgejo:3000/x.git/': The requested URL returned error: 503",
      ],
      [
        'rate limiting — the one 4xx that really is transient',
        "git clone failed: fatal: unable to access 'http://forgejo:3000/x.git/': The requested URL returned error: 429",
      ],
      [
        'a salvage push killed by its own timeout, once named by describeGitExecFailure',
        'git push timed out after 120s (git host unresponsive)',
      ],
    ];

    for (const [label, message] of INFRA_CASES) {
      it(`classifies ${label} as infra`, () => {
        expect(classifyGitFailure(message)).toBe('infra');
        expect(isInfraGitFailure(message)).toBe(true);
      });
    }
  });

  describe('structural failures stay non-infra', () => {
    const STRUCTURAL_CASES: Array<[string, string]> = [
      [
        'branch missing on both sides (prepareWorkspace gives up)',
        'Branch agent/issue-12-foo not found on local or remote',
      ],
      [
        'missing agent image (already categorized by categorizePrepFailure)',
        '(HTTP code 404) no such container - No such image: orchestrator-agent:latest',
      ],
      ['deleted repo row', 'Repo not found for task 12'],
      [
        'broken profile chain',
        "Agent profile 'claude-sonnet' not found (referenced by repo for the develop stage).",
      ],
      [
        'auth misconfiguration — the token is wrong, not the host',
        'git push failed: remote: Unauthorized\nfatal: Authentication failed',
      ],
      [
        'protected branch rejection',
        'git push failed: ! [remote rejected] main -> main (pre-receive hook declined)',
      ],
      [
        'non-fast-forward',
        'git push failed: ! [rejected] feat -> feat (non-fast-forward)',
      ],
      ['missing git identity on the orchestrator', 'Salvage commit failed: Command failed: git commit -m x\n*** Please tell me who you are.'],
      // git wraps EVERY HTTP outcome in `unable to access '<url>': …`, so a
      // 4xx is shaped exactly like an outage. Backing off on one would be
      // worse than a stuck task: the failure gates the host, the ls-remote
      // probe carries the same broken token and also fails, and the gate
      // never reopens — the whole queue freezes with nothing ever failing.
      [
        'a revoked agent token (403) — never an outage',
        "git push failed: fatal: unable to access 'http://***@forgejo:3000/nik/repo.git/': The requested URL returned error: 403",
      ],
      [
        'an expired token (401)',
        "git fetch failed: fatal: unable to access 'http://***@forgejo:3000/nik/repo.git/': The requested URL returned error: 401",
      ],
      [
        'a repo the token cannot see (404)',
        "git clone failed: fatal: unable to access 'http://***@forgejo:3000/nik/gone.git/': The requested URL returned error: 404 Not Found",
      ],
      [
        'credentials rejected without an HTTP code',
        "git fetch failed: fatal: Authentication failed for 'http://forgejo:3000/nik/repo.git/'",
      ],
      [
        'no credentials at all — git wanted to prompt',
        "git fetch failed: fatal: could not read Username for 'http://forgejo:3000': terminal prompts disabled",
      ],
    ];

    for (const [label, message] of STRUCTURAL_CASES) {
      it(`classifies ${label} as other`, () => {
        expect(classifyGitFailure(message)).toBe('other');
        expect(isInfraGitFailure(message)).toBe(false);
      });
    }
  });
});

describe('describeGitExecFailure / isExecTimeout', () => {
  /** How Node rejects an execFile that blew its `timeout`: killed, signalled,
   *  and with nothing on stderr — the message alone says nothing about why. */
  function timeoutRejection(cmd: string): Error {
    return Object.assign(new Error(`Command failed: ${cmd}`), {
      killed: true,
      code: null,
      signal: 'SIGTERM',
      stderr: '',
    });
  }

  it('names a killed subprocess as a timeout so the classifier sees the outage', () => {
    const err = timeoutRejection('git push -f origin agent/issue-10-x');
    expect(isExecTimeout(err)).toBe(true);
    const msg = describeGitExecFailure(err, 'push', 120_000);
    expect(msg).toBe('git push timed out after 120s (git host unresponsive)');
    // The whole point: a hung host must back off, not fail the task.
    expect(isInfraGitFailure(msg)).toBe(true);
  });

  it('recognises an explicit ETIMEDOUT code', () => {
    const err = Object.assign(new Error('Command failed: git fetch'), {
      code: 'ETIMEDOUT',
    });
    expect(isExecTimeout(err)).toBe(true);
    expect(isInfraGitFailure(describeGitExecFailure(err, 'fetch', 60_000))).toBe(
      true
    );
  });

  it('does not treat a maxBuffer kill as a timeout — that one is structural', () => {
    const err = Object.assign(new Error('stdout maxBuffer length exceeded'), {
      killed: true,
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    });
    expect(isExecTimeout(err)).toBe(false);
    const msg = describeGitExecFailure(err, 'clone', 120_000);
    expect(msg).toContain('maxBuffer');
    expect(isInfraGitFailure(msg)).toBe(false);
  });

  it('prefers stderr over the bare "Command failed" message', () => {
    const err = Object.assign(new Error('Command failed: git fetch origin'), {
      stderr: 'fatal: Could not read from remote repository.\n',
    });
    expect(describeGitExecFailure(err, 'fetch', 120_000)).toBe(
      'git fetch failed: fatal: Could not read from remote repository.'
    );
  });

  it('falls back to the message when stderr is empty', () => {
    const err = Object.assign(new Error('Command failed: git push'), {
      stderr: '   ',
    });
    expect(describeGitExecFailure(err, 'push', 120_000)).toBe(
      'git push failed: Command failed: git push'
    );
  });

  it('redacts the agent token before the message escapes', () => {
    const err = Object.assign(new Error('boom'), {
      stderr:
        "fatal: unable to access 'http://agent:s3cr3t@forgejo:3000/nik/repo.git/': Connection refused",
    });
    const msg = describeGitExecFailure(err, 'clone', 120_000);
    expect(msg).not.toContain('s3cr3t');
    expect(msg).toContain('http://***@forgejo:3000');
  });

  it('tolerates a non-Error rejection', () => {
    expect(isExecTimeout('nope')).toBe(false);
    expect(isExecTimeout(null)).toBe(false);
    expect(describeGitExecFailure('nope', 'fetch', 1000)).toBe(
      'git fetch failed: nope'
    );
  });
});

describe('isGitOperationError', () => {
  it('recognises the orchestrator git wrapper shape', () => {
    expect(isGitOperationError('git fetch failed: fatal: boom')).toBe(true);
    expect(isGitOperationError('Salvage push failed after retries: git push failed')).toBe(true);
  });

  it('recognises bare remote/fatal git output', () => {
    expect(isGitOperationError('remote: fatal: bad tree object abc')).toBe(true);
  });

  it('does not claim Docker failures for the git host gate', () => {
    // A Docker daemon that refuses connections says nothing about Forgejo —
    // gating git prep on it would be wrong.
    expect(
      isGitOperationError('connect ECONNREFUSED /var/run/docker.sock')
    ).toBe(false);
  });
});

describe('redactCredentials / sanitizeGitError', () => {
  it('strips the agent token out of a clone URL', () => {
    const raw =
      "Command failed: git clone http://agent:s3cr3t-token@forgejo:3000/nik/repo.git /workspaces/1-issue-2";
    const out = redactCredentials(raw);
    expect(out).not.toContain('s3cr3t-token');
    expect(out).toContain('http://***@forgejo:3000/nik/repo.git');
  });

  it('leaves credential-free text alone', () => {
    expect(redactCredentials('fatal: Could not read from remote repository')).toBe(
      'fatal: Could not read from remote repository'
    );
  });

  it('collapses whitespace and truncates to the event limit', () => {
    const long = `git fetch failed: ${'x'.repeat(2000)}`;
    const out = sanitizeGitError(long, 50);
    expect(out).toHaveLength(51); // 50 chars + the ellipsis
    expect(out.endsWith('…')).toBe(true);
  });

  it('keeps a short message verbatim (whitespace collapsed)', () => {
    expect(sanitizeGitError('git fetch failed:\n  fatal: boom\n')).toBe(
      'git fetch failed: fatal: boom'
    );
  });

  it('redacts before truncating so a token can never survive', () => {
    const raw = `git clone failed: unable to access 'http://agent:tok@h/r.git/'`;
    expect(sanitizeGitError(raw)).not.toContain('tok@');
  });
});

describe('computeBackoffMs', () => {
  // Jitter off (random() === 0.5 → the ±ratio term is exactly 0) so the
  // schedule itself is asserted, not the RNG.
  const noJitter = { random: () => 0.5 };

  it('escalates exponentially from the base delay', () => {
    const base = GIT_BACKOFF_BASE_SECONDS * 1000;
    expect(computeBackoffMs(1, noJitter)).toBe(base);
    expect(computeBackoffMs(2, noJitter)).toBe(base * 2);
    expect(computeBackoffMs(3, noJitter)).toBe(base * 4);
    expect(computeBackoffMs(4, noJitter)).toBe(base * 8);
  });

  it('is minutes-scale from the very first retry', () => {
    // The bug being fixed: the 2nd and 3rd prep attempts were ~300 ms apart.
    expect(computeBackoffMs(1, noJitter)).toBeGreaterThanOrEqual(60_000);
  });

  it('caps the delay', () => {
    const cap = GIT_BACKOFF_MAX_SECONDS * 1000;
    expect(computeBackoffMs(20, noJitter)).toBe(cap);
    // A runaway level must not overflow into Infinity/NaN.
    expect(computeBackoffMs(10_000, noJitter)).toBe(cap);
  });

  it('applies jitter within ±ratio of the nominal delay', () => {
    const base = 60_000;
    const low = computeBackoffMs(1, { baseMs: base, jitterRatio: 0.2, random: () => 0 });
    const high = computeBackoffMs(1, { baseMs: base, jitterRatio: 0.2, random: () => 0.999999 });
    expect(low).toBe(base * 0.8);
    expect(high).toBeCloseTo(base * 1.2, -1);
    // …and the real RNG stays inside the band across many draws.
    for (let i = 0; i < 200; i++) {
      const ms = computeBackoffMs(1, { baseMs: base, jitterRatio: 0.2 });
      expect(ms).toBeGreaterThanOrEqual(base * 0.8);
      expect(ms).toBeLessThanOrEqual(base * 1.2);
    }
  });

  it('never returns a negative delay even with an absurd jitter ratio', () => {
    expect(
      computeBackoffMs(1, { baseMs: 1000, jitterRatio: 5, random: () => 0 })
    ).toBe(0);
  });

  it('treats levels below 1 as the first retry', () => {
    expect(computeBackoffMs(0, noJitter)).toBe(computeBackoffMs(1, noJitter));
    expect(computeBackoffMs(-3, noJitter)).toBe(computeBackoffMs(1, noJitter));
  });
});

describe('nextAttemptAt / backoffElapsed', () => {
  it('produces an ISO timestamp the backoff delay into the future', () => {
    const now = Date.parse('2026-07-23T10:00:00.000Z');
    const iso = nextAttemptAt(1, { now, random: () => 0.5 });
    expect(iso).toBe('2026-07-23T10:01:00.000Z');
  });

  it('reports a future timestamp as not yet elapsed', () => {
    const now = Date.parse('2026-07-23T10:00:00.000Z');
    expect(backoffElapsed('2026-07-23T10:00:30.000Z', now)).toBe(false);
    expect(backoffElapsed('2026-07-23T09:59:30.000Z', now)).toBe(true);
    // Exactly due counts as due.
    expect(backoffElapsed('2026-07-23T10:00:00.000Z', now)).toBe(true);
  });

  it('treats null/garbage as due — a bad timestamp must never strand a task', () => {
    expect(backoffElapsed(null)).toBe(true);
    expect(backoffElapsed(undefined)).toBe(true);
    expect(backoffElapsed('not-a-date')).toBe(true);
  });
});

describe('formatDelay', () => {
  it('renders operator-facing delays', () => {
    expect(formatDelay(45_000)).toBe('45s');
    expect(formatDelay(60_000)).toBe('1m');
    expect(formatDelay(150_000)).toBe('2m 30s');
    expect(formatDelay(0)).toBe('0s');
  });
});

describe('GitHostHealth', () => {
  const HOST = 'forgejo:3000';

  it('does not gate before the failure threshold', () => {
    const health = new GitHostHealth({ failureThreshold: 3 });
    expect(health.recordFailure(HOST)).toBe(false);
    expect(health.isGated(HOST)).toBe(false);
    expect(health.recordFailure(HOST)).toBe(false);
    expect(health.isGated(HOST)).toBe(false);
  });

  it('gates on the Nth consecutive cross-task failure and reports the transition once', () => {
    const health = new GitHostHealth({ failureThreshold: 3 });
    health.recordFailure(HOST);
    health.recordFailure(HOST);
    expect(health.recordFailure(HOST)).toBe(true); // the transition
    expect(health.isGated(HOST)).toBe(true);
    expect(health.recordFailure(HOST)).toBe(false); // already gated
    expect(health.gatedHosts()).toEqual([HOST]);
  });

  it('keeps hosts independent', () => {
    const health = new GitHostHealth({ failureThreshold: 2 });
    health.recordFailure('a');
    health.recordFailure('a');
    expect(health.isGated('a')).toBe(true);
    expect(health.isGated('b')).toBe(false);
  });

  it('a success resets the consecutive counter, so isolated failures never gate', () => {
    const health = new GitHostHealth({ failureThreshold: 3 });
    health.recordFailure(HOST);
    health.recordFailure(HOST);
    health.recordSuccess(HOST);
    health.recordFailure(HOST);
    health.recordFailure(HOST);
    expect(health.isGated(HOST)).toBe(false);
    expect(health.consecutiveFailures(HOST)).toBe(2);
  });

  it('clears the gate when the liveness probe succeeds', async () => {
    // probeIntervalMs: 0 so both probes in this test are allowed to fire;
    // the interval itself is covered by the rate-limit case below.
    const health = new GitHostHealth({ failureThreshold: 1, probeIntervalMs: 0 });
    health.recordFailure(HOST);
    expect(health.isGated(HOST)).toBe(true);

    const probe = vi.fn().mockResolvedValue(false);
    expect(await health.refresh(probe)).toEqual([]);
    expect(health.isGated(HOST)).toBe(true);

    probe.mockResolvedValue(true);
    expect(await health.refresh(probe)).toEqual([HOST]);
    expect(health.isGated(HOST)).toBe(false);
    expect(health.consecutiveFailures(HOST)).toBe(0);
  });

  it('rate-limits probes of a gated host', async () => {
    let now = 1_000_000;
    const health = new GitHostHealth({
      failureThreshold: 1,
      probeIntervalMs: 30_000,
      now: () => now,
    });
    health.recordFailure(HOST);

    const probe = vi.fn().mockResolvedValue(false);
    await health.refresh(probe); // first probe fires immediately
    await health.refresh(probe); // too soon — skipped
    expect(probe).toHaveBeenCalledTimes(1);

    now += 30_000;
    await health.refresh(probe);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('treats a throwing probe as "still down" rather than propagating', async () => {
    const health = new GitHostHealth({ failureThreshold: 1 });
    health.recordFailure(HOST);
    await expect(
      health.refresh(async () => {
        throw new Error('ls-remote exploded');
      })
    ).resolves.toEqual([]);
    expect(health.isGated(HOST)).toBe(true);
  });

  it('does not probe a healthy host at all', async () => {
    const health = new GitHostHealth({ failureThreshold: 3 });
    const probe = vi.fn().mockResolvedValue(true);
    await health.refresh(probe);
    expect(probe).not.toHaveBeenCalled();
  });

  it('single-flights concurrent refreshes so a slow probe is not duplicated', async () => {
    const health = new GitHostHealth({ failureThreshold: 1, probeIntervalMs: 0 });
    health.recordFailure(HOST);
    let resolveProbe: (v: boolean) => void = () => {};
    const probe = vi.fn().mockImplementation(
      () => new Promise<boolean>((res) => { resolveProbe = res; })
    );

    const first = health.refresh(probe);
    const second = health.refresh(probe); // must not start a second probe
    resolveProbe(true);
    await Promise.all([first, second]);

    expect(probe).toHaveBeenCalledTimes(1);
  });
});
