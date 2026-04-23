import { describe, it, expect } from 'vitest';
import { buildDevPrompt, buildReviewPrompt } from '../../scheduler.js';
import type { Task, Repo } from '@orchestrator/shared';

const mockTask: Task = {
  id: 1,
  issue_id: 42,
  repo_id: 1,
  branch_name: 'agent/issue-42-add-login',
  pr_number: null,
  status: 'in-progress',
  queue_position: null,
  attempt: 1,
  max_attempts: 3,
  prep_failure_count: 0,
  agent_tool: null,
  model: null,
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
  image_type: 'node',
  agent_tool: 'claude-agent-sdk',
  pre_agent_script: null,
  model: null,
  max_turns: null,
  timeout_minutes: null,
  container_memory_mb: null,
  container_cpu_cores: null,
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

  it('includes review.json output format', () => {
    const prompt = buildReviewPrompt(mockTask, mockRepo, mockIssue);
    expect(prompt).toContain('/output/review.json');
    expect(prompt).toContain('"verdict"');
    expect(prompt).toContain('"approved"');
    expect(prompt).toContain('"changes_needed"');
  });

  it('includes approval criteria', () => {
    const prompt = buildReviewPrompt(mockTask, mockRepo, mockIssue);
    expect(prompt).toContain('All task requirements are met');
    expect(prompt).toContain('Tests pass');
    expect(prompt).toContain('No bugs or security issues');
  });

  it('references the base branch', () => {
    const prompt = buildReviewPrompt(mockTask, mockRepo, mockIssue);
    expect(prompt).toContain('main');
  });
});
