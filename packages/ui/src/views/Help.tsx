import { Link } from 'react-router-dom';
import { AppHeader } from '../components/AppHeader.js';

export function Help() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <AppHeader
        back={
          <Link to="/" className="text-blue-400 hover:text-blue-300 text-sm">
            &larr; Dashboard
          </Link>
        }
        title="Help & Usage Guide"
        meta={
          <p className="text-sm text-gray-400">
            How to configure and drive the orchestrator from this UI. For
            host-side bring-up (Docker, compose,{' '}
            <code className="font-mono">.env</code>, building images, Forgejo
            OAuth / webhook secret), see{' '}
            <code className="font-mono">docs/quick-start.md</code> in the repo.
          </p>
        }
      />

      {/* A fixed 200px first column leaves ~95px of article on a 375px
          phone, so the two-column shell only applies from `lg` up; below
          that the grid is a single column and the TOC stacks above the
          article as its own row. */}
      <main className="mx-auto max-w-4xl px-6 py-6 grid grid-cols-1 lg:grid-cols-[200px_1fr] gap-8">
        <TableOfContents />

        <div className="space-y-12 min-w-0">
          <OneTimeSetup />
          <TaskLifecycle />
          <ProvidersSection />
          <AgentProfilesSection />
          <RepositoriesSection />
          <GlobalSettingsSection />
          <RunningTasks />
          <UIControls />
          <CommonIssues />
        </div>
      </main>
    </div>
  );
}

const SECTIONS: Array<{ id: string; label: string }> = [
  { id: 'one-time-setup', label: 'One-time setup' },
  { id: 'task-lifecycle', label: 'Task lifecycle' },
  { id: 'providers', label: 'Providers & Models' },
  { id: 'agent-profiles', label: 'Agent Profiles' },
  { id: 'repositories', label: 'Repositories' },
  { id: 'global-settings', label: 'Global Settings' },
  { id: 'running-tasks', label: 'Running tasks' },
  { id: 'ui-controls', label: 'UI controls' },
  { id: 'common-issues', label: 'Common issues' },
];

/** Two forms of the same list of links, one shown at a time. Only the
 *  visible one is in the accessibility tree — `display: none` removes the
 *  other outright — so the duplicated `aria-label` is never ambiguous.
 *
 *  Desktop keeps the sticky 200px column byte-for-byte as it was. Below
 *  `lg` the links stack above the article, where nine of them would push
 *  the content a screenful down, so they live behind a native
 *  `<details>` disclosure instead. */
function TableOfContents() {
  return (
    <>
      <details className="group lg:hidden bg-gray-900 border border-gray-800 rounded">
        {/* `list-none` + the webkit pseudo-element drop the default
            triangle in favour of the caret below, which is rotated by
            the open state. `py-3` makes the row 44px — the minimum
            comfortable touch target. */}
        <summary className="flex cursor-pointer items-center gap-2 px-3 py-3 text-xs uppercase tracking-wide text-gray-500 list-none [&::-webkit-details-marker]:hidden">
          <Caret />
          On this page
        </summary>
        <nav aria-label="Table of contents" className="px-3 pb-2 text-sm">
          <ul>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                {/* Padding (not height) so the 44px target is the link
                    itself, not a gap next to it. */}
                <a
                  href={`#${s.id}`}
                  className="block py-3 text-blue-400 hover:text-blue-300"
                >
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </details>

      <nav
        aria-label="Table of contents"
        className="hidden lg:block sticky top-6 self-start text-sm"
      >
        <div className="text-gray-500 uppercase text-xs tracking-wide mb-2">
          On this page
        </div>
        <ul className="space-y-1">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                className="text-blue-400 hover:text-blue-300"
              >
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}

/** Disclosure caret for the mobile TOC, rotated by the parent
 *  `<details>` open state. Inline so Help keeps its zero-dependency
 *  footprint; `currentColor` so it inherits the summary's gray. */
function Caret() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 4l6 6-6 6" />
    </svg>
  );
}

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      className="text-xl font-semibold text-gray-100 border-b border-gray-800 pb-2 mb-4 scroll-mt-6"
    >
      {children}
    </h2>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-base font-medium text-gray-200 mt-4 mb-2">{children}</h3>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    /* `break-words` only kicks in for a token that would otherwise
       overflow its line — at desktop widths nothing here is long enough,
       so the rendering is unchanged. Without it a long unbroken
       identifier (e.g. `default_review_agent_profile_id`) widens the
       document on a 375px screen. */
    <code className="font-mono text-xs bg-gray-800 text-gray-200 px-1.5 py-0.5 rounded break-words">
      {children}
    </code>
  );
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre className="bg-gray-900 border border-gray-800 rounded p-3 text-xs font-mono text-gray-200 overflow-x-auto whitespace-pre-wrap">
      {children}
    </pre>
  );
}

