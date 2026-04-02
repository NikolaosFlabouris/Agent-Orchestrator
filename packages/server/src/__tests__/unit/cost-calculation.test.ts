import { describe, it, expect } from 'vitest';
import { normalizeModelName } from '../../scheduler.js';

describe('normalizeModelName', () => {
  it('strips date suffix from model name', () => {
    expect(normalizeModelName('claude-sonnet-4-20250514')).toBe(
      'claude-sonnet-4'
    );
  });

  it('strips date suffix from opus model', () => {
    expect(normalizeModelName('claude-opus-4-20250514')).toBe(
      'claude-opus-4'
    );
  });

  it('strips date suffix from haiku model', () => {
    expect(normalizeModelName('claude-haiku-4-20251001')).toBe(
      'claude-haiku-4'
    );
  });

  it('leaves model name without date suffix unchanged', () => {
    expect(normalizeModelName('claude-sonnet-4')).toBe('claude-sonnet-4');
  });

  it('leaves short model names unchanged', () => {
    expect(normalizeModelName('sonnet')).toBe('sonnet');
  });

  it('handles mock model name', () => {
    expect(normalizeModelName('mock-model')).toBe('mock-model');
  });

  it('only strips 8-digit date suffix', () => {
    // Should not strip shorter numeric suffixes
    expect(normalizeModelName('model-123')).toBe('model-123');
    // Should not strip longer numeric suffixes
    expect(normalizeModelName('model-123456789')).toBe('model-123456789');
  });
});

describe('cost calculation math', () => {
  it('computes cost from tokens and pricing', () => {
    const pricing = {
      input_per_mtok: 3,
      output_per_mtok: 15,
    };
    const inputTokens = 125000;
    const outputTokens = 8500;

    const cost =
      (inputTokens * pricing.input_per_mtok) / 1_000_000 +
      (outputTokens * pricing.output_per_mtok) / 1_000_000;

    expect(cost).toBeCloseTo(0.5025, 4);
  });

  it('handles zero tokens', () => {
    const pricing = { input_per_mtok: 3, output_per_mtok: 15 };
    const cost =
      (0 * pricing.input_per_mtok) / 1_000_000 +
      (0 * pricing.output_per_mtok) / 1_000_000;

    expect(cost).toBe(0);
  });

  it('handles high token counts', () => {
    const pricing = { input_per_mtok: 5, output_per_mtok: 25 };
    const inputTokens = 1_000_000;
    const outputTokens = 50_000;

    const cost =
      (inputTokens * pricing.input_per_mtok) / 1_000_000 +
      (outputTokens * pricing.output_per_mtok) / 1_000_000;

    expect(cost).toBeCloseTo(6.25, 2);
  });
});
