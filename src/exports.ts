// Paste-ready export generators for hosts that don't auto-install via the
// dispatcher: ChatGPT custom GPT (OpenAPI), OpenAI Assistants tools.json,
// LangChain JS, LlamaIndex JS. Each function is a pure transform of the
// tool registry so the README and Python adapters can re-use them.

import { TOOLS } from './tools.js';
import { exportOpenAITools, toJsonSchema } from './schema.js';

/** OpenAI / Anthropic function-calling tools.json. */
export const openaiTools = (): unknown[] => exportOpenAITools();

/**
 * OpenAPI 3.0 spec for the MCP HTTP server. Upload as a ChatGPT Action.
 * Endpoint: POST /mcp on a publicly reachable host running
 * `n-payment-skill mcp --http --port 8081`.
 */
export function chatgptGptOpenApi(serverUrl = 'https://YOUR_HOST/mcp'): Record<string, unknown> {
  const operations: Record<string, unknown> = {};
  for (const t of TOOLS) {
    operations[`call_${t.name}`] = {
      operationId: `call_${t.name}`,
      summary: t.description,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: toJsonSchema(t),
          },
        },
      },
      responses: {
        '200': { description: 'Tool result', content: { 'application/json': {} } },
      },
    };
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'n-payment-skill (MCP HTTP)',
      version: '1.0.0',
      description: 'Expose every n-payment tool as an HTTP POST endpoint.',
    },
    servers: [{ url: serverUrl }],
    paths: Object.fromEntries(
      TOOLS.map((t) => [
        `/tools/${t.name}`,
        { post: (operations as Record<string, unknown>)[`call_${t.name}`] },
      ]),
    ),
  };
}

/** A TypeScript file the user can paste into a LangChain.js project. */
export function langchainJsSnippet(): string {
  return `// Paste into your LangChain.js project. Requires:
//   npm i @langchain/core n-payment-skill n-payment
//
// Each tool is a DynamicStructuredTool wired to call the n-payment-skill
// MCP server over stdio (same binary the Claude / Cursor / Gemini hosts use).
import { DynamicStructuredTool } from '@langchain/core/tools';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { TOOLS, TOOL_NAMES } from 'n-payment-skill/tools';

const proc = spawn('n-payment-skill', ['mcp', '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
let nextId = 0;
const pending = new Map<number, (r: any) => void>();
let buf = '';
proc.stdout.on('data', (d) => {
  buf += d.toString();
  for (let i; (i = buf.indexOf('\\n')) !== -1; ) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg); pending.delete(msg.id);
  }
});
const rpc = (method: string, params: any) =>
  new Promise<any>((resolve) => {
    const id = ++nextId; pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');
  });
await rpc('initialize', {});

export const nPaymentTools = TOOLS.map((t) => new DynamicStructuredTool({
  name: t.name,
  description: t.description,
  schema: t.schema as z.ZodTypeAny,
  func: async (args) => {
    const res = await rpc('tools/call', { name: t.name, arguments: args });
    return JSON.stringify(res.result?.content?.[0]?.text ?? res);
  },
}));

console.log('Exposed', TOOL_NAMES.length, 'tools to LangChain.');
`;
}

/** A TypeScript file the user can paste into a LlamaIndex.TS project. */
export function llamaindexJsSnippet(): string {
  return `// Paste into your LlamaIndex.TS project. Requires:
//   npm i llamaindex n-payment-skill n-payment
//
// Wraps the n-payment-skill MCP server as LlamaIndex tools.
import { tool } from 'llamaindex';
import { spawn } from 'node:child_process';
import { TOOLS } from 'n-payment-skill/tools';

const proc = spawn('n-payment-skill', ['mcp', '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
let nextId = 0;
const pending = new Map<number, (r: any) => void>();
let buf = '';
proc.stdout.on('data', (d) => {
  buf += d.toString();
  for (let i; (i = buf.indexOf('\\n')) !== -1; ) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg); pending.delete(msg.id);
  }
});
const rpc = (method: string, params: any) =>
  new Promise<any>((resolve) => {
    const id = ++nextId; pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');
  });
await rpc('initialize', {});

export const nPaymentTools = TOOLS.map((t) =>
  tool({
    name: t.name,
    description: t.description,
    parameters: t.schema as any,
    execute: async (args: any) => {
      const res = await rpc('tools/call', { name: t.name, arguments: args });
      return res.result?.content?.[0]?.text ?? JSON.stringify(res);
    },
  }),
);
`;
}
