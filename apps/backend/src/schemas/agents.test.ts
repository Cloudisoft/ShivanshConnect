import { describe, expect, it } from 'vitest';
import {
  agentVersionConfigSchema,
  createAgentSchema,
  updateAgentVersionSchema,
} from './agents.js';

describe('createAgentSchema', () => {
  it('accepts a valid agent role', () => {
    const result = createAgentSchema.parse({ name: 'Sales Sam', role: 'sales_agent' });
    expect(result.role).toBe('sales_agent');
  });

  it('rejects an unknown role', () => {
    expect(() => createAgentSchema.parse({ name: 'Bad Agent', role: 'space_pirate' })).toThrow();
  });

  it('rejects an empty name', () => {
    expect(() => createAgentSchema.parse({ name: '', role: 'custom' })).toThrow();
  });
});

describe('agentVersionConfigSchema (personality / tone / behavior)', () => {
  it('accepts a full personality with tone, traits and behavior traits', () => {
    const result = agentVersionConfigSchema.parse({
      personality: {
        tone: 'Friendly',
        personality_traits: ['Patient', 'Persuasive'],
        behavior_traits: ['Asks clarifying questions', 'Confirms next steps'],
      },
    });
    expect(result.personality?.tone).toBe('Friendly');
    expect(result.personality?.personality_traits).toEqual(['Patient', 'Persuasive']);
  });

  it('defaults personality fields when omitted', () => {
    const result = agentVersionConfigSchema.parse({ personality: {} });
    expect(result.personality?.tone).toBeNull();
    expect(result.personality?.personality_traits).toEqual([]);
    expect(result.personality?.behavior_traits).toEqual([]);
  });

  it('rejects an out-of-range llm_temperature', () => {
    expect(() => agentVersionConfigSchema.parse({ llm_temperature: 5 })).toThrow();
  });

  it('rejects a negative llm_max_tokens', () => {
    expect(() => agentVersionConfigSchema.parse({ llm_max_tokens: -1 })).toThrow();
  });

  it('rejects an invalid transfer_rules.on_no_match value', () => {
    expect(() =>
      agentVersionConfigSchema.parse({ transfer_rules: { on_no_match: 'shout_into_the_void' } }),
    ).toThrow();
  });
});

describe('updateAgentVersionSchema', () => {
  it('requires at least one field', () => {
    expect(() => updateAgentVersionSchema.parse({})).toThrow();
  });

  it('accepts a partial update', () => {
    const result = updateAgentVersionSchema.parse({ system_prompt: 'New prompt' });
    expect(result.system_prompt).toBe('New prompt');
  });
});
