import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ModelResponse } from '../api.js';

// The Providers & Models tab reaches for its data in effects, which a static
// render never runs — so what is pinnable here is the chrome the operator
// sees before any fetch resolves, plus the sub-components that render
// straight from props.

vi.mock('../api.js', () => ({
  api: {
    getProviders: vi.fn().mockResolvedValue({ providers: [] }),
    getProviderKinds: vi.fn().mockResolvedValue({ kinds: [] }),
  },
}));

const { ProviderSettings, ContextWindowEditor } = await import(
  '../views/Settings/ProviderSettings.js'
);

function mkModel(overrides: Partial<ModelResponse> = {}): ModelResponse {
  return {
    id: 1,
    provider_id: 'ollama-local',
    model_id: 'qwen2.5-coder:14b',
    display_name: 'Qwen 2.5 Coder 14B',
    context_window: null,
    ...overrides,
  };
}

describe('ProviderSettings', () => {
  const html = renderToStaticMarkup(React.createElement(ProviderSettings));

  it('names the renamed self-hosted kind, not Ollama, in the tab copy', () => {
    expect(html).toContain('OpenAI-compatible');
    expect(html).not.toContain('Ollama');
  });

  it('renders the add-provider affordance', () => {
    expect(html).toContain('+ Add provider');
  });
});

describe('ContextWindowEditor', () => {
  function render(model: ModelResponse): string {
    return renderToStaticMarkup(
      React.createElement(ContextWindowEditor, {
        model,
        onSave: () => {},
        onCancel: () => {},
      })
    );
  }

  it('pre-fills the stored token count', () => {
    expect(render(mkModel({ context_window: 32768 }))).toContain(
      'value="32768"'
    );
  });

  it('renders an unset context window as a blank field, not a zero', () => {
    const html = render(mkModel({ context_window: null }));
    expect(html).toContain('value=""');
    expect(html).not.toContain('value="0"');
  });

  it('labels the input for screen readers', () => {
    expect(render(mkModel())).toContain('Context window in tokens');
  });
});