function OneTimeSetup() {
  return (
    <section id="one-time-setup">
      <SectionHeading id="one-time-setup">One-time setup</SectionHeading>
      <p className="text-sm text-gray-300">
        On first boot the orchestrator's schema migration auto-seeds the
        standard cloud providers (Anthropic, OpenAI, Gemini, Mistral,
        DeepSeek, OpenRouter) with a representative model each, plus a
        default <Code>Claude SDK + Sonnet</Code> agent profile pointed at
        Anthropic. <Code>settings.default_agent_profile_id</Code> is set
        to that profile, so the system is usable out of the box as long
        as <Code>ANTHROPIC_API_KEY</Code> is set in the orchestrator's{' '}
        <Code>.env</Code>.
      </p>
      <p className="text-sm text-gray-300 mt-3">There's no seed script.</p>
      <p className="text-sm text-gray-300 mt-3">From the UI, the typical first-run flow is:</p>
      <ol className="list-decimal list-inside text-sm text-gray-300 space-y-1 mt-2">
        <li>
          Open{' '}
          <Link to="/settings" className="text-blue-400 hover:text-blue-300">
            Settings &gt; Providers &amp; Models
          </Link>{' '}
          and verify Anthropic shows a green "credential configured"
          indicator. Other cloud providers are seeded as rows so they
          show up in dropdowns; fill in their{' '}
          <Code>api_key_env_var</Code> (or paste an inline{' '}
          <Code>auth_token</Code>) when ready.
        </li>
        <li>
          To use a self-hosted inference server (Ollama, llama.cpp /
          llama-swap, vLLM, …), add a new provider with{' '}
          <Code>kind: openai-compatible</Code>, point it at the server's{' '}
          <Code>base_url</Code>, then add the loaded models under it.
        </li>
        <li>
          Compose a profile under{' '}
          <Link to="/settings" className="text-blue-400 hover:text-blue-300">
            Settings &gt; Agent Profiles
          </Link>{' '}
          if you want anything other than Claude SDK + Sonnet as the default.
        </li>
        <li>
          Register a repository under{' '}
          <Link to="/settings" className="text-blue-400 hover:text-blue-300">
            Settings &gt; Repositories
          </Link>{' '}
          (see below).
        </li>
      </ol>
    </section>
  );
}

