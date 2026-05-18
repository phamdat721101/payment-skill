// MCP server — one shared dispatcher, two transports (stdio + HTTP).
//
// SOLID: dispatch logic in `handleMessage()` is transport-agnostic. The
// stdio runner reads line-delimited JSON-RPC; the HTTP server posts to
// /mcp. Both call the same handler so behaviour stays in lock-step.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';
import { exportMcpTools } from './schema.js';
import { TOOL_BY_NAME, type ToolContext } from './tools.js';
import { loadConfig } from './config.js';

export const MCP_VERSION = '1.0.0';
export const MCP_PROTOCOL = '2024-11-05';

// ─── JSON-RPC types (subset) ─────────────────────────────────────────────────
export interface McpRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}
export interface McpResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const rpcError = (
  id: McpRequest['id'],
  code: number,
  message: string,
): McpResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

// ─── Context builder ─────────────────────────────────────────────────────────
export async function buildContext(): Promise<ToolContext> {
  const cfg = await loadConfig();
  return {
    walletName: cfg.defaultWallet,
    defaultChain: cfg.defaultChain,
    testnetMode: cfg.testnetMode,
    env: process.env,
  };
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────
export async function handleMessage(
  req: McpRequest,
  ctx: ToolContext,
): Promise<McpResponse> {
  const { id, method, params } = req;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: MCP_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'n-payment-skill', version: MCP_VERSION },
      },
    };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: exportMcpTools() } };
  }
  if (method === 'tools/call') {
    const p = (params ?? {}) as { name?: string; arguments?: unknown };
    if (!p.name) return rpcError(id, -32602, 'Missing tool name');
    const tool = TOOL_BY_NAME[p.name];
    if (!tool) return rpcError(id, -32601, `Unknown tool: ${p.name}`);
    const parsed = tool.schema.safeParse(p.arguments ?? {});
    if (!parsed.success) {
      return rpcError(id, -32602, `Invalid args: ${parsed.error.issues.map(i => i.message).join('; ')}`);
    }
    const result = await tool.handler(parsed.data, ctx);
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError: !result.ok,
      },
    };
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

// ─── stdio transport ─────────────────────────────────────────────────────────
export async function runStdio(ctxFactory: () => Promise<ToolContext> = buildContext): Promise<void> {
  const ctx = await ctxFactory();
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let req: McpRequest;
    try {
      req = JSON.parse(line) as McpRequest;
    } catch {
      process.stdout.write(
        JSON.stringify(rpcError(null, -32700, 'Parse error')) + '\n',
      );
      return;
    }
    const res = await handleMessage(req, ctx);
    process.stdout.write(JSON.stringify(res) + '\n');
  });
  return new Promise((resolve) => rl.on('close', resolve));
}

// ─── HTTP transport ──────────────────────────────────────────────────────────
export interface HttpServerHandle {
  port: number;
  close(): Promise<void>;
}

export async function runHttp(
  port = 8081,
  ctxFactory: () => Promise<ToolContext> = buildContext,
): Promise<HttpServerHandle> {
  const ctx = await ctxFactory();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: MCP_VERSION }));
      return;
    }
    if (req.method === 'POST' && req.url === '/mcp') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed: McpRequest;
      try {
        parsed = JSON.parse(body) as McpRequest;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')));
        return;
      }
      const out = await handleMessage(parsed, ctx);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  const actualPort = (server.address() as { port: number }).port;
  return {
    port: actualPort,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
