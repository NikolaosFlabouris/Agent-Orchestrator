import { describe, it, expect, beforeEach } from 'vitest';
import type { Task, Repo } from '@orchestrator/shared';
import {
  initDatabase,
  getDb,
  resolveStageProfileId,
  deleteAgentProfileIfUnreferenced,
  countReposUsingProfile,
  countTasksUsingProfile,
  insertTask,
  updateSetting,
  getActivePerProviderCounts,
} from '../../db.js';

// Fresh in-memory DB per test. The first-run bootstrap seeds:
//   - settings.default_agent_profile_id = 'default-claude-sdk'
//   - profiles 'default-claude-sdk' (provider anthropic) and
//     'default-claude-code-subscription' (provider claude-subscription)
const SDK_PROFILE = 'default-claude-sdk';
const SUB_PROFILE = 'default-claude-code-subscription';

beforeEach(() => {
  initDatabase(':memory:');
});

function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    issue_id: 10,
    issue_title: 'Test issue',
    repo_id: 1,
    branch_name: null,
    pr_number: null,
    status: 'queued',
    queue_position: null,
    attempt: 1,
    max_attempts: 3,
    prep_failure_count: 0,
    prep_backoff_level: 0,
    prep_next_attempt_at: null,
    salvage_backoff_level: 0,
    salvage_next_attempt_at: null,
    agent_profile_id: null,
    review_agent_profile_id: null,
    container_id: null,
    started_at: null,
    completed_at: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function mkRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 1,
    owner: 'acme',
    name: 'web',
    base_branch: 'main',
    agent_profile_id: null,
    review_agent_profile_id: null,
    install_steps: [],
    allow_script_steps: false,
    container_memory_mb: null,
    container_cpu_cores: null,
    merge_strategy: 'squash',
    ...overrides,
  };
}

describe('resolveStageProfileId — develop chain', () => {
  it('task override wins over repo and global', () => {
    const ref = resolveStageProfileId(
      mkTask({ agent_profile_id: 'task-prof' }),
      mkRepo({ agent_profile_id: 'repo-prof' }),
      'develop'
    );
    expect(ref).toEqual({ id: 'task-prof', source: 'task 1' });
  });

  it('repo default wins when the task has no override', () => {
    const ref = resolveStageProfileId(
      mkTask(),
      mkRepo({ agent_profile_id: 'repo-prof' }),
      'develop'
    );
    expect(ref).toEqual({ id: 'repo-prof', source: 'repo acme/web' });
  });

  it('falls back to settings.default_agent_profile_id', () => {
    const ref = resolveStageProfileId(mkTask(), mkRepo(), 'develop');
    expect(ref).toEqual({
      id: SDK_PROFILE,
      source: 'settings.default_agent_profile_id',
    });
  });

  it('returns null when every tier is unset', () => {
    updateSetting('default_agent_profile_id', null);
    expect(resolveStageProfileId(mkTask(), mkRepo(), 'develop')).toBeNull();
  });

  it('skips the repo tier when no repo is supplied', () => {
    const ref = resolveStageProfileId(mkTask(), undefined, 'develop');
    expect(ref?.id).toBe(SDK_PROFILE);
  });
});

describe('resolveStageProfileId — review chain', () => {
  it('task review override wins', () => {
    const ref = resolveStageProfileId(
      mkTask({
        agent_profile_id: 'dev-prof',
        review_agent_profile_id: 'rev-prof',
      }),
      mkRepo({ review_agent_profile_id: 'repo-rev' }),
      'review'
    );
    expect(ref).toEqual({ id: 'rev-prof', source: 'task 1 (review override)' });
  });

  it('repo review default wins when the task has none', () => {
    const ref = resolveStageProfileId(
      mkTask({ agent_profile_id: 'dev-prof' }),
      mkRepo({ review_agent_profile_id: 'repo-rev' }),
      'review'
    );
    expect(ref).toEqual({
      id: 'repo-rev',
      source: 'repo acme/web (review default)',
    });
  });

  it('global review default beats a task-level implementation override (stage-independent chains)', () => {
    // The decision case: task pins implementation = Gemma-style local
    // profile, but the operator set a global review default. The review
    // chain is walked fully before falling back to the implementation
    // chain, so the global review default wins.
    updateSetting('default_review_agent_profile_id', SUB_PROFILE);
    const ref = resolveStageProfileId(
      mkTask({ agent_profile_id: 'dev-prof' }),
      mkRepo(),
      'review'
    );
    expect(ref).toEqual({
      id: SUB_PROFILE,
      source: 'settings.default_review_agent_profile_id',
    });
  });

  it('falls back to the develop chain when no review tier is set', () => {
    const ref = resolveStageProfileId(
      mkTask({ agent_profile_id: 'dev-prof' }),
      mkRepo(),
      'review'
    );
    expect(ref).toEqual({ id: 'dev-prof', source: 'task 1' });
  });

  it('falls all the way back to the global implementation default', () => {
    const ref = resolveStageProfileId(mkTask(), mkRepo(), 'review');
    expect(ref).toEqual({
      id: SDK_PROFILE,
      source: 'settings.default_agent_profile_id',
    });
  });

  it('returns null when both chains are fully unset', () => {
    updateSetting('default_agent_profile_id', null);
    expect(resolveStageProfileId(mkTask(), mkRepo(), 'review')).toBeNull();
  });
});

