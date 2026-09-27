#!/usr/bin/env node
/**
 * Harness update check: the deterministic logic behind
 * .forgejo/workflows/harness-update.yml (weekly) and
 * .forgejo/workflows/agent-image-rebuild.yml (after merges). The YAML only
 * orchestrates steps; detection, the promote/issue decision, issue
 * rendering and the Forgejo calls all live here, with no LLM involved.
 *
 *   node scripts/harness-update.mjs detect  --image <tag> [--dockerfile <path>] --out <versions.json>
 *   node scripts/harness-update.mjs decide  --versions <versions.json> --report <smoke.json>
 *                                           --candidate-built true|false --workflow weekly|rebuild
 *                                           [--context <text>] --out <decision.json> [--summary <md>]
 *   node scripts/harness-update.mjs issues  --decision <decision.json>
 *   node scripts/harness-update.mjs needs-redeploy <changed-file>...   (or file list on stdin)
 *
 * `issues` reads ISSUE_TOKEN (never printed), and FORGEJO_API_URL /
 * GITHUB_SERVER_URL plus GITHUB_REPOSITORY for the target repo.
 *
 * Unit tests: scripts/harness-update.test.mjs (node --test). See
 * docs/07-deployment-operations.md ("Harness update automation").
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

/** The agent CLIs installed by images/agent/Dockerfile. `slot` is the key
 *  in the smoke report's `versions`; `harnesses` are the harness ids that
 *  run on the package. */
export const PACKAGES = [
  {
    slot: 'claude-code',
    npm: '@anthropic-ai/claude-code',
    name: 'Claude Code',
    harnesses: ['claude-code'],
    changelog: 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md',
  },
  {
    slot: 'claude-agent-sdk',
    npm: '@anthropic-ai/claude-agent-sdk',
    name: 'Claude Agent SDK',
    harnesses: ['claude-sdk'],
    changelog: 'https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md',
  },
  {
    slot: 'opencode',
    npm: 'opencode-ai',
    name: 'OpenCode',
    harnesses: ['opencode'],
    changelog: 'https://github.com/sst/opencode/releases',
  },
  {
    slot: 'pi',
    npm: '@earendil-works/pi-coding-agent',
    name: 'pi',
    harnesses: ['pi'],
    changelog: 'https://github.com/earendil-works/pi/releases',
  },
];

const ISSUE_LABELS = ['status/queued', 'harness-update'];
const DEDUP_LABEL = 'harness-update';
const LATEST_IMAGE = 'orchestrator-agent:latest';

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** First semver-looking token in `text` (`2.1.300 (Claude Code)` → `2.1.300`). */
export function extractVersion(text) {
  const m = /(?:^|[^\d.])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/** Semver precedence: negative, zero or positive. */
export function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre] = String(v).split('-', 2);
    return { nums: core.split('.').map(Number), pre: pre ?? null };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export function maxVersion(versions) {
  return versions.reduce((best, v) => (best === null || compareVersions(v, best) > 0 ? v : best), null);
}

/** The version range in `npm install -g <pkg>@<range>`, or null when the
 *  package is installed unpinned (or not at all). */
export function parsePinRange(dockerfile, npmName) {
  const escaped = npmName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`npm install -g[ \\t]+(?:\\S+[ \\t]+)*?${escaped}(?:@(\\S+))?(?=\\s|$)`, 'm').exec(dockerfile);
  return m?.[1] ?? null;
}

/**
 * Turn raw lookups into the version plan.
 *   installed: slot → version in orchestrator-agent:latest (null = unreadable)
 *   ranges:    npm name → Dockerfile range (null = unpinned)
 *   latest:    npm name → `npm view <pkg> version`
 *   inRange:   npm name → every published version matching the range
 *              (pinned packages only)
 * `target` is what a --no-cache rebuild would install; `pinBump` is a newer
 * release outside the pinned range.
 */
