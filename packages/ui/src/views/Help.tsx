import { Link } from 'react-router-dom';

export function Help() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="sticky top-0 z-20 border-b border-gray-800 bg-gray-900 px-6 py-4">
        <Link to="/" className="text-blue-400 hover:text-blue-300 text-sm">
          &larr; Dashboard
        </Link>
        <h1 className="text-xl font-semibold mt-1">Help &amp; Usage Guide</h1>
        <p className="text-sm text-gray-400 mt-1">
          How to configure and drive the orchestrator from this UI. For host-side
          bring-up (Docker, compose, <code className="font-mono">.env</code>,
          building images, Forgejo OAuth / webhook secret), see{' '}
          <code className="font-mono">docs/quick-start.md</code> in the repo.
        </p>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-6 grid grid-cols-[200px_1fr] gap-8">
        <TableOfContents />

        <div className="space-y-12 min-w-0">
          <OneTimeSetup />
          <TaskLifecycle />
          <AgentToolsSection />
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

function TableOfContents() {
  const sections: Array<{ id: string; label: string }> = [
    { id: 'one-time-setup', label: 'One-time setup' },
    { id: 'task-lifecycle', label: 'Task lifecycle' },
    { id: 'agent-tools', label: 'Agent Tools' },
    { id: 'repositories', label: 'Repositories' },
    { id: 'global-settings', label: 'Global Settings' },
    { id: 'running-tasks', label: 'Running tasks' },
    { id: 'ui-controls', label: 'UI controls' },
    { id: 'common-issues', label: 'Common issues' },
  ];
  return (
    <nav className="sticky top-6 self-start text-sm">
      <div className="text-gray-500 uppercase text-xs tracking-wide mb-2">
        On this page
      </div>
      <ul className="space-y-1">
        {sections.map((s) => (
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
    <code className="font-mono text-xs bg-gray-800 text-gray-200 px-1.5 py-0.5 rounded">
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
      <SectionHeading id="one-time-setup">One-time setup: seed default tools</SectionHeading>
      <p className="text-sm text-gray-300">
        The <Code>agent_tools</Code> table is empty on a fresh install. You need to
        seed the four documented defaults before a repository can be configured.
        Run this once on the <strong>orchestrator host</strong> (not from the UI):
      </p>
      <CodeBlock>{`# from the host, using the running orchestrator container:
docker compose exec orchestrator node /app/scripts/seed-agent-tools.js

# or, from the repo root on the host:
npm run seed:tools`}</CodeBlock>
      <p className="text-sm text-gray-300 mt-3">The seed script inserts:</p>
      <ul className="list-disc list-inside text-sm text-gray-300 space-y-1 mt-2">
        <li>
          <Code>claude-agent-sdk</Code> — the Anthropic Claude Agent SDK, invoked
          in-process as an SDK (not a CLI). Uses the Anthropic API.
        </li>
        <li>
          <Code>claude-code-cli</Code> — the Claude Code CLI (<Code>claude</Code>),
          invoked as a subprocess. Uses the Anthropic API.
        </li>
        <li>
          <Code>opencode-anthropic</Code> — OpenCode CLI backed by the Anthropic
          API.
        </li>
        <li>
          <Code>opencode-local</Code> — OpenCode CLI pointed at a local
          OpenAI-compatible LLM endpoint. No API auth required.
        </li>
      </ul>
      <p className="text-sm text-gray-300 mt-3">
        After seeding, open <Link to="/settings" className="text-blue-400 hover:text-blue-300">Settings &gt; Agent Tools</Link>{' '}
        to review and adjust each tool (see below).
      </p>
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

function AgentToolsSection() {
  return (
    <section id="agent-tools">
      <SectionHeading id="agent-tools">Agent Tools settings</SectionHeading>
      <p className="text-sm text-gray-300">
        Managed under{' '}
        <Link to="/settings" className="text-blue-400 hover:text-blue-300">
          Settings &gt; Agent Tools
        </Link>
        . Each tool is a recipe for invoking a coding agent inside an agent
        container.
      </p>

      <SubHeading>type: cli vs sdk</SubHeading>
      <p className="text-sm text-gray-300">
        <Code>cli</Code> — the harness shells out to a binary (e.g. <Code>claude</Code>,{' '}
        <Code>opencode</Code>) and streams its stdout. Most tools are CLI.{' '}
        <Code>sdk</Code> — the harness imports the SDK in-process (currently just{' '}
        <Code>claude-agent-sdk</Code>). The <Code>command_template</Code> field is
        not used for SDK tools.
      </p>

      <SubHeading>command_template</SubHeading>
      <p className="text-sm text-gray-300">
        A shell command that uses the <Code>{'{{PROMPT_FILE}}'}</Code> placeholder
        to reference the task prompt. The harness replaces{' '}
        <Code>{'{{PROMPT_FILE}}'}</Code> with the absolute path to a file
        containing the prompt before running the command. Two common shapes:
      </p>
      <ul className="list-disc list-inside text-sm text-gray-300 space-y-1 mt-2">
        <li>
          <strong>File flag</strong> — when the CLI takes the prompt via a file
          argument:
          <CodeBlock>{`claude --prompt-file {{PROMPT_FILE}} --max-turns 40`}</CodeBlock>
        </li>
        <li>
          <strong>Inline string</strong> — when the CLI takes the prompt as a
          string argument, read the file via <Code>{'$(cat ...)'}</Code> inside
          double quotes so the content is passed as a single argument and shell
          metacharacters in the prompt stay inert:
          <CodeBlock>{`opencode run "$(cat {{PROMPT_FILE}})" --non-interactive`}</CodeBlock>
        </li>
      </ul>
      <p className="text-sm text-gray-300 mt-2">
        Pick whichever the CLI actually supports. If the flags change in a new
        version of the CLI, update this field — no code change needed.
      </p>

      <SubHeading>Provider credentials</SubHeading>
      <p className="text-sm text-gray-300">
        The orchestrator forwards a fixed set of well-known LLM provider keys
        (<Code>ANTHROPIC_API_KEY</Code>, <Code>CLAUDE_CODE_OAUTH_TOKEN</Code>,{' '}
        <Code>OPENAI_API_KEY</Code>, <Code>GEMINI_API_KEY</Code>,{' '}
        <Code>OPENROUTER_API_KEY</Code>, <Code>DEEPSEEK_API_KEY</Code>,{' '}
        <Code>MISTRAL_API_KEY</Code>) from its own <Code>.env</Code> into every
        agent container at launch. The underlying CLI/SDK picks up whichever
        key it needs; unused keys sit harmlessly. Set credentials in the
        orchestrator's <Code>.env</Code> file and check status under{' '}
        <Link to="/settings" className="text-blue-400 hover:text-blue-300">
          Settings &gt; Credentials
        </Link>
        .
      </p>

      <SubHeading>env_vars</SubHeading>
      <p className="text-sm text-gray-300">
        Per-tool environment variables. The Agent Tools form splits this into
        two views:
      </p>
      <ul className="list-disc list-inside text-sm text-gray-300 space-y-1 mt-2">
        <li>
          <strong>Provider credential overrides</strong> — for each forwarded
          key, leave blank to use the orchestrator's <Code>.env</Code> default
          or set a tool-specific value (e.g. a different{' '}
          <Code>ANTHROPIC_API_KEY</Code> for an experimental account, or a{' '}
          <Code>OPENAI_BASE_URL</Code> pointing at a per-tool LLM server).
          Values typed here are stored in the database.
        </li>
        <li>
          <strong>Other environment variables</strong> — arbitrary KEY/VALUE
          rows for anything not in the forwarded-keys list (e.g. provider
          model names, log levels, custom flags read from env).
        </li>
      </ul>
      <p className="text-sm text-gray-300 mt-2">
        Per-tool values override the orchestrator's defaults on collision and
        add anything else to the container's environment. Stored as a flat
        JSON object on the tool row.
      </p>

      <SubHeading>config_file</SubHeading>
      <p className="text-sm text-gray-300">
        Optional. Some agent tools (notably OpenCode for non-built-in
        providers like Ollama, vLLM, LM Studio) read their configuration from
        a file rather than env vars or CLI flags. Setting{' '}
        <Code>config_file_path</Code> + <Code>config_file_content</Code>{' '}
        causes the orchestrator to write the content to{' '}
        <Code>/repo/&lt;path&gt;</Code> inside the container before the agent
        runs. The file is added to <Code>.git/info/exclude</Code> so it never
        lands in a commit.
      </p>
      <p className="text-sm text-gray-300 mt-2">
        Path must be relative — anchored under <Code>/repo</Code>. Tools that
        need a file outside the workspace (e.g.{' '}
        <Code>~/.pi/agent/models.json</Code>) inline the file write into{' '}
        <Code>command_template</Code> instead. The form provides a starter
        templates dropdown for common cases (OpenCode + Ollama, OpenCode +
        vLLM, OpenCode + LM Studio).
      </p>

      <SubHeading>timeout_minutes</SubHeading>
      <p className="text-sm text-gray-300">
        Required wall-clock timeout (minutes) for any agent attempt using
        this tool. Schema v17 made this a per-tool concern only — there is
        no longer a global or per-repo fallback. The form pre-fills new
        tools with <Code>2880</Code> (48 hours); operators are expected to
        type their actual budget. Typical values:{' '}
        <Code>120</Code> (2 h) for paid APIs to cap token-burn on a runaway
        agent, <Code>2880</Code> (48 h) for free local servers where a slow
        generation is cheap.
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
          <Code>agent_tool</Code> — the default agent tool for this repo. Must
          reference an existing entry from Agent Tools. Can be overridden
          per-task when queueing.
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
          script inherits the agent container env (provider keys, agent git
          token), so anyone with commit access to the repo can change what
          runs. Default off; flip on consciously per repo.
        </li>
        <li>
          <Code>timeout_minutes</Code> override — cap on agent wall-clock time
          for this repo. Blank means fall back to the tool's timeout, then the
          global default.
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
        . These apply to every repo and tool unless overridden.
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
          Also on this screen: <Code>default_model</Code>.
        </li>
      </ul>
      <p className="text-xs text-gray-500 mt-3">
        Wall-clock timeout is now a per-tool concern only — see{' '}
        <Code>timeout_minutes</Code> on each agent tool. The orchestrator
        no longer carries a global default; every tool must set its own
        budget. CLI tools also encode an internal per-turn flag in{' '}
        <Code>command_template</Code> (e.g. claude-code's{' '}
        <Code>--max-turns 100</Code>); the SDK harness uses its own
        default. The wall-clock timeout is the lifetime safety net that
        kills the container regardless of turn count.
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
          Both modes let you override the agent tool, max attempts, and flag
          the task for human merge / human review.
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
          <strong>Task Detail</strong> — streams <Code>progress.log</Code> (the
          agent's live stdout), shows a Timeline of orchestrator events, and
          lists each attempt with tokens + cost. Tokens and cost are updated
          when each attempt completes.
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
          and shouldn't keep burning tokens.
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
          <strong>"Agent tool 'X' not found"</strong> — you didn't run the seed
          script, or the repo's <Code>agent_tool</Code> field references an ID
          that doesn't exist. Seed (see{' '}
          <a href="#one-time-setup" className="text-blue-400 hover:text-blue-300">
            One-time setup
          </a>
          ) or edit the repo in{' '}
          <Link to="/settings" className="text-blue-400 hover:text-blue-300">
            Settings &gt; Repositories
          </Link>
          .
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
          CLI flags in the tool's <Code>command_template</Code> probably don't
          match the installed version. Exec into the image to confirm:{' '}
          <Code>docker run --rm -it orchestrator-agent:latest bash</Code>,
          then <Code>opencode --help</Code> or <Code>claude --help</Code>.
          Update the template in{' '}
          <Link to="/settings" className="text-blue-400 hover:text-blue-300">
            Settings &gt; Agent Tools
          </Link>
          .
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
