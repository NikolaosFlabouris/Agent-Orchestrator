// Unit tests for scripts/harness-update.mjs — run with `npm run test:scripts`
// (node --test). No Docker, npm registry or Forgejo: every I/O dependency
// is injected.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVersionPlan,
  compareVersions,
  decide,
  detect,
  extractVersion,
  fence,
  needsRedeploy,
  openIssues,
  parseInstalledOutput,
  parseNpmViewJson,
  parsePinRange,
} from './harness-update.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DOCKERFILE = `
RUN npm install -g @anthropic-ai/claude-code
RUN npm install -g opencode-ai
# was @mariozechner/pi-coding-agent
RUN npm install -g @earendil-works/pi-coding-agent@^0.87.1
RUN npm install -g @anthropic-ai/claude-agent-sdk
`;

const INSTALLED = {
  'claude-code': '2.1.299',
  'claude-agent-sdk': '0.3.10',
  opencode: '1.18.32',
  pi: '0.87.1',
};

/** npm registry state; tweak per test. */
function npmState(overrides = {}) {
  return {
    latest: {
      '@anthropic-ai/claude-code': '2.1.299',
      '@anthropic-ai/claude-agent-sdk': '0.3.10',
      'opencode-ai': '1.18.32',
      '@earendil-works/pi-coding-agent': '0.87.1',
      ...overrides.latest,
    },
    inRange: {
      '@earendil-works/pi-coding-agent': ['0.87.1'],
      ...overrides.inRange,
    },
  };
}

function plan(overrides = {}, installed = INSTALLED) {
  const npm = npmState(overrides);
  return {
    image: 'orchestrator-agent:latest',
    ...buildVersionPlan({
      installed,
      ranges: { '@earendil-works/pi-coding-agent': '^0.87.1' },
      latest: npm.latest,
      inRange: npm.inRange,
    }),
  };
}

function smokeCase(over = {}) {
  return {
    key: 'claude-code/claude-subscription/claude-sonnet-5',
    harness_id: 'claude-code',
    profile_ids: ['default'],
    sources: ['profile'],
    provider_id: 'claude-subscription',
    provider_kind: 'claude-subscription',
    model_id: 'claude-sonnet-5',
    live_eligible: true,
    outcome: 'pass',
    reason: null,
    error_excerpt: null,
    attempts: 1,
    duration_ms: 1000,
    ...over,
  };
}

/** A sample report in harness-smoke.js's JSON shape. */
function report({ image = 'orchestrator-agent:latest', versions = {}, cases, statics, promotable, blockers = [] } = {}) {
  const c = cases ?? [
    smokeCase(),
    smokeCase({
      key: 'pi/llama-swap-local/qwen3-coder',
      harness_id: 'pi',
      profile_ids: [],
      sources: ['builtin'],
      provider_id: 'llama-swap-local',
      provider_kind: 'openai-compatible',
      model_id: 'qwen3-coder',
    }),
  ];
  const s = statics ?? [
    { harness_id: 'claude-code', check: 'version', outcome: 'pass', reason: null, error_excerpt: null },
    { harness_id: 'pi', check: 'help_flags', outcome: 'pass', reason: null, error_excerpt: null },
  ];
  const all = [...c, ...s];
  const count = (o) => all.filter((x) => x.outcome === o).length;
  return {
    image,
    started_at: '2026-09-28T17:00:00Z',
    finished_at: '2026-09-28T17:30:00Z',
    versions: {
      'claude-code': '2.1.299 (Claude Code)',
      opencode: '1.18.32',
      pi: '0.87.1',
      'claude-agent-sdk': '0.3.10',
      ...versions,
    },
    promotable: promotable ?? all.every((x) => x.outcome !== 'fail'),
    promotable_blockers: blockers,
    counts: { pass: count('pass'), fail: count('fail'), skipped: count('skipped'), not_live_tested: count('not_live_tested') },
    static_checks: s,
    cases: c,
  };
}

// ---------------------------------------------------------------------------
// Versions and detection
// ---------------------------------------------------------------------------

describe('versions', () => {
  it('extracts versions from CLI output', () => {
    assert.equal(extractVersion('2.1.300 (Claude Code)'), '2.1.300');
    assert.equal(extractVersion('v0.87.1'), '0.87.1');
    assert.equal(extractVersion('1.0.0-beta.2'), '1.0.0-beta.2');
    assert.equal(extractVersion('sh: 1: pi: not found'), null);
    assert.equal(extractVersion(null), null);
  });

  it('compares semver', () => {
    assert.ok(compareVersions('0.88.0', '0.87.9') > 0);
    assert.ok(compareVersions('2.1.10', '2.1.9') > 0);
    assert.ok(compareVersions('1.0.0', '1.0.0-rc.1') > 0);
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  });

  it('reads the pin range from the Dockerfile', () => {
    assert.equal(parsePinRange(DOCKERFILE, '@earendil-works/pi-coding-agent'), '^0.87.1');
    assert.equal(parsePinRange(DOCKERFILE, '@anthropic-ai/claude-code'), null);
    assert.equal(parsePinRange(DOCKERFILE, 'opencode-ai'), null);
  });

  it('parses npm view --json output', () => {
    assert.deepEqual(parseNpmViewJson('"1.2.3"'), ['1.2.3']);
    assert.deepEqual(parseNpmViewJson('["0.87.1","0.87.2"]'), ['0.87.1', '0.87.2']);
    assert.deepEqual(parseNpmViewJson(''), []);
  });

  it('parses the in-image version probe', () => {
    const out = parseInstalledOutput(
      'claude-code=2.1.299 (Claude Code)\nopencode=1.18.32\npi=sh: pi: not found\nclaude-agent-sdk=0.3.10\n'
    );
    assert.deepEqual(out, { 'claude-code': '2.1.299', 'claude-agent-sdk': '0.3.10', opencode: '1.18.32', pi: null });
  });

  it('reports no change when everything is current', () => {
    const p = plan();
    assert.equal(p.changed, false);
    assert.ok(p.packages.every((x) => !x.changed && x.pinBump === null));
  });

  it('flags an unpinned package with a newer npm version', () => {
    const p = plan({ latest: { '@anthropic-ai/claude-code': '2.1.300' } });
    assert.equal(p.changed, true);
    const cc = p.packages.find((x) => x.slot === 'claude-code');
    assert.equal(cc.target, '2.1.300');
    assert.equal(cc.changed, true);
  });

  it('targets the newest in-range pi and reports a pin bump separately', () => {
    const p = plan({
      latest: { '@earendil-works/pi-coding-agent': '0.88.0' },
      inRange: { '@earendil-works/pi-coding-agent': ['0.87.1', '0.87.2', '0.87.3-beta.1'] },
    });
    const pi = p.packages.find((x) => x.slot === 'pi');
    assert.equal(pi.target, '0.87.2');
    assert.equal(pi.changed, true);
    assert.equal(pi.pinBump, '0.88.0');
  });

  it('does not report a pin bump when latest is inside the range', () => {
    const p = plan({
      latest: { '@earendil-works/pi-coding-agent': '0.87.2' },
      inRange: { '@earendil-works/pi-coding-agent': ['0.87.1', '0.87.2'] },
    });
    assert.equal(p.packages.find((x) => x.slot === 'pi').pinBump, null);
  });

  it('detect() drives docker and npm through the injected exec', async () => {
    const npm = npmState({ latest: { 'opencode-ai': '1.19.0' } });
    const calls = [];
    const exec = async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'docker') return 'claude-code=2.1.299 (Claude Code)\nopencode=1.18.32\npi=0.87.1\nclaude-agent-sdk=0.3.10\n';
      const spec = args[1];
      if (spec.includes('@^')) return JSON.stringify(npm.inRange[spec.slice(0, spec.lastIndexOf('@'))]);
      return JSON.stringify(npm.latest[spec]);
    };
    const v = await detect({ image: 'orchestrator-agent:latest', dockerfile: DOCKERFILE, exec });
    assert.equal(v.changed, true);
    assert.equal(v.packages.find((x) => x.slot === 'opencode').target, '1.19.0');
    assert.ok(calls[0].startsWith('docker run --rm --entrypoint sh orchestrator-agent:latest'));
    assert.ok(calls.includes('npm view @earendil-works/pi-coding-agent@^0.87.1 version --json'));
  });

  it('detect() treats an unreadable image as all-unknown (forces a build)', async () => {
    const npm = npmState();
    const exec = async (cmd, args) => {
      if (cmd === 'docker') throw new Error('No such image');
      const spec = args[1];
      if (spec.includes('@^')) return JSON.stringify(npm.inRange[spec.slice(0, spec.lastIndexOf('@'))]);
      return JSON.stringify(npm.latest[spec]);
    };
    const warnings = [];
    const v = await detect({ image: 'x', dockerfile: DOCKERFILE, exec, warn: (w) => warnings.push(w) });
    assert.equal(v.changed, true);
    assert.equal(warnings.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

describe('decide', () => {
  it('no version change: smoke against latest, no promotion, no issue', () => {
    const d = decide({ versions: plan(), report: report(), candidateBuilt: false, workflow: 'weekly' });
    assert.equal(d.promote, false);
    assert.deepEqual(d.issues, []);
    assert.deepEqual(d.warnings, []);
    assert.match(d.summary, /Nothing to promote/);
  });

  it('version change + promotable: promote', () => {
    const d = decide({
      versions: plan({ latest: { '@anthropic-ai/claude-code': '2.1.300' } }),
      report: report({ image: 'orchestrator-agent:candidate', versions: { 'claude-code': '2.1.300 (Claude Code)' } }),
      candidateBuilt: true,
      workflow: 'weekly',
    });
    assert.equal(d.promote, true);
    assert.deepEqual(d.issues, []);
    assert.match(d.summary, /Promote `orchestrator-agent:candidate`/);
  });

  it('version change + fail: issue, no promotion', () => {
    const d = decide({
      versions: plan({ latest: { '@anthropic-ai/claude-code': '2.1.300' } }),
      report: report({
        image: 'orchestrator-agent:candidate',
        versions: { 'claude-code': '2.1.300 (Claude Code)' },
        cases: [smokeCase({ outcome: 'fail', reason: 'result_failure', error_excerpt: 'unknown option --bare' })],
        blockers: ['case claude-code/claude-subscription/claude-sonnet-5 failed (result_failure)'],
      }),
      candidateBuilt: true,
      workflow: 'weekly',
    });
    assert.equal(d.promote, false);
    assert.equal(d.issues.length, 1);
    assert.equal(d.issues[0].title, 'Harness update: adapt orchestrator to @anthropic-ai/claude-code 2.1.300');
  });

  it('pin bump available: issue even though the smoke test passes', () => {
    const d = decide({
      versions: plan({
        latest: { '@earendil-works/pi-coding-agent': '0.88.0' },
        inRange: { '@earendil-works/pi-coding-agent': ['0.87.1'] },
      }),
      report: report(),
      candidateBuilt: false,
      workflow: 'weekly',
    });
    assert.equal(d.promote, false);
    assert.equal(d.issues.length, 1);
    assert.equal(d.issues[0].kind, 'pin-bump');
    assert.equal(d.issues[0].title, 'Harness update: assess pi 0.88.0 pin bump');
  });

  it('skip-only: warning, no promotion, no issue', () => {
    const d = decide({
      versions: plan({ latest: { 'opencode-ai': '1.19.0' } }),
      report: report({
        image: 'orchestrator-agent:candidate',
        versions: { opencode: '1.19.0' },
        cases: [smokeCase({ outcome: 'skipped', reason: 'usage_limit' })],
        promotable: false,
        blockers: ['harness claude-code has a free route but no passing live case'],
      }),
      candidateBuilt: true,
      workflow: 'weekly',
    });
    assert.equal(d.promote, false);
    assert.deepEqual(d.issues, []);
    assert.equal(d.warnings.length, 1);
    assert.match(d.warnings[0], /only because of skipped cases/);
    assert.match(d.warnings[0], /no passing live case/);
    assert.match(d.summary, /⚠️/);
  });

  it('failures against latest (no candidate): issue titled by failing harness', () => {
    const d = decide({
      versions: plan(),
      report: report({
        statics: [{ harness_id: 'pi', check: 'help_flags', outcome: 'fail', reason: 'missing_flag', error_excerpt: 'pi --help does not list: --mode' }],
      }),
      candidateBuilt: false,
      workflow: 'weekly',
    });
    assert.equal(d.promote, false);
    assert.equal(d.issues.length, 1);
    assert.equal(d.issues[0].title, 'Harness update: fix failing smoke cases for pi');
    assert.match(d.summary, /nothing to promote/);
  });

  it('never promotes a latest-image report even if promotable', () => {
    const d = decide({ versions: plan(), report: report(), candidateBuilt: false, workflow: 'rebuild' });
    assert.equal(d.promote, false);
  });

  it('rebuild with no version change + promotable: promote', () => {
    const d = decide({
      versions: plan(),
      report: report({ image: 'orchestrator-agent:candidate' }),
      candidateBuilt: true,
      workflow: 'rebuild',
    });
    assert.equal(d.promote, true);
    assert.match(d.summary, /agent image rebuild/);
  });
});

// ---------------------------------------------------------------------------
// Issue rendering (against a sample smoke report)
// ---------------------------------------------------------------------------

describe('issue rendering', () => {
  const excerpt = 'error: unknown option \'--bare\'\n| pipe and ```fence```';
  const d = decide({
    versions: plan({ latest: { '@anthropic-ai/claude-code': '2.1.300' } }),
    report: report({
      image: 'orchestrator-agent:candidate',
      versions: { 'claude-code': '2.1.300 (Claude Code)' },
      cases: [
        smokeCase({ outcome: 'fail', reason: 'result_failure', error_excerpt: excerpt, profile_ids: ['default', 'reviewer'] }),
        smokeCase({ key: 'pi/llama-swap-local/qwen3-coder', harness_id: 'pi', outcome: 'skipped', reason: 'local_model_timeout' }),
      ],
      statics: [
        { harness_id: 'claude-code', check: 'help_flags', outcome: 'fail', reason: 'missing_flag', error_excerpt: 'claude --help does not list: --bare' },
      ],
    }),
    candidateBuilt: true,
    workflow: 'weekly',
    context: 'Run: https://git.internal/nik/agent-orchestrator/actions/runs/42',
  });
  const body = d.issues[0].body;

  it('has an old → new versions table', () => {
    assert.match(body, /## Versions/);
    assert.match(body, /\| `@anthropic-ai\/claude-code` \| 2\.1\.299 \| \*\*2\.1\.300\*\* \| 2\.1\.300 \| unpinned \|/);
    assert.match(body, /\| `@earendil-works\/pi-coding-agent` \| 0\.87\.1 \| 0\.87\.1 \| 0\.87\.1 \| `\^0\.87\.1` \|/);
  });

  it('lists the failing cases with harness, profile/model, outcome and excerpt', () => {
    assert.match(body, /\| `claude-code` \| default, reviewer — claude-subscription\/claude-sonnet-5 \| fail \| `result_failure` \|/);
    assert.match(body, /\| `claude-code` \| static check `help_flags` \| fail \| `missing_flag` \|/);
    assert.ok(!body.includes('local_model_timeout'), 'skipped cases are not listed as failures');
    // Excerpt kept verbatim inside a fence longer than any backtick run in it.
    assert.ok(body.includes(`\`\`\`\`text\n${excerpt}\n\`\`\`\``));
  });

  it('links npm and changelog, names likely files, states acceptance criteria', () => {
    assert.match(body, /https:\/\/www\.npmjs\.com\/package\/@anthropic-ai\/claude-code\/v\/2\.1\.300/);
    assert.match(body, /claude-code\/blob\/main\/CHANGELOG\.md/);
    assert.match(body, /- `images\/agent\/Dockerfile`/);
    assert.match(body, /- `packages\/server\/src\/harnesses\/claude-code\.ts`/);
    assert.match(body, /- `harness\/harness-cli\.sh`/);
    assert.match(body, /## Acceptance criteria/);
    assert.match(body, /agent-image-rebuild\.yml/);
    assert.match(body, /Run: https:\/\/git\.internal/);
  });

  it('renders the pin-bump issue', () => {
    const pin = decide({
      versions: plan({
        latest: { '@earendil-works/pi-coding-agent': '0.88.0' },
        inRange: { '@earendil-works/pi-coding-agent': ['0.87.1'] },
      }),
      report: report(),
      candidateBuilt: false,
      workflow: 'weekly',
    }).issues[0].body;
    assert.match(pin, /`@earendil-works\/pi-coding-agent` \*\*0\.88\.0\*\*/);
    assert.match(pin, /pins `\^0\.87\.1`/);
    assert.match(pin, /packages\/server\/src\/harnesses\/pi\.ts/);
    assert.match(pin, /\| `pi\/llama-swap-local\/qwen3-coder` \| pass \|/);
    assert.match(pin, /pi-coding-agent\/v\/0\.88\.0/);
    assert.match(pin, /admits 0\.88\.0/);
  });

  it('fence() outgrows backtick runs', () => {
    assert.equal(fence('plain'), '```text\nplain\n```');
    assert.equal(fence('a ```` b'), '`````text\na ```` b\n`````');
  });
});

