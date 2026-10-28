/**
 * Agent OTel span-attribute tests.
 *
 * The execute_tool span follows the OTel GenAI convention so any
 * convention-aware collector reads the tool, its arguments, its result, and
 * its error without a T3MP3ST-specific parser:
 *   - gen_ai.operation.name = execute_tool
 *   - gen_ai.tool.name       = <tool>
 *   - gen_ai.tool.call.arguments / .result  (content capture on)
 *   - error.type + Error status on failure, and no result then
 *
 * The provider is registered at module scope, before the agent is imported:
 * the agent grabs its tracer once at import, and a ProxyTracer binds to
 * whatever provider is global at its first span — so a per-test provider
 * would never capture anything.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import type { LLMBackbone } from '../llm/index.js';
import type { LLMResponse, LLMToolCall, Task } from '../types/index.js';
import { Arsenal } from '../arsenal/index.js';

const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(
  new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] })
);

let createAgentLoop: typeof import('../agent/index.js').createAgentLoop;

function makeTask(): Task {
  return {
    id: 'task-1',
    missionId: 'mission-1',
    name: 'Test Task',
    description: 'A test task',
    phase: 'reconnaissance' as any,
    operatorType: 'recon',
    status: 'in_progress',
    priority: 5,
    dependencies: [],
    createdAt: Date.now(),
  };
}

function makeLLMResponse(toolCalls: LLMToolCall[], content?: string): LLMResponse {
  return {
    content: content || '',
    model: 'test-model',
    toolCalls,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

function createMockLLM(responses: LLMResponse[]): LLMBackbone {
  let i = 0;
  const next = async () => responses[i++] ?? responses[responses.length - 1];
  return {
    getProvider: vi.fn().mockReturnValue('mock'),
    chat: vi.fn().mockImplementation(next),
    chatWithTools: vi.fn().mockImplementation(next),
  } as unknown as LLMBackbone;
}

describe('execute_tool span follows the GenAI convention', () => {
  let arsenal: Arsenal;

  beforeAll(async () => {
    ({ createAgentLoop } = await import('../agent/index.js'));
  });

  beforeEach(() => {
    exporter.reset();
    arsenal = new Arsenal();
  });

  const toolSpans = () =>
    exporter
      .getFinishedSpans()
      .filter((s) => s.attributes['gen_ai.operation.name'] === 'execute_tool');

  it('stamps operation, tool, arguments and result on a successful call', async () => {
    arsenal.register({
      name: 'dns_lookup',
      description: 'DNS lookup',
      category: 'recon',
      parameters: [{ name: 'domain', type: 'string', description: 'Domain', required: true }],
      handler: async (ctx) => ({ success: true, output: `Resolved ${ctx.parameters.domain}` }),
    });
    const llm = createMockLLM([
      makeLLMResponse([{ id: 'c1', name: 'dns_lookup', arguments: { domain: 'example.com' } }]),
      makeLLMResponse([], 'Done.'),
    ]);

    await createAgentLoop(llm, arsenal, { maxIterations: 5 }).run(makeTask(), 'scanner');

    const spans = toolSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe('execute_tool dns_lookup');
    expect(span.attributes['gen_ai.tool.name']).toBe('dns_lookup');
    expect(JSON.parse(String(span.attributes['gen_ai.tool.call.arguments']))).toEqual({
      domain: 'example.com',
    });
    expect(String(span.attributes['gen_ai.tool.call.result'])).toContain('Resolved example.com');
    expect(span.attributes['error.type']).toBeUndefined();
  });

  it('marks a failed call with error.type and an Error status, and no result', async () => {
    arsenal.register({
      name: 'sql_query',
      description: 'SQL query',
      category: 'recon',
      parameters: [{ name: 'q', type: 'string', description: 'Query', required: true }],
      handler: async () => ({
        success: false,
        error: JSON.stringify({ error: true, category: 'permission_denied' }),
      }),
    });
    const llm = createMockLLM([
      makeLLMResponse([{ id: 'c1', name: 'sql_query', arguments: { q: 'SELECT 1' } }]),
      makeLLMResponse([], 'Done.'),
    ]);

    await createAgentLoop(llm, arsenal, { maxIterations: 5 }).run(makeTask(), 'scanner');

    const spans = toolSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe('execute_tool sql_query');
    expect(span.attributes['gen_ai.tool.name']).toBe('sql_query');
    expect(span.attributes['error.type']).toBe('permission_denied');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['gen_ai.tool.call.result']).toBeUndefined();
  });
});