export function buildVersionPlan({ installed, ranges, latest, inRange }) {
  const packages = PACKAGES.map((p) => {
    const range = ranges[p.npm] ?? null;
    const newest = latest[p.npm] ?? null;
    let target = newest;
    let pinBump = null;
    if (range) {
      const matching = inRange[p.npm] ?? [];
      target = maxVersion(matching.filter((v) => !v.includes('-')));
      if (newest && !matching.includes(newest) && (target === null || compareVersions(newest, target) > 0)) {
        pinBump = newest;
      }
    }
    const current = installed[p.slot] ?? null;
    return {
      slot: p.slot,
      npm: p.npm,
      installed: current,
      range,
      target,
      latest: newest,
      pinBump,
      changed: target !== null && current !== target,
    };
  });
  return { packages, changed: packages.some((p) => p.changed) };
}

// ---------------------------------------------------------------------------
// Detect (I/O)
// ---------------------------------------------------------------------------

const READ_VERSIONS_SCRIPT = `
echo "claude-code=$(claude --version 2>&1 | head -n1)"
echo "opencode=$(opencode --version 2>&1 | head -n1)"
echo "pi=$(pi --version 2>&1 | head -n1)"
echo "claude-agent-sdk=$(jq -r .version "$(npm root -g)/@anthropic-ai/claude-agent-sdk/package.json" 2>&1)"
`;

export function parseInstalledOutput(output) {
  const installed = Object.fromEntries(PACKAGES.map((p) => [p.slot, null]));
  for (const line of String(output).split('\n')) {
    const i = line.indexOf('=');
    if (i < 0) continue;
    const slot = line.slice(0, i).trim();
    if (slot in installed) installed[slot] = extractVersion(line.slice(i + 1));
  }
  return installed;
}

/** `npm view … --json` prints a string for one match, an array for several. */
export function parseNpmViewJson(output) {
  const text = String(output).trim();
  if (!text) return [];
  const v = JSON.parse(text);
  return (Array.isArray(v) ? v : [v]).map(String);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')} failed: ${String(stderr || err.message).trim()}`));
      else resolve(String(stdout));
    });
  });
}

export async function detect({ image, dockerfile, exec = run, warn = () => {} }) {
  let installed;
  try {
    installed = parseInstalledOutput(
      await exec('docker', ['run', '--rm', '--entrypoint', 'sh', image, '-c', READ_VERSIONS_SCRIPT])
    );
  } catch (err) {
    warn(`could not read versions from ${image}: ${err.message}`);
    installed = parseInstalledOutput('');
  }
  const ranges = {};
  const latest = {};
  const inRange = {};
  for (const p of PACKAGES) {
    ranges[p.npm] = parsePinRange(dockerfile, p.npm);
    latest[p.npm] = parseNpmViewJson(await exec('npm', ['view', p.npm, 'version', '--json']))[0] ?? null;
    if (ranges[p.npm]) {
      inRange[p.npm] = parseNpmViewJson(
        await exec('npm', ['view', `${p.npm}@${ranges[p.npm]}`, 'version', '--json'])
      );
    }
  }
  return { image, ...buildVersionPlan({ installed, ranges, latest, inRange }) };
}

// ---------------------------------------------------------------------------
// Decide
// ---------------------------------------------------------------------------

function pkgBySlot(slot) {
  return PACKAGES.find((p) => p.slot === slot);
}

/** Failing cases and static checks from a smoke report, in report order. */
export function collectFailures(report) {
  const cases = (report.cases ?? [])
    .filter((c) => c.outcome === 'fail')
    .map((c) => ({
      harness: c.harness_id,
      what: `${c.profile_ids?.length ? c.profile_ids.join(', ') : 'built-in'} — ${c.provider_id}/${c.model_id}`,
      key: c.key,
      outcome: c.outcome,
      reason: c.reason,
      excerpt: c.error_excerpt,
    }));
  const statics = (report.static_checks ?? [])
    .filter((s) => s.outcome === 'fail')
    .map((s) => ({
      harness: s.harness_id,
      what: `static check \`${s.check}\``,
      key: `${s.harness_id}/${s.check}`,
      outcome: s.outcome,
      reason: s.reason,
      excerpt: s.error_excerpt,
    }));
  return [...statics, ...cases];
}

