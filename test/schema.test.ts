import { describe, expect, it } from 'vitest';
import {
  exportOpenAITools,
  exportMcpTools,
  toJsonSchema,
  toOpenAIFunction,
} from '../src/schema.js';
import { TOOLS, TOOL_BY_NAME } from '../src/tools.js';

describe('schema generator', () => {
  it('exports all 20 tools in OpenAI function-call shape', () => {
    const out = exportOpenAITools();
    expect(out).toHaveLength(20);
    for (const fn of out) {
      expect(fn.type).toBe('function');
      expect(typeof fn.function.name).toBe('string');
      expect(typeof fn.function.description).toBe('string');
      expect(typeof fn.function.parameters).toBe('object');
    }
  });

  it('exports MCP tools/list shape with inputSchema', () => {
    const mcp = exportMcpTools();
    expect(mcp).toHaveLength(20);
    for (const m of mcp) {
      expect(m.name).toBeTruthy();
      expect(typeof m.inputSchema).toBe('object');
      // Object schemas should declare type=object somewhere.
      expect(JSON.stringify(m.inputSchema)).toContain('object');
    }
  });

  it('preserves tool name + description from registry', () => {
    for (const t of TOOLS) {
      const fn = toOpenAIFunction(t);
      expect(fn.function.name).toBe(t.name);
      expect(fn.function.description).toBe(t.description);
    }
  });

  it('produces a JSON Schema with property names matching the zod schema', () => {
    const schema = toJsonSchema(TOOL_BY_NAME.pay!);
    expect(schema.type).toBe('object');
    const properties = schema.properties as Record<string, unknown>;
    expect(properties.url).toBeDefined();
    expect(properties.method).toBeDefined();
  });

  it('JSON Schema is JSON-serializable (no functions, no undefineds)', () => {
    const json = JSON.stringify(exportOpenAITools());
    expect(json).toBeTruthy();
    const round = JSON.parse(json);
    expect(round).toHaveLength(20);
  });
});
