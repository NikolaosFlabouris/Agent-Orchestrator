import type { Repo } from '@orchestrator/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ForgejoIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  labels: ForgejoLabel[];
  assignees: ForgejoUser[];
  html_url: string;
  created_at: string;
}

export interface ForgejoLabel {
  id: number;
  name: string;
  color: string;
  exclusive: boolean;
}

export interface ForgejoPullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  merged: boolean;
  mergeable: boolean;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string };
}

export interface ForgejoBranch {
  name: string;
  commit: { id: string; message: string };
}

export interface ForgejoUser {
  id: number;
  login: string;
}

export interface ForgejoRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  default_branch: string;
  html_url: string;
}

export interface ForgejoHook {
  id: number;
  type: string;
  config: { url: string; content_type: string };
  events: string[];
  active: boolean;
}

export class ForgejoApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public responseBody: string
  ) {
    super(message);
    this.name = 'ForgejoApiError';
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ForgejoClient {
  private baseUrl: string;
  private token: string;
  private labelCache = new Map<string, Map<string, number>>();

  constructor(baseUrl: string, token: string) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  // ---- Internal fetch helper ----

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const headers: Record<string, string> = {
      Authorization: `token ${this.token}`,
      'Content-Type': 'application/json',
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const responseBody = await response.text();
      throw new ForgejoApiError(
        `Forgejo API ${method} ${path} failed with ${response.status}`,
        response.status,
        responseBody
      );
    }

    // 204 No Content
    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private repoPath(repo: Repo): string {
    return `/repos/${repo.owner}/${repo.name}`;
  }

  // ---- Users ----

  async getCurrentUser(): Promise<ForgejoUser> {
    return this.request<ForgejoUser>('GET', '/user');
  }

  // ---- Repositories ----

  async listUserRepos(limit = 50): Promise<ForgejoRepo[]> {
    return this.request<ForgejoRepo[]>(
      'GET',
      `/user/repos?limit=${limit}`
    );
  }

  // ---- Issues ----

  async listIssues(
    repo: Repo,
    params?: { state?: 'open' | 'closed'; labels?: string }
  ): Promise<ForgejoIssue[]> {
    const qs = new URLSearchParams({ type: 'issues' });
    if (params?.state) qs.set('state', params.state);
    if (params?.labels) qs.set('labels', params.labels);
    return this.request<ForgejoIssue[]>(
      'GET',
      `${this.repoPath(repo)}/issues?${qs.toString()}`
    );
  }

  async getIssue(repo: Repo, issueNumber: number): Promise<ForgejoIssue> {
    return this.request<ForgejoIssue>(
      'GET',
      `${this.repoPath(repo)}/issues/${issueNumber}`
    );
  }

  async createIssue(
    repo: Repo,
    data: { title: string; body: string; labels?: number[] }
  ): Promise<ForgejoIssue> {
    return this.request<ForgejoIssue>(
      'POST',
      `${this.repoPath(repo)}/issues`,
      data
    );
  }

  async commentOnIssue(
    repo: Repo,
    issueNumber: number,
    body: string
  ): Promise<void> {
    await this.request(
      'POST',
      `${this.repoPath(repo)}/issues/${issueNumber}/comments`,
      { body }
    );
  }

  async closeIssue(repo: Repo, issueNumber: number): Promise<void> {
    await this.request(
      'PATCH',
      `${this.repoPath(repo)}/issues/${issueNumber}`,
      { state: 'closed' }
    );
  }

  // ---- Labels ----

  async getLabels(repo: Repo): Promise<ForgejoLabel[]> {
    return this.request<ForgejoLabel[]>(
      'GET',
      `${this.repoPath(repo)}/labels`
    );
  }

  async createLabel(
    repo: Repo,
    data: { name: string; color: string; exclusive?: boolean }
  ): Promise<ForgejoLabel> {
    return this.request<ForgejoLabel>(
      'POST',
      `${this.repoPath(repo)}/labels`,
      data
    );
  }

  async replaceLabel(
    repo: Repo,
    issueNumber: number,
    labelIds: number[]
  ): Promise<void> {
    await this.request(
      'PUT',
      `${this.repoPath(repo)}/issues/${issueNumber}/labels`,
      { labels: labelIds }
    );
  }

  async removeLabels(repo: Repo, issueNumber: number): Promise<void> {
    await this.request(
      'DELETE',
      `${this.repoPath(repo)}/issues/${issueNumber}/labels`
    );
  }

  /**
   * Replace labels on an issue using label names instead of IDs.
   * Resolves names to IDs via the repo's label list, creating missing labels as needed.
   * Uses a per-repo cache to avoid repeated API calls.
   */
  async replaceLabelByNames(
    repo: Repo,
    issueNumber: number,
    labelNames: string[]
  ): Promise<void> {
    const cacheKey = `${repo.owner}/${repo.name}`;
    if (!this.labelCache.has(cacheKey)) {
      const labels = await this.getLabels(repo);
      const map = new Map<string, number>();
      for (const label of labels) {
        map.set(label.name, label.id);
      }
      this.labelCache.set(cacheKey, map);
    }

    const cache = this.labelCache.get(cacheKey)!;
    const ids: number[] = [];

    for (const name of labelNames) {
      let id = cache.get(name);
      if (id === undefined) {
        // Label doesn't exist — create it
        const isExclusive = name.includes('/');
        const label = await this.createLabel(repo, {
          name,
          color: '#0075ca',
          exclusive: isExclusive,
        });
        cache.set(name, label.id);
        id = label.id;
      }
      ids.push(id);
    }

    await this.replaceLabel(repo, issueNumber, ids);
  }

  // ---- Branches ----

  async getBranch(repo: Repo, branchName: string): Promise<ForgejoBranch> {
    return this.request<ForgejoBranch>(
      'GET',
      `${this.repoPath(repo)}/branches/${encodeURIComponent(branchName)}`
    );
  }

  async listBranches(repo: Repo): Promise<ForgejoBranch[]> {
    return this.request<ForgejoBranch[]>(
      'GET',
      `${this.repoPath(repo)}/branches`
    );
  }

  async deleteBranch(repo: Repo, branchName: string): Promise<void> {
    await this.request(
      'DELETE',
      `${this.repoPath(repo)}/branches/${encodeURIComponent(branchName)}`
    );
  }

  // ---- Pull Requests ----

  async createPullRequest(
    repo: Repo,
    data: { title: string; body: string; head: string; base: string }
  ): Promise<ForgejoPullRequest> {
    return this.request<ForgejoPullRequest>(
      'POST',
      `${this.repoPath(repo)}/pulls`,
      data
    );
  }

  async getPullRequest(
    repo: Repo,
    prNumber: number
  ): Promise<ForgejoPullRequest> {
    return this.request<ForgejoPullRequest>(
      'GET',
      `${this.repoPath(repo)}/pulls/${prNumber}`
    );
  }

  async mergePullRequest(
    repo: Repo,
    prNumber: number,
    mergeType: 'merge' | 'squash' | 'rebase' = 'squash'
  ): Promise<void> {
    await this.request(
      'POST',
      `${this.repoPath(repo)}/pulls/${prNumber}/merge`,
      { Do: mergeType }
    );
  }

  async commentOnPr(
    repo: Repo,
    prNumber: number,
    body: string
  ): Promise<void> {
    // Forgejo uses the issues endpoint for PR comments
    await this.request(
      'POST',
      `${this.repoPath(repo)}/issues/${prNumber}/comments`,
      { body }
    );
  }

  async closePullRequest(repo: Repo, prNumber: number): Promise<void> {
    await this.request(
      'PATCH',
      `${this.repoPath(repo)}/pulls/${prNumber}`,
      { state: 'closed' }
    );
  }

  // ---- Webhooks ----

  async listHooks(repo: Repo): Promise<ForgejoHook[]> {
    return this.request<ForgejoHook[]>(
      'GET',
      `${this.repoPath(repo)}/hooks`
    );
  }

  async createHook(
    repo: Repo,
    data: {
      type: string;
      config: { url: string; content_type: string; secret: string };
      events: string[];
      active: boolean;
    }
  ): Promise<ForgejoHook> {
    return this.request<ForgejoHook>(
      'POST',
      `${this.repoPath(repo)}/hooks`,
      data
    );
  }

  async deleteHook(repo: Repo, hookId: number): Promise<void> {
    await this.request(
      'DELETE',
      `${this.repoPath(repo)}/hooks/${hookId}`
    );
  }
}
