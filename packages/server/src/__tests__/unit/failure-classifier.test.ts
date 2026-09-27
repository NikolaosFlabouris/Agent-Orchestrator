import { describe, it, expect } from 'vitest';
import { classifyFailure, permanentFailureHint } from '../../failure-classifier.js';

/** Unit tests for the agent-attempt failure classifier (#208). Messages are
 *  in the shape harness-cli.sh records in result.json's error_message:
 *  `[API <status>] <Claude Code result text>` for structured result events,
 *  or the agent's raw text otherwise. */

function category(msg: string, exitCode: number | null = 1) {
  const c = classifyFailure(msg, exitCode);
  return c.kind === 'permanent' ? c.category : c.kind;
}

describe('classifyFailure — permanent patterns', () => {
  describe('cli_outdated', () => {
    it('matches the exact 2026-09-26 message', () => {
      const msg =
        "[API 400] API Error: 400 Claude Code 2.1.232 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.";
      const c = classifyFailure(msg, 1);
      expect(c).toEqual({
        kind: 'permanent',
        category: 'cli_outdated',
        reason: expect.any(String),
      });
    });

    it('matches "does not support this model" on its own', () => {
      expect(category('Error: this CLI does not support this model')).toBe('cli_outdated');
    });

    it('matches "version <x> or newer is required" on its own', () => {
      expect(category('version 3.4.0 or newer is required')).toBe('cli_outdated');
    });
  });

  describe('auth', () => {
    it('matches 401 authentication_error', () => {
      expect(
        category(
          '[API 401] API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'
        )
      ).toBe('auth');
    });

    it('matches 401 "API key is invalid"', () => {
      expect(category('HTTP 401: API key is invalid')).toBe('auth');
    });

    it('matches 401 "invalid x-api-key"', () => {
      expect(category('API Error: 401 invalid x-api-key')).toBe('auth');
    });

    it('matches 403 permission_error', () => {
      expect(
        category(
          '[API 403] {"type":"error","error":{"type":"permission_error","message":"Your API key does not have permission to use the specified resource."}}'
        )
      ).toBe('auth');
    });

    it('does not match auth markers without a 401/403 status', () => {
      expect(category('authentication_error while talking to provider')).toBe('retryable');
      expect(category('[API 500] permission_error')).toBe('retryable');
    });

    it('does not match a bare 401 without a known auth marker', () => {
      expect(category('[API 401] Unauthorized')).toBe('retryable');
    });
  });

  describe('unknown_model', () => {
    it('matches 404 not_found_error referencing a model', () => {
      expect(
        category(
          '[API 404] API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-nonexistent-9"}}'
        )
      ).toBe('unknown_model');
    });

    it('does not match 404 not_found_error without a model reference', () => {
      expect(
        category('[API 404] {"type":"error","error":{"type":"not_found_error","message":"File not found"}}')
      ).toBe('retryable');
    });

    it('matches "model not found"', () => {
      expect(category('Error: model not found: gpt-oss:999b')).toBe('unknown_model');
    });

    it('matches "no router for requested model"', () => {
      expect(category('400 no router for requested model qwen-9000')).toBe('unknown_model');
    });
  });

  it('classifies independently of the exit code (pi exits 0 on model errors)', () => {
    expect(category('Error: model not found: foo', 0)).toBe('unknown_model');
    expect(category('Error: model not found: foo', null)).toBe('unknown_model');
  });
});

describe('classifyFailure — retryable', () => {
  it.each([
    'Agent exited with failure status (exit code 1)',
    '[API 500] API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
    '[API 529] Overloaded',
    'npm ERR! code ELIFECYCLE',
    'fatal: unable to access https://git.example/: Could not resolve host',
    '[API 400] prompt is too long: 250000 tokens > 200000 maximum',
  ])('treats unrecognised errors as retryable: %s', (msg) => {
    expect(classifyFailure(msg, 1).kind).toBe('retryable');
  });

  it('treats an empty or missing message as retryable', () => {
    expect(classifyFailure('', 1).kind).toBe('retryable');
    expect(classifyFailure(null, 1).kind).toBe('retryable');
    expect(classifyFailure(undefined).kind).toBe('retryable');
  });

  it('treats a timeout exit code as retryable', () => {
    expect(classifyFailure('model not found', 124).kind).toBe('retryable');
  });
});

describe('classifyFailure — usage and rate limits are never permanent', () => {
  it.each([
    '[API 429] API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}}',
    "Claude AI usage limit reached|1790000000",
    "You've hit your session limit · resets 3pm",
    'Too Many Requests',
    // A limit message that also happens to carry a permanent-looking marker
    // must still be retryable.
    '[API 429] usage limit reached for this model; model not found in fallback pool',
    'API Error: 401 authentication_error — rate limit exceeded',
    'session limit: this CLI does not support this model',
  ])('%s', (msg) => {
    expect(classifyFailure(msg, 1).kind).toBe('retryable');
  });
});

describe('permanentFailureHint', () => {
  it('gives a category-specific remediation hint', () => {
    expect(permanentFailureHint('cli_outdated')).toMatch(/rebuild the agent image/);
    expect(permanentFailureHint('auth')).toMatch(/provider credentials/);
    expect(permanentFailureHint('unknown_model')).toMatch(/model id/);
  });
});
