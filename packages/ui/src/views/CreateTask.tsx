import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import type { RepoResponse, AgentProfileResponse, IssueResponse } from '../api.js';
import { useStore } from '../store.js';
import { AppHeader } from '../components/AppHeader.js';
import { ProfileGaugeCard } from '../components/ProfileGaugeCard.js';
import ReactMarkdown from 'react-markdown';

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
        {/* Mode tabs */}
        <div className="flex gap-1 mb-6 bg-gray-900 rounded-lg p-1 w-fit">
          <button
            onClick={() => setMode('create')}
            className={`px-4 py-2 rounded text-sm ${mode === 'create' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'}`}
          >
            Create and queue
          </button>
          <button
            onClick={() => setMode('queue')}
            className={`px-4 py-2 rounded text-sm ${mode === 'queue' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'}`}
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
            <label className="block text-sm font-medium mb-1">Repository</label>
            <select
              value={repoId ?? ''}
              onChange={(e) => setRepoId(e.target.value ? parseInt(e.target.value, 10) : null)}
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
            >
              <option value="">Select repository...</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.owner}/{r.name}
                </option>
              ))}
            </select>
          </div>

          {mode === 'create' ? (
            <>
              <div>
                <label className="block text-sm font-medium mb-1">Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
                  placeholder="Task title"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm font-medium">Description</label>
                  <button
                    type="button"
                    onClick={() => setShowPreview(!showPreview)}
                    className="text-xs text-blue-400 hover:text-blue-300"
                  >
                    {showPreview ? 'Edit' : 'Preview'}
                  </button>
                </div>
                {showPreview ? (
                  <div className="bg-gray-900 border border-gray-700 rounded p-4 text-sm prose prose-invert max-w-none min-h-[150px]">
                    <ReactMarkdown>{description}</ReactMarkdown>
                  </div>
                ) : (
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm font-mono min-h-[150px]"
                    placeholder={`Describe the task...\n\n## Dependencies\n- [ ] #38\n- [ ] #39`}
                  />
                )}
              </div>
            </>
          ) : (
            <div>
              <label className="block text-sm font-medium mb-1">Issue</label>
              {!repoId ? (
                <p className="text-gray-500 text-sm">Select a repository first</p>
              ) : issues.length === 0 ? (
                <p className="text-gray-500 text-sm">No queueable issues found</p>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto">
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
                        className="accent-blue-500"
                      />
                      <span className="text-blue-400 font-mono text-sm">
                        #{issue.id}
                      </span>
                      <span className="text-sm">{issue.title}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Overrides */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">
                Implementation profile
              </label>
              <select
                value={agentProfile}
                onChange={(e) => setAgentProfile(e.target.value)}
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
              >
                <option value="">Inherit (repo / global default)</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                Review profile
              </label>
              <select
                value={reviewAgentProfile}
                onChange={(e) => setReviewAgentProfile(e.target.value)}
                disabled={humanReview}
                title={
                  humanReview
                    ? 'Human review is enabled — the automated review agent does not run.'
                    : undefined
                }
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm disabled:opacity-50"
              >
                <option value="">
                  Inherit (review default, else implementation profile)
                </option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                Max attempts
              </label>
              <input
                type="number"
                value={maxAttempts}
                onChange={(e) => setMaxAttempts(e.target.value)}
                min="1"
                placeholder="Default 7"
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
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
            <label className="block text-sm font-medium mb-1">
              Dependencies
              <span className="ml-2 text-xs font-normal text-gray-500">
                the task stays queued until each selected issue is closed
              </span>
            </label>
            {!repoId ? (
              <p className="text-gray-500 text-sm">Select a repository first</p>
            ) : depCandidates.filter((i) => mode !== 'queue' || i.id !== selectedIssueId).length === 0 ? (
              <p className="text-gray-500 text-sm">No open issues to depend on</p>
            ) : (
              <div className="space-y-1 max-h-40 overflow-y-auto bg-gray-900 border border-gray-700 rounded p-2">
                {depCandidates
                  .filter((i) => mode !== 'queue' || i.id !== selectedIssueId)
                  .map((issue) => (
                    <label
                      key={issue.id}
                      className="flex items-center gap-2 text-sm cursor-pointer rounded px-1 py-0.5 hover:bg-gray-800"
                    >
                      <input
                        type="checkbox"
                        checked={dependencies.includes(issue.id)}
                        onChange={() => toggleDependency(issue.id)}
                        className="accent-blue-500"
                      />
                      <span className="text-blue-400 font-mono">#{issue.id}</span>
                      <span className="truncate">{issue.title}</span>
                    </label>
                  ))}
              </div>
            )}
          </div>

          <div className="flex gap-6">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={humanMerge}
                onChange={(e) => setHumanMerge(e.target.checked)}
                className="accent-blue-500"
              />
              Human merge
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={humanReview}
                onChange={(e) => setHumanReview(e.target.checked)}
                className="accent-blue-500"
              />
              Human review
            </label>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white px-6 py-2 rounded text-sm font-medium"
          >
            {submitting
              ? 'Creating...'
              : mode === 'create'
                ? 'Create and queue'
                : 'Queue issue'}
          </button>
        </form>
      </main>
    </div>
  );
}
