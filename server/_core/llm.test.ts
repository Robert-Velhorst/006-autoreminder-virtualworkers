import { describe, expect, it } from 'vitest';
import {
  resolveMaxCompletionTokens,
  resolveOpenAIRequestTimeoutMs,
  selectPreferredOpenAIModel,
} from './llm';

describe('OpenAI model selection', () => {
  it('selects the highest-ranked compatible model available to the API key', () => {
    expect(selectPreferredOpenAIModel(['gpt-4o-mini', 'gpt-5-mini', 'gpt-5.2']))
      .toBe('gpt-5.2');
  });

  it('honors an explicit available model and rejects an unavailable one', () => {
    expect(selectPreferredOpenAIModel(['gpt-5-mini'], 'gpt-5-mini')).toBe('gpt-5-mini');
    expect(() => selectPreferredOpenAIModel(['gpt-5-mini'], 'gpt-5.2'))
      .toThrow("OPENAI_MODEL 'gpt-5.2' is not available");
  });

  it('does not select specialized non-chat models', () => {
    expect(selectPreferredOpenAIModel(['gpt-5-audio', 'gpt-5-realtime', 'gpt-5-codex', 'gpt-4.1-mini']))
      .toBe('gpt-4.1-mini');
  });
});

describe('OpenAI completion limits', () => {
  it('uses a bounded default while preserving an explicit feature budget', () => {
    expect(resolveMaxCompletionTokens()).toBe(4_096);
    expect(resolveMaxCompletionTokens(800)).toBe(800);
  });

  it('rejects invalid token budgets before sending an API request', () => {
    expect(() => resolveMaxCompletionTokens(0)).toThrow('maxTokens must be a positive integer');
    expect(() => resolveMaxCompletionTokens(1.5)).toThrow('maxTokens must be a positive integer');
  });
});

describe('OpenAI request deadline', () => {
  it('uses a controlled default and accepts a practical override', () => {
    expect(resolveOpenAIRequestTimeoutMs()).toBe(120_000);
    expect(resolveOpenAIRequestTimeoutMs('45000')).toBe(45_000);
  });

  it('rejects unsafe values by falling back and caps excessive values', () => {
    expect(resolveOpenAIRequestTimeoutMs('999')).toBe(120_000);
    expect(resolveOpenAIRequestTimeoutMs('not-a-number')).toBe(120_000);
    expect(resolveOpenAIRequestTimeoutMs('999999')).toBe(300_000);
  });
});
