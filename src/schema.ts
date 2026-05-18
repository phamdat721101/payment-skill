// Pure schema converters. Used by MCP `tools/list` (JSON Schema), the
// `n-payment-skill export openai` artifact, and the LangChain / LlamaIndex
// adapters. No I/O, no global state — easy to unit-test.

import { zodToJsonSchema } from 'zod-to-json-schema';
import { TOOLS, type Tool } from './tools.js';

export type JSONSchema = Record<string, unknown>;

export interface OpenAIFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;
  };
}

/** JSON Schema for a single tool's input. Strips zod-only metadata. */
export function toJsonSchema(tool: Tool): JSONSchema {
  const raw = zodToJsonSchema(tool.schema, { target: 'jsonSchema7' }) as JSONSchema;
  // zod-to-json-schema wraps under $ref/definitions when it sees recursion;
  // for our flat tool inputs we always want the inline object schema.
  if (typeof raw.$ref === 'string' && raw.definitions) {
    const refKey = (raw.$ref as string).replace(/^#\/definitions\//, '');
    const inner = (raw.definitions as Record<string, JSONSchema>)[refKey];
    if (inner) return inner;
  }
  return raw;
}

/** OpenAI / Anthropic function-calling shape for a single tool. */
export function toOpenAIFunction(tool: Tool): OpenAIFunctionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: toJsonSchema(tool),
    },
  };
}

/** MCP `tools/list` shape: `{ name, description, inputSchema }`. */
export function toMcpTool(tool: Tool): {
  name: string;
  description: string;
  inputSchema: JSONSchema;
} {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: toJsonSchema(tool),
  };
}

export const exportOpenAITools = (): OpenAIFunctionTool[] =>
  TOOLS.map(toOpenAIFunction);

export const exportMcpTools = (): ReturnType<typeof toMcpTool>[] =>
  TOOLS.map(toMcpTool);