/** Old (orchestrator-agent:latest) → new (the image the smoke test ran
 *  on) for every package. `new` comes from the report, so it is exactly
 *  what was tested. */
export function versionRows(versions, report) {
  return versions.packages.map((v) => {
    const tested = extractVersion(report?.versions?.[v.slot]);
    return { ...v, old: v.installed, new: tested ?? v.target };
  });
}

export function issueTitleForFailures(rows, failures) {
  const changed = rows.filter((r) => r.new && r.old !== r.new);
  if (changed.length > 0) {
    return `Harness update: adapt orchestrator to ${changed.map((r) => `${r.npm} ${r.new}`).join(', ')}`;
  }
  const harnesses = [...new Set(failures.map((f) => f.harness))].sort();
  return `Harness update: fix failing smoke cases for ${harnesses.join(', ')}`;
}

export function pinBumpTitle(row) {
  return `Harness update: assess ${pkgBySlot(row.slot).name} ${row.pinBump} pin bump`;
}

/**
 * The whole decision, as data. Inputs:
 *   versions:       output of `detect`
 *   report:         the smoke runner's JSON report
 *   candidateBuilt: whether the report is for orchestrator-agent:candidate
 *   workflow:       'weekly' | 'rebuild' (wording only)
 *   context:        free text for the issue body (run URL, commit)
 */