// ---------------------------------------------------------------------------
// Forgejo: dedup and labels
// ---------------------------------------------------------------------------

function fakeForgejo({ openIssues: open = [], labels = [] } = {}) {
  const state = { open: [...open], labels: [...labels], created: [], createdLabels: [] };
  let next = 100;
  return {
    state,
    client: {
      listLabels: async () => state.labels,
      createLabel: async (data) => {
        const l = { id: next++, ...data };
        state.labels.push(l);
        state.createdLabels.push(data.name);
        return l;
      },
      listOpenIssues: async (label) =>
        state.open.filter((i) => i.labels.some((l) => l.name === label)),
      createIssue: async (data) => {
        const i = { number: next++, ...data };
        state.created.push(i);
        return i;
      },
    },
  };
}

describe('openIssues', () => {
  const issue = { title: 'Harness update: assess pi 0.88.0 pin bump', body: 'b' };

  it('creates the issue with status/queued + harness-update, creating the missing label', async () => {
    const f = fakeForgejo({ labels: [{ id: 1, name: 'status/queued' }] });
    const r = await openIssues(f.client, [issue]);
    assert.deepEqual(r.map((x) => x.action), ['created']);
    assert.deepEqual(f.state.createdLabels, ['harness-update']);
    assert.equal(f.state.created.length, 1);
    assert.equal(f.state.created[0].labels[0], 1);
    assert.equal(f.state.created[0].labels.length, 2);
  });

  it('dedup: no second issue when an open harness-update issue has the same title', async () => {
    const f = fakeForgejo({
      labels: [{ id: 1, name: 'status/queued' }, { id: 2, name: 'harness-update' }],
      openIssues: [{ number: 7, title: issue.title, labels: [{ name: 'harness-update' }] }],
    });
    const r = await openIssues(f.client, [issue]);
    assert.deepEqual(r, [{ title: issue.title, action: 'skipped', number: 7 }]);
    assert.equal(f.state.created.length, 0);
  });

  it('dedup within one run, and different titles still get their own issue', async () => {
    const f = fakeForgejo({ labels: [{ id: 1, name: 'status/queued' }, { id: 2, name: 'harness-update' }] });
    const r = await openIssues(f.client, [issue, issue, { title: 'Harness update: fix failing smoke cases for pi', body: 'b' }]);
    assert.deepEqual(r.map((x) => x.action), ['created', 'skipped', 'created']);
    assert.equal(f.state.created.length, 2);
  });

  it('does nothing when there are no issues', async () => {
    const f = fakeForgejo();
    assert.deepEqual(await openIssues(f.client, []), []);
  });
});

describe('needsRedeploy', () => {
  it('is true only when something under packages/ changed', () => {
    assert.equal(needsRedeploy(['images/agent/Dockerfile', 'harness/harness-cli.sh']), false);
    assert.equal(needsRedeploy(['packages/server/src/harnesses/pi.ts']), true);
    assert.equal(needsRedeploy(['packages/shared/src/types.ts']), true);
    assert.equal(needsRedeploy([]), false);
  });
});