describe('profile deletion guard — review references', () => {
  it('refuses to delete a profile referenced as a repo review default', () => {
    getDb()
      .prepare(
        `INSERT INTO repos (id, owner, name, review_agent_profile_id) VALUES (1, 'o', 'r', ?)`
      )
      .run(SUB_PROFILE);
    const reason = deleteAgentProfileIfUnreferenced(SUB_PROFILE);
    expect(reason).toMatch(/referenced by 1 repo/);
  });

  it('refuses to delete a profile referenced as a task review override', () => {
    getDb()
      .prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r')`)
      .run();
    insertTask({
      issue_id: 10,
      repo_id: 1,
      status: 'queued',
      review_agent_profile_id: SUB_PROFILE,
    });
    const reason = deleteAgentProfileIfUnreferenced(SUB_PROFILE);
    expect(reason).toMatch(/1 task/);
  });

  it('refuses to delete the global default review profile', () => {
    updateSetting('default_review_agent_profile_id', SUB_PROFILE);
    const reason = deleteAgentProfileIfUnreferenced(SUB_PROFILE);
    expect(reason).toMatch(/global default review profile/);
  });

  it('deletes cleanly when only unrelated references exist', () => {
    const reason = deleteAgentProfileIfUnreferenced(SUB_PROFILE);
    expect(reason).toBeNull();
  });
});

describe('usage counts — review references', () => {
  it('counts repos referencing the profile in either column, once per repo', () => {
    getDb()
      .prepare(
        `INSERT INTO repos (id, owner, name, agent_profile_id, review_agent_profile_id)
         VALUES (1, 'o', 'both', ?, ?), (2, 'o', 'rev-only', NULL, ?)`
      )
      .run(SUB_PROFILE, SUB_PROFILE, SUB_PROFILE);
    expect(countReposUsingProfile(SUB_PROFILE)).toBe(2);
  });

  it('counts tasks referencing the profile via the review column', () => {
    getDb()
      .prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r')`)
      .run();
    insertTask({
      issue_id: 10,
      repo_id: 1,
      status: 'queued',
      review_agent_profile_id: SUB_PROFILE,
    });
    insertTask({
      issue_id: 11,
      repo_id: 1,
      status: 'queued',
      agent_profile_id: SUB_PROFILE,
      review_agent_profile_id: SUB_PROFILE,
    });
    expect(countTasksUsingProfile(SUB_PROFILE)).toBe(2);
  });
});

describe('getActivePerProviderCounts — stage-aware', () => {
  beforeEach(() => {
    getDb()
      .prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r')`)
      .run();
  });

  it('counts an in-review task against its review profile provider', () => {
    // Review profile points at the claude-subscription provider; the
    // (inherited) dev profile points at anthropic. In review, the task
    // must count against claude-subscription.
    getDb()
      .prepare(
        `INSERT INTO tasks (id, issue_id, repo_id, status, container_id, review_agent_profile_id)
         VALUES (1, 10, 1, 'in-review', 'c1', ?)`
      )
      .run(SUB_PROFILE);
    const counts = getActivePerProviderCounts();
    expect(counts.get('claude-subscription')).toBe(1);
    expect(counts.get('anthropic')).toBeUndefined();
  });

  it('counts an in-progress task against its dev profile provider even with a review override set', () => {
    getDb()
      .prepare(
        `INSERT INTO tasks (id, issue_id, repo_id, status, container_id, review_agent_profile_id)
         VALUES (1, 10, 1, 'in-progress', 'c1', ?)`
      )
      .run(SUB_PROFILE);
    const counts = getActivePerProviderCounts();
    expect(counts.get('anthropic')).toBe(1);
    expect(counts.get('claude-subscription')).toBeUndefined();
  });

  it('in-review with no review tier set falls back to the dev provider', () => {
    getDb()
      .prepare(
        `INSERT INTO tasks (id, issue_id, repo_id, status, container_id)
         VALUES (1, 10, 1, 'in-review', 'c1')`
      )
      .run();
    const counts = getActivePerProviderCounts();
    expect(counts.get('anthropic')).toBe(1);
  });
});