export function decide({ versions, report, candidateBuilt, workflow, context = '' }) {
  const rows = versionRows(versions, report);
  const failures = collectFailures(report);
  const promote = candidateBuilt && report.promotable === true;
  const issues = [];
  const warnings = [];
  const actions = [];

  if (promote) actions.push(`Promote \`${report.image}\` to \`${LATEST_IMAGE}\`.`);
  if (failures.length > 0) {
    const title = issueTitleForFailures(rows, failures);
    issues.push({
      kind: 'failures',
      title,
      body: renderFailureIssue({ rows, report, failures, candidateBuilt, workflow, context }),
    });
    actions.push(
      candidateBuilt
        ? `Not promoted: ${failures.length} failing check(s). Open issue "${title}".`
        : `Failures against \`${report.image}\` (nothing to promote). Open issue "${title}".`
    );
  }
  for (const row of rows.filter((r) => r.pinBump)) {
    const title = pinBumpTitle(row);
    issues.push({ kind: 'pin-bump', title, body: renderPinBumpIssue({ row, rows, report, workflow, context }) });
    actions.push(`Pin bump available for ${row.npm} (${row.range} → ${row.pinBump}). Open issue "${title}".`);
  }
  if (failures.length === 0 && report.promotable !== true) {
    warnings.push(
      `\`${report.image}\` is not promotable, but only because of skipped cases ` +
        `(${(report.promotable_blockers ?? []).join('; ') || 'no blockers listed'}). ` +
        (candidateBuilt ? 'Not promoted and no' : 'No') +
        ' issue opened. It will be retried next week, or dispatch the workflow manually.'
    );
    actions.push(candidateBuilt ? 'Not promoted (skipped cases only).' : 'No action (skipped cases only).');
  }
  if (!candidateBuilt && failures.length === 0 && report.promotable === true) {
    actions.push(`No version change; \`${report.image}\` passed. Nothing to promote.`);
  }

  const decision = { workflow, image: report.image, candidateBuilt, promote, issues, warnings, actions };
  return { ...decision, summary: renderSummary({ rows, report, decision }) };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Escape for a Markdown table cell. */
export function cell(value) {
  if (value === null || value === undefined || value === '') return '—';
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** A fenced block whose fence can't collide with backticks in `text`. */
export function fence(text) {
  const longest = Math.max(0, ...(String(text).match(/`+/g) ?? []).map((s) => s.length));
  const f = '`'.repeat(Math.max(3, longest + 1));
  return `${f}text\n${text}\n${f}`;
}

function npmLink(npm, version) {
  return `https://www.npmjs.com/package/${npm}${version ? `/v/${version}` : ''}`;
}

function workflowLabel(workflow) {
  return workflow === 'rebuild' ? 'agent image rebuild (`agent-image-rebuild.yml`)' : 'weekly harness update check (`harness-update.yml`)';
}

export function renderVersionTable(rows) {
  const lines = [
    `| Package | Old (\`${LATEST_IMAGE}\`) | New (tested) | npm latest | Dockerfile pin |`,
    '|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const arrow = r.old === r.new ? cell(r.new) : `**${cell(r.new)}**`;
    lines.push(`| \`${r.npm}\` | ${cell(r.old)} | ${arrow} | ${cell(r.latest)} | ${r.range ? `\`${r.range}\`` : 'unpinned'} |`);
  }
  return lines.join('\n');
}

function renderFailureTable(failures) {
  const lines = ['| Harness | Profile / model | Outcome | Reason |', '|---|---|---|---|'];
  for (const f of failures) {
    lines.push(`| \`${f.harness}\` | ${cell(f.what)} | ${f.outcome} | ${f.reason ? `\`${cell(f.reason)}\`` : '—'} |`);
  }
  return lines.join('\n');
}

function renderExcerpts(failures) {
  const withExcerpt = failures.filter((f) => f.excerpt);
  if (withExcerpt.length === 0) return '';
  return [
    '### Error excerpts',
    '',
    ...withExcerpt.flatMap((f) => [`**\`${f.key}\`**`, '', fence(f.excerpt), '']),
  ].join('\n');
}

function renderLinks(rows) {
  return rows
    .map((r) => {
      const p = pkgBySlot(r.slot);
      return `- ${p.name}: [npm](${npmLink(r.npm, r.pinBump ?? r.new)}) · [changelog](${p.changelog})`;
    })
    .join('\n');
}

function likelyFiles(harnesses) {
  const files = ['images/agent/Dockerfile'];
  for (const h of [...new Set(harnesses)].sort()) files.push(`packages/server/src/harnesses/${h}.ts`);
  if (harnesses.some((h) => h === 'claude-sdk')) files.push('harness/harness-sdk.ts');
  if (harnesses.some((h) => h !== 'claude-sdk')) files.push('harness/harness-cli.sh');
  return files.map((f) => `- \`${f}\``).join('\n');
}

const MARKER = '<!-- generated by scripts/harness-update.mjs -->';

export function renderFailureIssue({ rows, report, failures, candidateBuilt, workflow, context }) {
  const harnesses = [...new Set(failures.map((f) => f.harness))];
  const changed = rows.filter((r) => r.new && r.old !== r.new);
  const involved = rows.filter(
    (r) => changed.includes(r) || pkgBySlot(r.slot).harnesses.some((h) => harnesses.includes(h))
  );
  const intro = candidateBuilt
    ? `The ${workflowLabel(workflow)} built \`${report.image}\` and the harness smoke test failed, so it was **not** promoted to \`${LATEST_IMAGE}\`.`
    : `The ${workflowLabel(workflow)} smoke-tested the current \`${report.image}\` and it failed.`;
  return [
    MARKER,
    intro,
    changed.length > 0
      ? `The orchestrator needs changing to work with the new agent CLI version(s) below.`
      : 'No agent CLI version changed, so the failure comes from the orchestrator, a profile or a model.',
    context ? `\n${context}` : '',
    '',
    '## Versions',
    '',
    renderVersionTable(rows),
    '',
    '## Failing cases',
    '',
    renderFailureTable(failures),
    '',
    renderExcerpts(failures),
    '## Links',
    '',
    renderLinks(involved.length > 0 ? involved : rows),
    '',
    '## Likely files',
    '',
    likelyFiles(harnesses),
    '',
    'See `docs/04-agent-harness.md` ("Harness smoke test") for what each check and outcome means. Reproduce with:',
    '',
    fence(
      'docker build --no-cache --pull -f images/agent/Dockerfile -t orchestrator-agent:candidate .\n' +
        'docker exec orchestrator node packages/server/dist/scripts/harness-smoke.js --image orchestrator-agent:candidate'
    ),
    '',
    '## Acceptance criteria',
    '',
    '- [ ] Every case and static check listed under "Failing cases" passes the harness smoke test against an agent image built from the fixed branch.',
    '- [ ] No other case regresses: the smoke report is `promotable`.',
    '- [ ] Verification: after merge, `agent-image-rebuild.yml` rebuilds the agent image with `--no-cache --pull`, re-runs the smoke test and promotes it to `orchestrator-agent:latest`. The fix is done when that run promotes.',
    '',
  ].join('\n');
}

export function renderPinBumpIssue({ row, rows, report, workflow, context }) {
  const p = pkgBySlot(row.slot);
  const harnessCases = [...(report.static_checks ?? []), ...(report.cases ?? [])].filter((c) =>
    p.harnesses.includes(c.harness_id)
  );
  const outcomes = harnessCases.map(
    (c) => `| \`${c.key ?? `${c.harness_id}/${c.check}`}\` | ${c.outcome} | ${c.reason ? `\`${cell(c.reason)}\`` : '—'} |`
  );
  return [
    MARKER,
    `The ${workflowLabel(workflow)} found \`${row.npm}\` **${row.pinBump}** on npm. ` +
      `\`images/agent/Dockerfile\` pins \`${row.range}\` (newest in range: ${row.target ?? 'none'}, ` +
      `installed in \`${LATEST_IMAGE}\`: ${row.installed ?? 'unknown'}), so rebuilds won't pick it up.`,
    context ? `\n${context}` : '',
    '',
    `Assess the new release against \`packages/server/src/harnesses/${p.harnesses[0]}.ts\` (CLI flags, config schema, event stream; see the verification notes in its header comment), adapt the harness if needed, and bump the range.`,
    '',
    '## Versions',
    '',
    renderVersionTable(rows),
    '',
    `## Current smoke results for ${p.harnesses.map((h) => `\`${h}\``).join(', ')} (on \`${report.image}\`)`,
    '',
    '| Case / check | Outcome | Reason |',
    '|---|---|---|',
    ...(outcomes.length > 0 ? outcomes : ['| — | — | — |']),
    '',
    '## Links',
    '',
    renderLinks([row]),
    '',
    '## Likely files',
    '',
    likelyFiles(p.harnesses),
    '',
    '## Acceptance criteria',
    '',
    `- [ ] The range in \`images/agent/Dockerfile\` admits ${row.pinBump}, and the Dockerfile comment and harness header record the version verified.`,
    `- [ ] The harness smoke test passes for every ${p.harnesses.map((h) => `\`${h}\``).join(', ')} case, and the report is \`promotable\`, against an image built from the branch.`,
    '- [ ] Verification: after merge, `agent-image-rebuild.yml` rebuilds the agent image with `--no-cache --pull`, re-runs the smoke test and promotes it to `orchestrator-agent:latest`. The bump is done when that run promotes.',
    '',
  ].join('\n');
}

