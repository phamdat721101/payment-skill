import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMessage, runHttp, type McpRequest } from '../src/mcp.ts';
import { ensureWallet, defaultHome } from '../src/wallet.ts';
import type { ToolContext } from '../src/tools.ts';

let HOME = '';
beforeEach(async () => {
  HOME = await mkdtemp(join(tmpdir(), 'n-payment-mcp-'));
});
afterEach(async () => {
  await rm(HOME, { recursive: true, force: true });
});

const ctx = (): ToolContext => ({
  walletName: 'default',
  defaultChain: 'goat-testnet',
  testnetMode: true,
  env: process.env,
});

const req = (id: number | string, method: string, params?: unknown): McpRequest => ({
  jsonrpc: '2.0',
  id,
  method,
  params: params as Record<string, unknown> | undefined,
});

describe('MCP dispatcher', () => {
  it('initialize returns server info + protocol version', async () => {
    const r = await handleMessage(req(1, 'initialize'), ctx());
    expect(r.id).toBe(1);
    expect((r.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
      'n-payment-skill',
    );
  });

  it('tools/list returns all 39 tools with inputSchema', async () => {
    const r = await handleMessage(req(2, 'tools/list'), ctx());
    const tools = (r.result as { tools: Array<{ name: string; inputSchema: unknown }> })
      .tools;
    expect(tools).toHaveLength(39);
    expect(tools.every((t) => typeof t.inputSchema === 'object')).toBe(true);
  });

  it('tools/call rejects unknown tool', async () => {
    const r = await handleMessage(req(3, 'tools/call', { name: 'nope' }), ctx());
    expect(r.error?.code).toBe(-32601);
  });

  it('tools/call validates args via zod', async () => {
    const r = await handleMessage(
      req(4, 'tools/call', { name: 'pay', arguments: { url: 'not-a-url' } }),
      ctx(),
    );
    expect(r.error?.code).toBe(-32602);
  });

  it('tools/call invokes negotiate (pure logic, no SDK)', async () => {
    const r = await handleMessage(
      req(5, 'tools/call', {
        name: 'negotiate',
        arguments: { price_micros: 10_000, caller_reputation: 90 },
      }),
      ctx(),
    );
    const result = r.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]!.text) as { ok: boolean; data: unknown };
    expect(payload.ok).toBe(true);
  });

  it('unknown method returns -32601', async () => {
    const r = await handleMessage(req(6, 'unknown.method'), ctx());
    expect(r.error?.code).toBe(-32601);
  });
});

describe('MCP HTTP transport', () => {
  it('serves /health and /mcp on a free port', async () => {
    const handle = await runHttp(0, async () => ctx());
    try {
      const health = await fetch(`http://127.0.0.1:${handle.port}/health`);
      const data = (await health.json()) as { status: string };
      expect(data.status).toBe('ok');

      const list = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      const body = (await list.json()) as {
        result: { tools: Array<unknown> };
      };
      expect(body.result.tools).toHaveLength(39);
    } finally {
      await handle.close();
    }
  });
});

// Unused import sanity: ensures wallet module compiles alongside mcp imports.
void ensureWallet;
void defaultHome;
