import { describe, it, expect } from 'vitest';
import {
  toOpenAIMessages,
  toOpenAITools,
  openAIMessageToResponse,
  OpenRouterLlmClient,
  type LlmTurn,
  type WireTool,
} from '../../runner/llm.js';

/**
 * Unit tests for the OpenRouter (OpenAI-format) adapter — pure mapping only,
 * NO network. Proves the runner's LlmRequest <-> OpenAI wire translation is
 * correct so a live OpenRouter run drives the same tool-calling loop.
 */

describe('OpenRouter mapping — turns -> OpenAI messages', () => {
  it('maps system + user/assistant(tool_calls)/tool turns', () => {
    const turns: LlmTurn[] = [
      { role: 'user', text: 'create a customer' },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ id: 'call_1', name: 'createCustomer', input: { name: 'Ada' } }],
      },
      { role: 'tool', results: [{ toolUseId: 'call_1', content: '{"id":"cus_1"}' }] },
    ];
    const msgs = toOpenAIMessages('SYS', turns);
    expect(msgs[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(msgs[1]).toEqual({ role: 'user', content: 'create a customer' });
    expect(msgs[2].role).toBe('assistant');
    expect((msgs[2].tool_calls as any[])[0]).toEqual({
      id: 'call_1',
      type: 'function',
      function: { name: 'createCustomer', arguments: '{"name":"Ada"}' },
    });
    expect(msgs[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"id":"cus_1"}' });
  });
});

describe('OpenRouter mapping — wire tools -> OpenAI functions', () => {
  it('wraps each tool as type:function with its input_schema as parameters', () => {
    const tools: WireTool[] = [
      { name: 'createOrder', description: 'POST /orders', input_schema: { type: 'object', properties: {} } },
    ];
    expect(toOpenAITools(tools)).toEqual([
      {
        type: 'function',
        function: {
          name: 'createOrder',
          description: 'POST /orders',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]);
  });
});

describe('OpenRouter mapping — response parsing', () => {
  it('parses tool_calls into toolUses (stopReason tool_use)', () => {
    const r = openAIMessageToResponse({
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'getOrder', arguments: '{"orderId":"o1"}' } }],
    });
    expect(r.stopReason).toBe('tool_use');
    expect(r.toolUses).toEqual([{ id: 'c1', name: 'getOrder', input: { orderId: 'o1' } }]);
  });

  it('parses a plain text message as end_turn', () => {
    const r = openAIMessageToResponse({ content: 'done' });
    expect(r.stopReason).toBe('end_turn');
    expect(r.text).toBe('done');
    expect(r.toolUses).toEqual([]);
  });

  it('tolerates malformed tool-call arguments (-> empty input, no throw)', () => {
    const r = openAIMessageToResponse({
      tool_calls: [{ id: 'c2', function: { name: 'x', arguments: 'not json' } }],
    });
    expect(r.toolUses[0]).toEqual({ id: 'c2', name: 'x', input: {} });
  });
});

describe('OpenRouterLlmClient construction', () => {
  it('refuses without a key', () => {
    expect(() => new OpenRouterLlmClient({ model: 'anthropic/claude-sonnet-4.5', apiKey: '' })).toThrow(
      /OPENROUTER_API_KEY/,
    );
  });

  it('id encodes the pinned model', () => {
    const c = new OpenRouterLlmClient({ model: 'anthropic/claude-sonnet-4.5', apiKey: 'sk-test' });
    expect(c.id).toBe('openrouter:anthropic/claude-sonnet-4.5');
  });
});