function TaskLifecycle() {
  const rows: Array<{ status: string; label: string; desc: string }> = [
    {
      status: 'queued',
      label: 'status/queued',
      desc: 'Issue is labelled and waiting for a free agent slot.',
    },
    {
      status: 'preparing',
      label: '(no label yet)',
      desc: 'Orchestrator is cloning the workspace, creating the branch, and starting the container.',
    },
    {
      status: 'in-progress',
      label: 'status/in-progress',
      desc: 'Agent container is running and producing code + commits.',
    },
    {
      status: 'in-review',
      label: 'status/in-review',
      desc: 'PR opened; a reviewer agent is evaluating the diff.',
    },
    {
      status: 'changes-needed',
      label: 'status/changes-needed',
      desc: 'Reviewer requested changes. Will start a new rework attempt until max_attempts is reached.',
    },
    {
      status: 'merged',
      label: '(label removed, PR merged)',
      desc: 'Reviewer approved and the PR was merged.',
    },
    {
      status: 'failed',
      label: 'status/failed',
      desc: 'Attempts exhausted or a fatal error. The branch/PR remain for inspection.',
    },
    {
      status: 'cancelled',
      label: 'status/cancelled',
      desc: 'You cancelled the task, or it was force-stopped. Container killed; branch/PR cleaned up.',
    },
    {
      status: 'awaiting-human-merge',
      label: 'human-merge',
      desc: 'Repo or task was flagged for manual merge. PR is ready; merge it yourself in Forgejo.',
    },
    {
      status: 'awaiting-human-review',
      label: 'human-review',
      desc: 'Repo or task was flagged for manual review. Review the PR yourself before it can merge.',
    },
  ];

  return (
    <section id="task-lifecycle">
      <SectionHeading id="task-lifecycle">Task lifecycle</SectionHeading>
      <p className="text-sm text-gray-300 mb-3">
        A task moves through these statuses. The orchestrator mirrors each status
        to a scoped Forgejo label on the underlying issue, so you can see where a
        task is at a glance in either place.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border border-gray-800 rounded">
          <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
            <tr>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Forgejo label</th>
              <th className="text-left px-3 py-2">What it means</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.status} className="border-t border-gray-800 align-top">
                <td className="px-3 py-2 font-mono text-xs">{r.status}</td>
                <td className="px-3 py-2 font-mono text-xs text-gray-400">
                  {r.label}
                </td>
                <td className="px-3 py-2 text-gray-300">{r.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-gray-400 mt-3">
        The <Code>rework</Code> transition from <Code>changes-needed</Code> back
        to <Code>in-progress</Code> happens automatically; you will see the
        attempt counter increment in Task Detail.
      </p>
    </section>
  );
}

function ProvidersSection() {
  return (
    <section id="providers">
      <SectionHeading id="providers">Providers &amp; Models</SectionHeading>
      <p className="text-sm text-gray-300">
        Managed under{' '}
        <Link to="/settings" className="text-blue-400 hover:text-blue-300">
          Settings &gt; Providers &amp; Models
        </Link>
        . Providers carry the connection identity for an LLM endpoint;
        models live underneath them as a nested list.
      </p>

      <SubHeading>kind</SubHeading>
      <p className="text-sm text-gray-300">
        Picks the credential shape, the standard env-var name the agent CLI
        / SDK reads inside the container, and which harnesses can target
        this provider. One of <Code>anthropic</Code>,{' '}
        <Code>claude-subscription</Code>, <Code>openai</Code>,{' '}
        <Code>gemini</Code>, <Code>mistral</Code>, <Code>deepseek</Code>,{' '}
        <Code>openrouter</Code>, <Code>openai-compatible</Code>. Adding a
        new kind is
        a code change.
      </p>

      <SubHeading>base_url</SubHeading>
      <p className="text-sm text-gray-300">
        Required for <Code>kind: openai-compatible</Code>; hidden for
        cloud kinds (the SDK uses a fixed cloud endpoint). The
        orchestrator appends <Code>/v1</Code> itself. For a server on the
        Docker host, use <Code>host.docker.internal</Code> instead of{' '}
        <Code>localhost</Code> — the container's loopback isn't the host.
      </p>

      <SubHeading>api_key_env_var vs auth_token</SubHeading>
      <p className="text-sm text-gray-300">
        Each provider declares exactly one of these (or neither, for an
        unauthenticated self-hosted server):
      </p>
      <ul className="list-disc list-inside text-sm text-gray-300 space-y-1 mt-2">
        <li>
          <Code>api_key_env_var</Code> — the name of an env var the
          orchestrator reads from its own <Code>.env</Code> at launch (e.g.{' '}
          <Code>ANTHROPIC_API_KEY</Code>). Recommended for cloud singletons.
          Secret stays out of the database.
        </li>
        <li>
          <Code>auth_token</Code> — inline plaintext stored on the provider
          row. Useful when multi-instancing a kind (two self-hosted
          servers, or
          two Anthropic accounts), or for a self-hosted server that uses
          basic-auth.
        </li>
      </ul>
      <p className="text-sm text-gray-300 mt-2">
        Whichever path is used, the orchestrator exports the resolved
        credential into the agent container under the kind's standard
        name (e.g. always <Code>ANTHROPIC_API_KEY</Code> for{' '}
        <Code>kind: anthropic</Code>, regardless of what env var on the
        orchestrator side is called).
      </p>

      <SubHeading>concurrency_limit</SubHeading>
      <p className="text-sm text-gray-300">
        Caps how many agent containers can run against this provider
        simultaneously. <Code>0</Code> pauses the provider — no task
        targeting it launches. Independent of the host resource pool,
        which gates hardware capacity. Set this to match the provider's
        upstream rate limits (or, for a self-hosted server, to{' '}
        <Code>1</Code> to serialise on a single GPU).
      </p>

      <SubHeading>Models</SubHeading>
      <p className="text-sm text-gray-300">
        Inside each provider, add the model identifiers you want to expose
        as a <Code>model_id</Code> +{' '}
        <Code>display_name</Code> pair. The <Code>model_id</Code> must be
        what the inference endpoint expects, without any provider prefix —
        harnesses that need the <Code>&lt;provider&gt;/&lt;model&gt;</Code>{' '}
        form add the prefix themselves at launch time. Deleting a model
        returns a 409 if any agent profile references it.
      </p>
    </section>
  );
}