export function renderSummary({ rows, report, decision }) {
  const caseLines = [
    '| Case / check | Harness | Profiles | Outcome | Reason |',
    '|---|---|---|---|---|',
    ...(report.static_checks ?? []).map(
      (s) => `| \`${s.harness_id}/${s.check}\` | ${s.harness_id} | static | ${s.outcome} | ${cell(s.reason)} |`
    ),
    ...(report.cases ?? []).map(
      (c) =>
        `| \`${c.key}\` | ${c.harness_id} | ${cell(c.profile_ids?.join(', ') || 'built-in')} | ${c.outcome} | ${cell(c.reason)} |`
    ),
  ];
  const n = report.counts ?? {};
  return [
    `## Harness update — ${decision.workflow === 'rebuild' ? 'agent image rebuild' : 'weekly check'}`,
    '',
    `Smoke target: \`${report.image}\` (${decision.candidateBuilt ? 'candidate built' : 'no rebuild needed'})`,
    '',
    '### Versions',
    '',
    renderVersionTable(rows),
    '',
    '### Smoke results',
    '',
    `${n.pass ?? 0} pass, ${n.fail ?? 0} fail, ${n.skipped ?? 0} skipped, ${n.not_live_tested ?? 0} not live-tested — promotable: **${report.promotable ? 'yes' : 'no'}**`,
    ...(report.promotable_blockers ?? []).map((b) => `- ${b}`),
    '',
    ...caseLines,
    '',
    '### Decision',
    '',
    ...decision.actions.map((a) => `- ${a}`),
    ...decision.warnings.map((w) => `- ⚠️ ${w}`),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Redeploy gate
// ---------------------------------------------------------------------------

/** The orchestrator runs the harness modules and the smoke runner, so any
 *  change under packages/ means it must be redeployed before smoking. */
export function needsRedeploy(changedFiles) {
  return changedFiles.some((f) => f.trim().startsWith('packages/'));
}

// ---------------------------------------------------------------------------
// Forgejo (I/O, fetch injected)
// ---------------------------------------------------------------------------

export function forgejoClient({ apiUrl, repo, token, fetchImpl = fetch }) {
  const base = `${apiUrl.replace(/\/+$/, '')}/repos/${repo}`;
  async function request(method, path, body) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Forgejo ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.status === 204 ? null : res.json();
  }
  async function paged(path) {
    const out = [];
    for (let page = 1; ; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const items = await request('GET', `${path}${sep}limit=50&page=${page}`);
      out.push(...items);
      if (items.length < 50) return out;
    }
  }
  return {
    listLabels: () => paged('/labels'),
    createLabel: (data) => request('POST', '/labels', data),
    listOpenIssues: (label) =>
      paged(`/issues?state=open&type=issues&labels=${encodeURIComponent(label)}`),
    createIssue: (data) => request('POST', '/issues', data),
  };
}

const LABEL_SPECS = {
  'status/queued': { color: '#0075ca', exclusive: true, description: '' },
  'harness-update': {
    color: '#5319e7',
    exclusive: false,
    description: 'Opened by the harness update workflows (scripts/harness-update.mjs)',
  },
};

/** Label name → id, creating any that are missing. */
export async function ensureLabels(client, names) {
  const existing = new Map((await client.listLabels()).map((l) => [l.name, l.id]));
  const ids = [];
  for (const name of names) {
    let id = existing.get(name);
    if (id === undefined) {
      const created = await client.createLabel({ name, ...LABEL_SPECS[name] });
      id = created.id;
      existing.set(name, id);
    }
    ids.push(id);
  }
  return ids;
}

/** Create each issue unless an open `harness-update` issue already has the
 *  same title. Returns what happened per issue. */
export async function openIssues(client, issues, log = () => {}) {
  if (issues.length === 0) return [];
  const open = await client.listOpenIssues(DEDUP_LABEL);
  const openByTitle = new Map(open.map((i) => [i.title.trim(), i]));
  const labelIds = await ensureLabels(client, ISSUE_LABELS);
  const results = [];
  for (const issue of issues) {
    const dup = openByTitle.get(issue.title.trim());
    if (dup) {
      log(`skip: open issue #${dup.number} already has title "${issue.title}"`);
      results.push({ title: issue.title, action: 'skipped', number: dup.number });
      continue;
    }
    const created = await client.createIssue({ title: issue.title, body: issue.body, labels: labelIds });
    openByTitle.set(issue.title.trim(), created);
    log(`created issue #${created.number}: ${issue.title}`);
    results.push({ title: issue.title, action: 'created', number: created.number });
  }
  return results;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${a} needs a value`);
      flags[a.slice(2)] = value;
      i++;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function required(flags, name) {
  if (!flags[name]) throw new Error(`--${name} is required`);
  return flags[name];
}

async function readJson(path) {
  return JSON.parse(await fs.readFile(path, 'utf-8'));
}

async function appendSummary(path, text) {
  if (path) await fs.appendFile(path, `${text}\n`, 'utf-8');
}

export async function main(argv, env = process.env) {
  const [command, ...rest] = argv;
  const { flags, positional } = parseFlags(rest);
  const say = (t) => process.stdout.write(`${t}\n`);
  const warn = (t) => process.stderr.write(`warning: ${t}\n`);

  switch (command) {
    case 'detect': {
      const dockerfile = await fs.readFile(flags.dockerfile ?? 'images/agent/Dockerfile', 'utf-8');
      const versions = await detect({ image: flags.image ?? LATEST_IMAGE, dockerfile, warn });
      await fs.writeFile(required(flags, 'out'), `${JSON.stringify(versions, null, 2)}\n`);
      for (const p of versions.packages) {
        say(
          `${p.npm}: installed ${p.installed ?? '?'}, target ${p.target ?? '?'}` +
            `${p.range ? ` (range ${p.range})` : ''}${p.changed ? ' — CHANGED' : ''}` +
            `${p.pinBump ? ` — pin bump available: ${p.pinBump}` : ''}`
        );
      }
      say(`changed=${versions.changed}`);
      if (env.GITHUB_OUTPUT) await fs.appendFile(env.GITHUB_OUTPUT, `changed=${versions.changed}\n`);
      return 0;
    }
    case 'decide': {
      const decision = decide({
        versions: await readJson(required(flags, 'versions')),
        report: await readJson(required(flags, 'report')),
        candidateBuilt: required(flags, 'candidate-built') === 'true',
        workflow: flags.workflow ?? 'weekly',
        context: flags.context ?? '',
      });
      await fs.writeFile(required(flags, 'out'), `${JSON.stringify(decision, null, 2)}\n`);
      say(decision.summary);
      for (const w of decision.warnings) say(`::warning::${w.replace(/\r?\n/g, ' ')}`);
      await appendSummary(flags.summary ?? env.GITHUB_STEP_SUMMARY, decision.summary);
      if (env.GITHUB_OUTPUT) {
        await fs.appendFile(
          env.GITHUB_OUTPUT,
          `promote=${decision.promote}\nissues=${decision.issues.length}\n`
        );
      }
      return 0;
    }
    case 'issues': {
      const decision = await readJson(required(flags, 'decision'));
      if (decision.issues.length === 0) {
        say('No issues to open.');
        return 0;
      }
      const token = env.ISSUE_TOKEN;
      if (!token) throw new Error('ISSUE_TOKEN is not set');
      if (!env.FORGEJO_API_URL && !env.GITHUB_SERVER_URL) {
        throw new Error('set FORGEJO_API_URL or GITHUB_SERVER_URL');
      }
      if (!env.GITHUB_REPOSITORY) throw new Error('GITHUB_REPOSITORY is not set');
      const apiUrl = env.FORGEJO_API_URL || `${env.GITHUB_SERVER_URL}/api/v1`;
      const repo = env.GITHUB_REPOSITORY;
      const results = await openIssues(forgejoClient({ apiUrl, repo, token }), decision.issues, say);
      await appendSummary(
        env.GITHUB_STEP_SUMMARY,
        ['### Issues', '', ...results.map((r) => `- #${r.number} ${r.action}: ${r.title}`), ''].join('\n')
      );
      return 0;
    }
    case 'needs-redeploy': {
      const files = positional.length > 0 ? positional : (await readStdin()).split('\n').filter(Boolean);
      const redeploy = needsRedeploy(files);
      say(`redeploy=${redeploy}`);
      if (env.GITHUB_OUTPUT) await fs.appendFile(env.GITHUB_OUTPUT, `redeploy=${redeploy}\n`);
      return 0;
    }
    default:
      throw new Error(`unknown command '${command ?? ''}' (detect | decide | issues | needs-redeploy)`);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf-8');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(1);
    }
  );
}
