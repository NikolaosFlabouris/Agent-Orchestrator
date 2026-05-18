import { describe, it, expect } from 'vitest';
import { buildDevPrompt, buildReviewPrompt } from '../../scheduler.js';
import type { Task, Repo } from '@orchestrator/shared';

const mockTask: Task = {
  id: 1,
  issue_id: 42,
  issue_title: 'Add login validation',
  repo_id: 1,
  branch_name: 'agent/issue-42-add-login',
  pr_number: null,
  status: 'in-progress',
  queue_position: null,
  attempt: 1,
  max_attempts: 3,
  prep_failure_count: 0,
  agent_profile_id: null,
  container_id: null,
  started_at: null,
  completed_at: null,
  created_at: '2025-01-01T00:00:00Z',
};

const mockRepo: Repo = {
  id: 1,
  owner: 'org',
  name: 'frontend',
  base_branch: 'main',
  agent_profile_id: 'default-claude-sdk',
  install_steps: [],
  allow_script_steps: false,
  container_memory_mb: null,
  container_cpu_cores: null,
  merge_strategy: 'squash',
};

const mockIssue = {
  title: 'Add login validation',
  body: 'Implement email format validation on the login form.',
};

describe('buildDevPrompt', () => {
  it('includes issue body', () => {
    const prompt = buildDevPrompt(mockTask, mockRepo, mockIssue, null);
    expect(prompt).toContain('Implement email format validation');
  });

  it('includes repo context', () => {
    const prompt = buildDevPrompt(mockTask, mockRepo, mockIssue, null);
    expect(prompt).toContain('org/frontend');
    expect(prompt).toContain('agent/issue-42-add-login');
    expect(prompt).toContain('main');
  });

  it('includes git instructions', () => {
    const prompt = buildDevPrompt(mockTask, mockRepo, mockIssue, null);
    expect(prompt).toContain('git fetch origin main');
    expect(prompt).toContain('git rebase origin/main');
    expect(prompt).toContain('git push origin agent/issue-42-add-login');
  });

  it('excludes review feedback on first attempt', () => {
    const prompt = buildDevPrompt(mockTask, mockRepo, mockIssue, null);
    expect(prompt).not.toContain('Review Feedback');
  });

  it('includes review feedback on rework', () => {
    const reworkTask = { ...mockTask, attempt: 2 };
    const feedback = 'Missing null check on line 42';
    const prompt = buildDevPrompt(reworkTask, mockRepo, mockIssue, feedback);
    expect(prompt).toContain('Review Feedback');
    expect(prompt).toContain('Missing null check on line 42');
    expect(prompt).toContain('Attempt 2');
  });

  it('includes constraints section', () => {
    const prompt = buildDevPrompt(mockTask, mockRepo, mockIssue, null);
    expect(prompt).toContain('Follow the existing code style');
    expect(prompt).toContain('Do not modify files unrelated to the task');
  });

  it('includes a self-review step before commit/push (initial attempt)', () => {
    const prompt = buildDevPrompt(mockTask, mockRepo, mockIssue, null);
    expect(prompt).toContain('Self-review before committing');
    expect(prompt).toContain('Re-read the task requirements');
    expect(prompt).toContain(
      'Explicitly enumerate any unmet requirements, bugs, missing tests, or unrelated/incidental changes'
    );
    const selfReviewIdx = prompt.indexOf('Self-review before committing');
    const commitIdx = prompt.indexOf('Commit your changes and push');
    expect(selfReviewIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(-1);
    expect(selfReviewIdx).toBeLessThan(commitIdx);
  });

  it('omits the review-feedback self-review sub-point on the initial attempt', () => {
    const prompt = buildDevPrompt(mockTask, mockRepo, mockIssue, null);
    expect(prompt).not.toContain('"Review Feedback" section below');
  });

  it('self-review also checks the diff against review feedback on rework', () => {
    const reworkTask = { ...mockTask, attempt: 2 };
    const feedback = 'Missing null check on line 42';
    const prompt = buildDevPrompt(reworkTask, mockRepo, mockIssue, feedback);
    expect(prompt).toContain('Self-review before committing');
    expect(prompt).toContain('"Review Feedback" section below');
    const selfReviewIdx = prompt.indexOf('Self-review before committing');
    const commitIdx = prompt.indexOf('Commit your changes and push');
    expect(selfReviewIdx).toBeLessThan(commitIdx);
  });
});

describe('buildReviewPrompt', () => {
  it('includes original task description', () => {
    const prompt = buildReviewPrompt(mockTask, mockRepo, mockIssue);
    expect(prompt).toContain('Implement email format validation');
  });

  it('includes diff instructions', () => {
    const prompt = buildReviewPrompt(mockTask, mockRepo, mockIssue);
    expect(prompt).toContain('git diff origin/main...HEAD');
  });

  it('names and requires all five rubric dimensions', () => {
    const prompt = buildReviewPrompt(mockTask, mockRepo, mockIssue);
    expect(prompt).toContain('## Review Rubric');
    for (const dim of [
      'requirements',
      'correctness',
      'tests',
      'security',
      'quality',
    ]) {
      expect(prompt).toContain(dim);
    }
    // Reviewer must address every dimension explicitly, not skip any.
    expect(prompt).toMatch(/do not skip\s+any/i);
  });

  it('documents the exact review.json schema', () => {
    const prompt = buildReviewPrompt(mockTask, mockRepo, mockIssue);
    expect(prompt).toContain('/output/review.json');
    expect(prompt).toContain('"verdict"');
    expect(prompt).toContain('"approved"');
    expect(prompt).toContain('"changes_needed"');
    expect(prompt).toContain('"unclear"');
    expect(prompt).toContain('"summary"');
    expect(prompt).toContain('"rubric"');
    expect(prompt).toContain('"feedback"');
    expect(prompt).toContain('"category"');
    expect(prompt).toContain('"severity"');
    expect(prompt).toContain('"suggestion"');
    expect(prompt).toContain('"blocker"');
    expect(prompt).toContain('"major"');
    expect(prompt).toContain('"minor"');
    expect(prompt).toContain('"pass"');
    expect(prompt).toContain('"concern"');
    expect(prompt).toContain('"fail"');
  });

  it('documents the unclear verdict as a human-routing escape hatch', () => {
    const prompt = buildReviewPrompt(mockTask, mockRepo, mockIssue);
    expect(prompt).toMatch(/genuinely cannot determine/i);
  });

  it('requires a non-empty actionable suggestion for changes_needed', () => {
    const prompt = buildReviewPrompt(mockTask, mockRepo, mockIssue);
    expect(prompt).toMatch(/AT LEAST ONE/);
    expect(prompt).toMatch(/non-empty[\s\S]*?suggestion/i);
    expect(prompt).toMatch(/not a restatement of the problem/i);
  });

  it('references the base branch', () => {
    const prompt = buildReviewPrompt(mockTask, mockRepo, mockIssue);
    expect(prompt).toContain('main');
  });
});

describe('buildDevPrompt is unchanged by the review rubric work', () => {
  it('does not leak review rubric or review.json schema into the dev prompt', () => {
    const prompt = buildDevPrompt(mockTask, mockRepo, mockIssue, null);
    expect(prompt).not.toContain('Review Rubric');
    expect(prompt).not.toContain('review.json');
    expect(prompt).not.toContain('rubric');
  });

  it('keeps the original dev prompt structure', () => {
    const prompt = buildDevPrompt(mockTask, mockRepo, mockIssue, null);
    expect(prompt).toContain('## Task');
    expect(prompt).toContain('## Context');
    expect(prompt).toContain('## Instructions');
    expect(prompt).toContain('## Constraints');
  });
});