function AgentProfilesSection() {
  return (
    <section id="agent-profiles">
      <SectionHeading id="agent-profiles">Agent Profiles</SectionHeading>
      <p className="text-sm text-gray-300">
        Managed under{' '}
        <Link to="/settings" className="text-blue-400 hover:text-blue-300">
          Settings &gt; Agent Profiles
        </Link>
        . A profile is the operator-composed pairing that tasks reference:
        a code-defined harness, a (provider, model), per-harness config, and
        a wall-clock timeout.
      </p>

      <SubHeading>harness_id</SubHeading>
      <p className="text-sm text-gray-300">
        One of the four shipped harnesses:
      </p>
      <ul className="list-disc list-inside text-sm text-gray-300 space-y-1 mt-2">
        <li>
          <Code>claude-sdk</Code> — Claude Agent SDK invoked in-process.
          Targets <Code>kind: anthropic</Code> only. Simplest, most-tested.
          Used by the bootstrap profile.
        </li>
        <li>
          <Code>claude-code</Code> — Claude Code CLI subprocess. Targets{' '}
          <Code>anthropic</Code> or <Code>claude-subscription</Code>.
        </li>
        <li>
          <Code>opencode</Code> — OpenCode CLI subprocess. Targets every
          provider kind OpenCode supports (cloud +{' '}
          <Code>openai-compatible</Code>).
        </li>
        <li>
          <Code>pi</Code> —{' '}
          <Code>@earendil-works/pi-coding-agent</Code> CLI subprocess. Targets
          every provider kind pi supports.
        </li>
      </ul>
      <p className="text-sm text-gray-300 mt-2">
        Harnesses are code, not config — adding one means a new module
        under <Code>packages/server/src/harnesses/</Code>, not a UI action.
      </p>

      <SubHeading>model_pk</SubHeading>
      <p className="text-sm text-gray-300">
        The model picker is scoped to the chosen harness's
        supported provider kinds, so you can't accidentally pair{' '}
        <Code>claude-sdk</Code> with an OpenAI model. (If you do force the
        mismatch via the API, the launch fails loudly with a clear "harness
        X doesn't support kind Y" message — the trade-off was no save-time
        validation.)
      </p>

      <SubHeading>config_json</SubHeading>
      <p className="text-sm text-gray-300">
        Per-harness knobs the harness module understands. The form renders
        a different React component per <Code>harness_id</Code> — empty
        for harnesses with no operator-tunable knobs, structured fields
        for harnesses that take options (e.g. <Code>max_turns</Code>).
        Stored as JSON on the profile row; the harness's{' '}
        <Code>validateConfig</Code> hook runs server-side on save.
      </p>

      <SubHeading>timeout_minutes</SubHeading>
      <p className="text-sm text-gray-300">
        Required wall-clock timeout (minutes) for any agent attempt using
        this profile. Form pre-fills new profiles with <Code>2880</Code>{' '}
        (48 h), matching the DB column default and the seeded bootstrap
        profile. Typical values: <Code>120</Code> for paid APIs to cap a
        runaway agent; <Code>2880</Code> for free local servers where a
        slow generation is cheap.
      </p>
    </section>
  );
}

