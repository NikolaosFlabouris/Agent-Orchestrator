import { describe, it, expect } from 'vitest';
import { resolveEffectiveAgentTool } from '../../routes/tasks.js';

describe('resolveEffectiveAgentTool', () => {
  it('returns the task override when set', () => {
    const result = resolveEffectiveAgentTool('claude-code-opus', 'claude-code-sonnet');
    expect(result).toEqual({
      effective_agent_tool_id: 'claude-code-opus',
      agent_tool_source: 'task',
    });
  });

  it('falls back to the repo default when task override is null', () => {
    const result = resolveEffectiveAgentTool(null, 'claude-code-sonnet');
    expect(result).toEqual({
      effective_agent_tool_id: 'claude-code-sonnet',
      agent_tool_source: 'repo',
    });
  });

  it('uses repo default when task agent_tool is null (clearing override)', () => {
    const result = resolveEffectiveAgentTool(null, 'local-ollama');
    expect(result.effective_agent_tool_id).toBe('local-ollama');
    expect(result.agent_tool_source).toBe('repo');
  });

  it('accepts any non-null string as a valid task override', () => {
    const result = resolveEffectiveAgentTool('some-custom-tool', 'repo-default-tool');
    expect(result.effective_agent_tool_id).toBe('some-custom-tool');
    expect(result.agent_tool_source).toBe('task');
  });
});

// ---------------------------------------------------------------------------
// Validation logic — tests for accepting/rejecting/clearing agent_tool values
// ---------------------------------------------------------------------------

/** Mirrors the inline validation in the PATCH handler. */
function validateAgentToolId(
  toolId: string | null,
  getAgentTool: (id: string) => { id: string } | undefined
): { valid: true } | { valid: false; error: string } {
  if (toolId === null) return { valid: true }; // null always accepted (clear override)
  const tool = getAgentTool(toolId);
  if (!tool) return { valid: false, error: `Unknown agent_tool: ${toolId}` };
  return { valid: true };
}

describe('PATCH agent_tool validation', () => {
  const knownTools: Record<string, { id: string }> = {
    'claude-code': { id: 'claude-code' },
    'ollama-local': { id: 'ollama-local' },
  };

  const getAgentTool = (id: string) => knownTools[id];

  it('accepts a valid existing tool id', () => {
    expect(validateAgentToolId('claude-code', getAgentTool)).toEqual({ valid: true });
  });

  it('accepts another valid existing tool id', () => {
    expect(validateAgentToolId('ollama-local', getAgentTool)).toEqual({ valid: true });
  });

  it('rejects an unknown tool id with an error message', () => {
    const result = validateAgentToolId('nonexistent-tool', getAgentTool);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('nonexistent-tool');
    }
  });

  it('accepts null (clears the override)', () => {
    expect(validateAgentToolId(null, getAgentTool)).toEqual({ valid: true });
  });
});
