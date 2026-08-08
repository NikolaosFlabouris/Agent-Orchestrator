import { useEffect, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import type { RepoResponse, AgentProfileResponse, IssueResponse } from '../api.js';
import { useStore } from '../store.js';
import { AppHeader } from '../components/AppHeader.js';
import { ProfileGaugeCard } from '../components/ProfileGaugeCard.js';
import ReactMarkdown from 'react-markdown';
import { Button } from '../components/Button.js';
import { Input, Select, Textarea } from '../components/Input.js';

type Mode = 'create' | 'queue';

export function CreateTask() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('create');
  const [repos, setRepos] = useState<RepoResponse[]>([]);
  const [profiles, setProfiles] = useState<AgentProfileResponse[]>([]);
  const [repoId, setRepoId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Create mode fields
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [showPreview, setShowPreview] = useState(false);

  // Queue mode fields
  const [issues, setIssues] = useState<IssueResponse[]>([]);
  const [selectedIssueId, setSelectedIssueId] = useState<number | null>(null);

  // Shared overrides
  const [agentProfile, setAgentProfile] = useState<string>('');
  const [reviewAgentProfile, setReviewAgentProfile] = useState<string>('');
  const [maxAttempts, setMaxAttempts] = useState<string>('');
  const [humanMerge, setHumanMerge] = useState(false);
  const [humanReview, setHumanReview] = useState(false);

  // Dependencies: issue numbers this task waits for. Candidates are ALL
  // open issues of the repo (tracked ones included — depending on an issue
  // that is already a task is the typical case). The server writes the
  // canonical `## Dependencies` checklist into the issue body.
  const [dependencies, setDependencies] = useState<number[]>([]);
  const [depCandidates, setDepCandidates] = useState<IssueResponse[]>([]);

  // Bumped by the Dashboard WS handler whenever an agent profile is
  // created/edited/deleted on the server. Drives a refetch so this
  // form's dropdown stays in sync with the Agent Profiles tab.
  const profilesVersion = useStore((s) => s.resourceVersions.profiles);

  // One id root for this form's label/control pairs and for the two
  // control groups (issue radios, dependency checkboxes) whose heading is
  // a group label rather than a single control's <label>.
  const uid = useId();
  const repoSelectId = `${uid}-repo`;
  const titleInputId = `${uid}-title`;
  const descriptionInputId = `${uid}-description`;
  const issueGroupLabelId = `${uid}-issue-label`;
  const profileSelectId = `${uid}-profile`;
  const reviewProfileSelectId = `${uid}-review-profile`;
  const maxAttemptsInputId = `${uid}-max-attempts`;
  const depsGroupLabelId = `${uid}-dependencies-label`;

  useEffect(() => {
    api.getRepos().then((r) => setRepos(r.repos)).catch(() => {});
  }, []);

  useEffect(() => {
    api.getAgentProfiles().then((r) => setProfiles(r.profiles)).catch(() => {});
  }, [profilesVersion]);

  // Load issues when repo changes in queue mode
  useEffect(() => {
    if (mode === 'queue' && repoId) {
      api
        .getRepoIssues(repoId)
        .then((r) => setIssues(r.issues))
        .catch(() => setIssues([]));
    }
  }, [mode, repoId]);

  // Dependency candidates follow the repo (both modes); selections reset
  // when the repo changes since the numbers are repo-scoped.
  useEffect(() => {
    setDependencies([]);
    if (!repoId) {
      setDepCandidates([]);
      return;
    }
    api
      .getRepoIssues(repoId, { all: true })
      .then((r) => setDepCandidates(r.issues))
      .catch(() => setDepCandidates([]));
  }, [repoId]);

  function toggleDependency(issueNumber: number) {
    setDependencies((prev) =>
      prev.includes(issueNumber)
        ? prev.filter((n) => n !== issueNumber)
        : [...prev, issueNumber]
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!repoId) {
      setError('Select a repository');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      if (mode === 'create') {
        if (!title.trim() || !description.trim()) {
          setError('Title and description are required');
          setSubmitting(false);
          return;
        }
        await api.createTask({
          repo_id: repoId,
          title: title.trim(),
          description: description.trim(),
          dependencies: dependencies.length > 0 ? dependencies : undefined,
          agent_profile_id: agentProfile || null,
          review_agent_profile_id: reviewAgentProfile || null,
          max_attempts: maxAttempts ? parseInt(maxAttempts, 10) : undefined,
          human_merge: humanMerge,
          human_review: humanReview,
        });
      } else {
        if (!selectedIssueId) {
          setError('Select an issue');
          setSubmitting(false);
          return;
        }
        await api.queueTask({
          issue_id: selectedIssueId,
          repo_id: repoId,
          dependencies:
            dependencies.length > 0
              ? dependencies.filter((n) => n !== selectedIssueId)
              : undefined,
          agent_profile_id: agentProfile || null,
          review_agent_profile_id: reviewAgentProfile || null,
          max_attempts: maxAttempts ? parseInt(maxAttempts, 10) : null,
          human_merge: humanMerge,
          human_review: humanReview,
        });
      }
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <AppHeader
        back={
          <Link to="/" className="text-blue-400 hover:text-blue-300 text-sm">
            &larr; Dashboard
          </Link>
        }
        title="Create Task"
      >
        <Link to="/help" className="text-blue-400 hover:text-blue-300 text-sm">
          Help
        </Link>
      </AppHeader>

      <main className="mx-auto max-w-3xl px-6 py-6">
        {/* Mode tabs. `max-w-full overflow-x-auto` caps the `w-fit` bar at
            the column width so a narrow viewport scrolls the bar rather
            than the document, and `shrink-0 whitespace-nowrap` keeps each
            pill at its natural width instead of letting flex wrap the
            labels onto two lines. `py-3` makes a pill 44px tall — the
            minimum comfortable touch target — and `sm:py-2` restores the
            original height from the tablet breakpoint up. */}
        <div className="flex gap-1 mb-6 bg-gray-900 rounded-lg p-1 w-fit max-w-full overflow-x-auto">
          <button
            type="button"
            onClick={() => setMode('create')}
            aria-pressed={mode === 'create'}
            className={`shrink-0 whitespace-nowrap px-4 py-3 sm:py-2 rounded text-sm ${mode === 'create' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'}`}
          >
            Create and queue
          </button>
          <button
            type="button"
            onClick={() => setMode('queue')}
            aria-pressed={mode === 'queue'}
            className={`shrink-0 whitespace-nowrap px-4 py-3 sm:py-2 rounded text-sm ${mode === 'queue' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'}`}
          >
            Queue existing
          </button>
        </div>

        {error && (
          <div className="bg-red-900/50 border border-red-700 text-red-200 rounded px-4 py-2 mb-4 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Repo selector */}
          <div>
            <label htmlFor={repoSelectId} className="block text-sm font-medium mb-1">
              Repository
            </label>
            <Select
              id={repoSelectId}
              surface="gray-900"
              value={repoId ?? ''}
              onChange={(e) => setRepoId(e.target.value ? parseInt(e.target.value, 10) : null)}
              className="w-full"
            >
              <option value="">Select repository...</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.owner}/{r.name}
                </option>
              ))}
            </Select>
          </div>

          {mode === 'create' ? (
            <>
              <div>
                <label htmlFor={titleInputId} className="block text-sm font-medium mb-1">
                  Title
                </label>
                <Input
                  id={titleInputId}
                  type="text"
                  surface="gray-900"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full"
                  placeholder="Task title"
                />
              </div>
              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  {/* Only a <label> while the textarea it names exists —
                      in preview mode there is no labelable control, so
                      the same text renders as a plain heading. */}
                  {showPreview ? (
                    <span className="text-sm font-medium">Description</span>
                  ) : (
                    <label htmlFor={descriptionInputId} className="text-sm font-medium">
                      Description
                    </label>
                  )}
                  {/* Padding grows the tap target to 44px and the matching
                      negative margin cancels it again, so the row's height
                      is unchanged; both drop at `sm`. */}
                  <button
                    type="button"
                    onClick={() => setShowPreview(!showPreview)}
                    aria-pressed={showPreview}
                    className="-my-3.5 py-3.5 sm:my-0 sm:py-0 text-xs text-blue-400 hover:text-blue-300"
                  >
                    {showPreview ? 'Edit' : 'Preview'}
                  </button>
                </div>
                {showPreview ? (
                  /* `overflow-x-auto` so a wide fenced code block or table
                     in the rendered markdown scrolls inside the card
                     rather than widening the document. */
                  <div className="bg-gray-900 border border-gray-700 rounded p-4 text-sm prose prose-invert max-w-none min-h-[150px] overflow-x-auto break-words">
                    <ReactMarkdown>{description}</ReactMarkdown>
                  </div>
                ) : (
                  <Textarea
                    id={descriptionInputId}
                    surface="gray-900"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="w-full max-w-full font-mono min-h-[150px]"
                    placeholder={`Describe the task...\n\n## Dependencies\n- [ ] #38\n- [ ] #39`}
                  />
                )}
              </div>
            </>
          ) : (
            <div>
              {/* A group heading, not a control label — each radio has its
                  own wrapping <label>, so this names the group instead. */}
              <div id={issueGroupLabelId} className="block text-sm font-medium mb-1">
                Issue
              </div>
              {!repoId ? (
                <p className="text-gray-500 text-sm">Select a repository first</p>
              ) : issues.length === 0 ? (
                <p className="text-gray-500 text-sm">No queueable issues found</p>
              ) : (
                <div
                  role="radiogroup"
                  aria-labelledby={issueGroupLabelId}
                  className="space-y-2 max-h-64 overflow-y-auto"
                >
                  {issues.map((issue) => (
                    <label
                      key={issue.id}
                      className={`flex items-center gap-3 p-3 rounded border cursor-pointer ${
                        selectedIssueId === issue.id
                          ? 'border-blue-500 bg-blue-950/30'
                          : 'border-gray-700 bg-gray-900 hover:border-gray-600'
                      }`}
                    >
                      <input
                        type="radio"
                        name="issue"
                        value={issue.id}
                        checked={selectedIssueId === issue.id}
                        onChange={() => setSelectedIssueId(issue.id)}
                        className="accent-blue-500 shrink-0"
                      />
                      <span className="text-blue-400 font-mono text-sm shrink-0">
                        #{issue.id}
                      </span>
                      {/* `min-w-0 break-words`: a flex item's automatic
                          minimum size is its longest word, so without this
                          a long issue title widens the row past a phone
                          viewport instead of wrapping. */}
                      <span className="text-sm min-w-0 break-words">{issue.title}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Overrides. `min-w-0` on each cell: a grid item's automatic
              minimum size is its content's min-content width, which for a
              <select> is its widest option — wider than a 375px column,
              and enough to push the document sideways. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="min-w-0">
              <label htmlFor={profileSelectId} className="block text-sm font-medium mb-1">
                Implementation profile
              </label>
              <Select
                id={profileSelectId}
                surface="gray-900"
                value={agentProfile}
                onChange={(e) => setAgentProfile(e.target.value)}
                className="w-full min-w-0"
              >
                <option value="">Inherit (repo / global default)</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="min-w-0">
              <label htmlFor={reviewProfileSelectId} className="block text-sm font-medium mb-1">
                Review profile
              </label>
              <Select
                id={reviewProfileSelectId}
                surface="gray-900"
                value={reviewAgentProfile}
                onChange={(e) => setReviewAgentProfile(e.target.value)}
                disabled={humanReview}
                title={
                  humanReview
                    ? 'Human review is enabled — the automated review agent does not run.'
                    : undefined
                }
                className="w-full min-w-0 disabled:opacity-50"
              >
                <option value="">
                  Inherit (review default, else implementation profile)
                </option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="min-w-0">
              <label htmlFor={maxAttemptsInputId} className="block text-sm font-medium mb-1">
                Max attempts
              </label>
              <Input
                id={maxAttemptsInputId}
                type="number"
                surface="gray-900"
                value={maxAttempts}
                onChange={(e) => setMaxAttempts(e.target.value)}
                min="1"
                placeholder="Default 7"
                className="w-full min-w-0"
              />
            </div>
          </div>

          {/* Advisory performance gauge for the selected repo + implementation
              profile. Shown only when an explicit profile is picked (inherited
              defaults aren't resolved to a concrete model client-side) and the
              profile resolves to a model. Purely a hint — never gates submit. */}
          {(() => {
            if (!repoId || !agentProfile) return null;
            const selected = profiles.find((p) => p.id === agentProfile);
            if (!selected || !selected.model_id) return null;
            return (
              <ProfileGaugeCard
                key={`${repoId}:${selected.id}`}
                repoId={repoId}
                modelId={selected.model_id}
                harnessId={selected.harness_id}
                profileLabel={selected.display_name}
              />
            );
          })()}

          {/* Dependencies */}
          <div>
            {/* Group heading rather than a control label — each checkbox
                below carries its own wrapping <label>. */}
            <div id={depsGroupLabelId} className="block text-sm font-medium mb-1">
              Dependencies
              <span className="ml-2 text-xs font-normal text-gray-500">
                the task stays queued until each selected issue is closed
              </span>
            </div>
            {!repoId ? (
              <p className="text-gray-500 text-sm">Select a repository first</p>
            ) : depCandidates.filter((i) => mode !== 'queue' || i.id !== selectedIssueId).length === 0 ? (
              <p className="text-gray-500 text-sm">No open issues to depend on</p>
            ) : (
              <div
                role="group"
                aria-labelledby={depsGroupLabelId}
                className="space-y-1 max-h-40 overflow-y-auto bg-gray-900 border border-gray-700 rounded p-2"
              >
                {depCandidates
                  .filter((i) => mode !== 'queue' || i.id !== selectedIssueId)
                  .map((issue) => (
                    /* `py-2` on a phone makes each row tappable without
                       precision aiming; `sm:py-0.5` keeps the dense list
                       the desktop layout has always had. */
                    <label
                      key={issue.id}
                      className="flex items-center gap-2 text-sm cursor-pointer rounded px-1 py-2 sm:py-0.5 hover:bg-gray-800"
                    >
                      <input
                        type="checkbox"
                        checked={dependencies.includes(issue.id)}
                        onChange={() => toggleDependency(issue.id)}
                        className="accent-blue-500 shrink-0"
                      />
                      <span className="text-blue-400 font-mono shrink-0">#{issue.id}</span>
                      {/* `min-w-0` so `truncate` can actually shrink the
                          title — a flex item won't go below its
                          min-content width without it. */}
                      <span className="truncate min-w-0">{issue.title}</span>
                    </label>
                  ))}
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <label className="flex items-center gap-2 text-sm min-h-11 sm:min-h-0">
              <input
                type="checkbox"
                checked={humanMerge}
                onChange={(e) => setHumanMerge(e.target.checked)}
                className="accent-blue-500"
              />
              Human merge
            </label>
            <label className="flex items-center gap-2 text-sm min-h-11 sm:min-h-0">
              <input
                type="checkbox"
                checked={humanReview}
                onChange={(e) => setHumanReview(e.target.checked)}
                className="accent-blue-500"
              />
              Human review
            </label>
          </div>

          <Button
            type="submit"
            disabled={submitting}
            className="min-h-11 sm:min-h-0 disabled:bg-gray-700 disabled:text-gray-500 px-6 py-2 text-sm font-medium"
          >
            {submitting
              ? 'Creating...'
              : mode === 'create'
                ? 'Create and queue'
                : 'Queue issue'}
          </Button>
        </form>
      </main>
    </div>
  );
}