function RepositoriesSection() {
  return (
    <section id="repositories">
      <SectionHeading id="repositories">Repositories settings</SectionHeading>
      <p className="text-sm text-gray-300">
        Managed under{' '}
        <Link to="/settings" className="text-blue-400 hover:text-blue-300">
          Settings &gt; Repositories
        </Link>
        . A repository must be registered here before the orchestrator will
        accept tasks for it.
      </p>

      <SubHeading>Adding a repository</SubHeading>
      <ol className="list-decimal list-inside text-sm text-gray-300 space-y-1">
        <li>Click <strong>+ Add repository</strong>.</li>
        <li>
          Pick from the <strong>Repository</strong> dropdown — this is populated
          from Forgejo via <Code>/api/repos/available</Code>, filtered to repos
          not yet registered here.
        </li>
        <li>Set the remaining fields (see below) and Save.</li>
      </ol>
      <p className="text-sm text-gray-300 mt-2">
        The orchestrator clones the repo into <Code>/workspaces/</Code> on its
        first task, not when you save the row.
      </p>

      <SubHeading>Field reference</SubHeading>
      <ul className="list-disc list-inside text-sm text-gray-300 space-y-2">
        <li>
          <Code>agent_profile_id</Code> — default implementation-stage
          agent profile for this repo. Leave blank to inherit{' '}
          <Code>settings.default_agent_profile_id</Code>. Can be
          overridden per-task when queueing.
        </li>
        <li>
          <Code>review_agent_profile_id</Code> — default review-stage
          agent profile for this repo. Leave blank to inherit the global
          review default, which itself falls back to the implementation
          profile (review runs with the same profile that implemented).
          Useful when a cheap/local model implements and a stronger model
          reviews. Can be overridden per-task when queueing.
        </li>
        <li>
          <Code>install_steps</Code> — ordered list of typed dependency-install
          steps the harness runs sequentially before the agent starts, under a
          single <Code>flock</Code> against the shared cache mount. Each step
          picks a kind from the dropdown (<Code>npm-ci</Code>,{' '}
          <Code>pnpm-install</Code>, <Code>pip-requirements</Code>,{' '}
          <Code>cargo-fetch</Code>, etc.) and an optional <Code>cwd</Code>{' '}
          relative to <Code>/repo</Code>. The orchestrator maps each kind to a
          hardcoded command — operators can't inject shell here. For monorepos
          add multiple steps with different <Code>cwd</Code> values.
        </li>
        <li>
          <Code>allow_script_steps</Code> — per-repo toggle that enables the{' '}
          <Code>script</Code> install-step kind, which runs{' '}
          <Code>bash &lt;path&gt;</Code> against a path inside the repo. The
          script inherits the agent container env (provider credential under
          the kind's standard name, agent git token), so anyone with commit
          access to the repo can change what runs. Default off; flip on
          consciously per repo.
        </li>
        <li>
          <Code>merge_strategy</Code> — your preferred PR merge style
          (squash / merge / rebase). Defaults to <Code>squash</Code>. At
          merge time the orchestrator queries the repo's Forgejo-side
          allowed strategies and uses your preference if it's permitted;
          otherwise it falls back to the first allowed style (priority:
          squash &gt; merge &gt; rebase &gt; rebase-merge &gt;
          fast-forward-only). If the repo only allows one strategy, that one
          is used regardless of your preference.
        </li>
        <li>
          Memory (MB) and CPU cores — leave blank to use the compile-time
          defaults (4096 MB, 2 cores in <Code>constants.ts</Code>). Set
          per-repo when a heavy workload (Rust workspace, large Next.js
          build, Bazel) needs more headroom.
        </li>
      </ul>

      <SubHeading>Registering the Forgejo webhook</SubHeading>
      <p className="text-sm text-gray-300">
        After saving the repository, register a webhook on the Forgejo side so
        the orchestrator picks up label changes and comments in real time
        (otherwise it only sees changes at the next poll cycle):
      </p>
      <ul className="list-disc list-inside text-sm text-gray-300 space-y-1 mt-2">
        <li>
          URL: <Code>&lt;ORCHESTRATOR_URL&gt;/webhooks/forgejo</Code>
        </li>
        <li>
          Secret: the <Code>FORGEJO_WEBHOOK_SECRET</Code> value from the
          orchestrator's <Code>.env</Code>.
        </li>
        <li>
          Events: <strong>Issues</strong>, <strong>Issue Comment</strong>,{' '}
          <strong>Pull Request</strong>.
        </li>
      </ul>
    </section>
  );
}

function GlobalSettingsSection() {
  return (
    <section id="global-settings">
      <SectionHeading id="global-settings">Global Settings</SectionHeading>
      <p className="text-sm text-gray-300">
        Managed under{' '}
        <Link to="/settings" className="text-blue-400 hover:text-blue-300">
          Settings &gt; Global Settings
        </Link>
        . These apply to every repo and agent profile unless overridden.
      </p>
      <ul className="list-disc list-inside text-sm text-gray-300 space-y-2 mt-2">
        <li>
          <Code>max_agent_memory_mb</Code> and <Code>max_agent_cpu_cores</Code>{' '}
          — the host resource pool. The orchestrator launches a candidate task
          only when its repo's <Code>container_memory_mb</Code> /{' '}
          <Code>container_cpu_cores</Code> both fit in the remaining pool. The
          Dashboard header shows live utilisation as{' '}
          <Code>Mem: used/total GB · CPU: used/total</Code>. Lower the pool if
          the host is constrained; raise it (and per-repo container sizing) if
          the queue stacks up despite headroom.
        </li>
        <li>
          <Code>default_agent_profile_id</Code> — the fallback
          implementation-stage profile when neither the task nor the repo
          specifies one. Picker is populated from{' '}
          <Link to="/settings" className="text-blue-400 hover:text-blue-300">
            Settings &gt; Agent Profiles
          </Link>
          . The v21 bootstrap seeds this to the Claude SDK + Sonnet
          profile; switch it to whatever your team uses by default.
        </li>
        <li>
          <Code>default_review_agent_profile_id</Code> — the fallback
          review-stage profile when neither the task nor the repo
          specifies one. Unset by default: reviews then run with the
          same profile that implemented. Set it to send every automated
          review to a stronger model regardless of which profile
          implements.
        </li>
      </ul>
      <p className="text-xs text-gray-500 mt-3">
        Wall-clock timeout is a per-profile concern (see{' '}
        <Code>timeout_minutes</Code> on each agent profile) — there is no
        global default. CLI harnesses encode any per-turn flag inside their
        invocation builder (e.g. claude-code's{' '}
        <Code>--max-turns 100</Code>); the SDK harness uses the SDK's
        own default. The wall-clock timeout is the lifetime safety net
        that kills the container regardless of turn count.
      </p>
      <p className="text-xs text-gray-500 mt-3">
        Several defaults are compile-time constants in{' '}
        <Code>packages/server/src/constants.ts</Code> rather than UI settings,
        because they have no real per-install tuning case:{' '}
        <Code>POLL_INTERVAL_SECONDS</Code> (60s fallback poll cadence),{' '}
        <Code>DEFAULT_MAX_ATTEMPTS</Code> (7 — overrideable per-task at
        creation and from the Task Detail page),{' '}
        <Code>WORKSPACE_RETENTION_DAYS</Code> (7 — applied uniformly to all
        terminal-state workspaces and to orphan workspaces with no task row),
        and{' '}
        <Code>DEFAULT_CONTAINER_MEMORY_MB</Code> /{' '}
        <Code>DEFAULT_CONTAINER_CPU_CORES</Code> (4096 / 2 — overrideable
        per-repo for heavy workloads).
      </p>
    </section>
  );
}

function RunningTasks() {
  return (
    <section id="running-tasks">
      <SectionHeading id="running-tasks">Running tasks</SectionHeading>

      <SubHeading>Queueing a task</SubHeading>
      <p className="text-sm text-gray-300">There are two ways to kick off work:</p>
      <ul className="list-disc list-inside text-sm text-gray-300 space-y-2 mt-2">
        <li>
          <strong>Label an existing Forgejo issue</strong> with{' '}
          <Code>status/queued</Code>. This is the lowest-friction path — write
          the task as a normal issue in Forgejo, add the label, done. The
          orchestrator picks it up within one poll cycle (60s) or immediately
          if webhooks are wired up.
        </li>
        <li>
          <strong>Create Task button</strong> (+ Add task on the Dashboard, or
          go to <Link to="/tasks/new" className="text-blue-400 hover:text-blue-300">/tasks/new</Link>).
          Two sub-modes:
          <ul className="list-[circle] list-inside ml-5 mt-1 space-y-1">
            <li>
              <em>Create</em> — write a title + description in the UI, which
              creates a new Forgejo issue and queues it.
            </li>
            <li>
              <em>Queue</em> — pick an existing Forgejo issue from the
              selected repo and queue it.
            </li>
          </ul>
          Both modes let you override the agent profile, max attempts, and
          flag the task for human merge / human review.
        </li>
      </ul>

      <SubHeading>Task dependencies</SubHeading>
      <p className="text-sm text-gray-300">
        A task can declare that it must wait for other issues by listing them
        as checklist items under a <Code>## Dependencies</Code> heading in its
        issue body:
      </p>
      <CodeBlock>{`## Dependencies
- [ ] #38
- [ ] #39`}</CodeBlock>
      <ul className="list-disc list-inside text-sm text-gray-300 space-y-2 mt-2">
        <li>
          A dependency is <strong>satisfied when its issue is closed</strong>{' '}
          (a dependency tracked by a merged orchestrator task counts
          immediately). Until every listed issue is satisfied the task stays
          queued and shows a <Code>blocked</Code> badge — blocked is
          display-only, never a status on Forgejo or in the database.
        </li>
        <li>
          <strong>Tick the box</strong> (<Code>- [x] #38</Code>) to manually
          override a dependency — useful when the work happened outside the
          listed issue, or to neutralise a bad reference without deleting the
          line.
        </li>
        <li>
          Checklist items <em>outside</em> the <Code>## Dependencies</Code>{' '}
          section are ignored, so acceptance-criteria checklists never gate
          scheduling. References to other repos (<Code>owner/repo#5</Code>)
          and URLs are not supported.
        </li>
        <li>
          The issue body on Forgejo is the source of truth: edits sync
          instantly via webhook and within one poll cycle (60s) without.
          Unsatisfiable references (a deleted issue, a circular dependency)
          keep the task blocked and are explained on the Task Detail page,
          which also has a <em>Re-check now</em> button.
        </li>
      </ul>

      <SubHeading>Tracking progress</SubHeading>
      <ul className="list-disc list-inside text-sm text-gray-300 space-y-2 mt-2">
        <li>
          <Link to="/" className="text-blue-400 hover:text-blue-300">Dashboard</Link>{' '}
          — live-updates over WebSocket. Three sections: Active, Queue, Recent.
          Click any task to drill in.
        </li>
        <li>
          <strong>Task Detail</strong> — streams <Code>progress.log</Code>{' '}
          (the agent's live stdout), shows a Timeline of orchestrator events,
          and lists each attempt with the snapshotted{' '}
          <Code>harness_id</Code> and <Code>model_id</Code>.
        </li>
        <li>
          <strong>Forgejo</strong> — the actual audit trail: branch{' '}
          <Code>agent/issue-N-*</Code>, PR, and per-step comments on the issue.
        </li>
      </ul>
    </section>
  );
}

function UIControls() {
  return (
    <section id="ui-controls">
      <SectionHeading id="ui-controls">UI controls</SectionHeading>

      <SubHeading>Pause / Resume (Dashboard header)</SubHeading>
      <p className="text-sm text-gray-300">
        Global pause. When paused, no new containers will start and queued tasks
        stay queued. Tasks already running continue to completion. Use this when
        you want to do a config change or investigate a stuck system without
        killing anything in flight.
      </p>

      <SubHeading>Task Detail action buttons</SubHeading>
      <p className="text-sm text-gray-300">
        Which buttons appear depends on the task's current status.
      </p>
      <ul className="list-disc list-inside text-sm text-gray-300 space-y-2 mt-2">
        <li>
          <strong>Cancel</strong> (active tasks) — stop the running container,
          clean up the branch and PR, move the task to{' '}
          <Code>cancelled</Code>. Use for tasks that are clearly going nowhere
          and shouldn't keep running.
        </li>
        <li>
          <strong>Reset</strong> (failed / cancelled / awaiting-human statuses)
          — delete the branch, PR, and all attempts, and return the underlying
          issue to an unqueued state. Destructive: everything the agent
          produced is gone. Use when you want to re-attempt from scratch.
        </li>
        <li>
          <strong>Force Approve</strong> (in-review only) — skip the reviewer
          agent and merge the PR now. Use when you've eyeballed the diff in
          Forgejo and know it's fine, or when the reviewer is deadlocked.
        </li>
        <li>
          <strong>Force Fail</strong> (active tasks) — mark the task as failed
          without running more rework attempts. The container is stopped but
          the branch/PR are kept for inspection. Less destructive than Reset:
          useful when you want to keep the artifacts but stop retrying.
        </li>
      </ul>
    </section>
  );
}

function CommonIssues() {
  return (
    <section id="common-issues">
      <SectionHeading id="common-issues">Common issues</SectionHeading>
      <ul className="space-y-4 text-sm text-gray-300">
        <li>
          <strong>"Agent profile 'X' not found"</strong> — the repo or task
          references a profile id that no longer exists. Reassign in{' '}
          <Link to="/settings" className="text-blue-400 hover:text-blue-300">
            Settings &gt; Repositories
          </Link>
          {' '}or in the task detail view, or recreate the profile under{' '}
          <Link to="/settings" className="text-blue-400 hover:text-blue-300">
            Settings &gt; Agent Profiles
          </Link>
          .
        </li>
        <li>
          <strong>"Provider credential missing"</strong> — the profile's
          provider has <Code>api_key_env_var</Code> pointing at an env var
          that isn't set on the orchestrator host. Set it in{' '}
          <Code>.env</Code> and restart, or paste an inline{' '}
          <Code>auth_token</Code> onto the provider row under{' '}
          <Link to="/settings" className="text-blue-400 hover:text-blue-300">
            Settings &gt; Providers &amp; Models
          </Link>
          .
        </li>
        <li>
          <strong>"Harness X doesn't support kind Y" at task launch</strong>{' '}
          — a profile pairs a harness with a provider whose kind isn't in
          its <Code>supported_provider_kinds</Code>. Compatibility is
          checked at launch (not save) by design. Edit the profile to
          point at a model whose provider kind the harness supports.
        </li>
        <li>
          <strong>Container never starts</strong> — on the host, check{' '}
          <Code>docker images</Code> for the{' '}
          <Code>orchestrator-agent:latest</Code> image, and{' '}
          <Code>docker network ls</Code> for <Code>agent-network</Code>. Check
          orchestrator logs for <Code>docker_connection_failed</Code>.
        </li>
        <li>
          <strong>Container runs but agent errors immediately</strong> — the
          underlying CLI's flags may have shifted in a new release. Exec
          into the image to confirm:{' '}
          <Code>docker run --rm -it orchestrator-agent:latest bash</Code>,
          then <Code>claude --help</Code>, <Code>opencode --help</Code>,
          or <Code>pi --help</Code>. Fix the matching harness module
          under <Code>packages/server/src/harnesses/</Code> and rebuild
          the agent image.
        </li>
        <li>
          <strong>Agent pushes branch but no PR appears</strong> — the
          orchestrator's Forgejo token may be missing{' '}
          <Code>write:repository</Code>. Check logs for{' '}
          <Code>forgejo_api_error</Code>.
        </li>
        <li>
          <strong>Webhook events not arriving</strong> — verify{' '}
          <Code>ORCHESTRATOR_URL</Code> is reachable from the Forgejo host and
          that the webhook secret matches <Code>FORGEJO_WEBHOOK_SECRET</Code>.
          In the meantime, polling will still pick up label changes every 60s.
        </li>
      </ul>
      <p className="text-sm text-gray-400 mt-6">
        Full operational playbook: see <Code>docs/07-deployment-operations.md</Code> in the repo.
      </p>
    </section>
  );
}
