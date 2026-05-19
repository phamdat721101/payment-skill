import { describe, expect, it } from 'vitest';
import {
  chatgptGptOpenApi,
  langchainJsSnippet,
  llamaindexJsSnippet,
  openaiTools,
} from '../src/exports.ts';
import { TOOL_NAMES } from '../src/tools.ts';

describe('exports', () => {
  it('openai export has 23 function-call entries', () => {
    const tools = openaiTools() as Array<{ type: string; function: { name: string } }>;
    expect(tools).toHaveLength(23);
    expect(tools.every((t) => t.type === 'function')).toBe(true);
  });

  it('chatgpt-gpt OpenAPI has /tools/<name> path for every tool', () => {
    const spec = chatgptGptOpenApi('https://example.com/mcp') as {
      paths: Record<string, unknown>;
      openapi: string;
    };
    expect(spec.openapi).toBe('3.0.3');
    for (const name of TOOL_NAMES) {
      expect(spec.paths[`/tools/${name}`]).toBeDefined();
    }
  });

  it('langchain snippet imports DynamicStructuredTool and references TOOLS', () => {
    const out = langchainJsSnippet();
    expect(out).toContain('DynamicStructuredTool');
    expect(out).toContain("from 'n-payment-skill/tools'");
  });

  it('llamaindex snippet imports tool() and runs the MCP stdio handshake', () => {
    const out = llamaindexJsSnippet();
    expect(out).toContain("from 'llamaindex'");
    expect(out).toContain('tools/call');
  });
});
