// MCP server — one shared dispatcher, two transports (stdio + HTTP).
//
// SOLID chokepoint: dispatch logic in `handleMessage()` is transport-agnostic.
// All signing-tool gating (unlock, policy, rate-limit, audit) lives here in
// `guardSigningCall` so handlers.ts stays untouched. Adding a new signing
// tool requires only registering its name in tools.ts SIGNING_TOOLS — every
// new tool is automatically protected.

import { appendFile, chmod, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { exportMcpTools } from './schema.js';
import {
  TOOL_BY_NAME,
  isSigningCall,
  type ChainKey,
  type ToolContext,
  type ToolResult,
} from './tools.js';
import {
  auditLogPath,
  loadConfig,
  loadPolicy,
  readMcpToken,
  type PolicyCaps,
  type PolicyConfig,
} from './config.js';
import { isUnlocked } from './wallet.js';

export const MCP_VERSION = '2.0.0';
export const MCP_PROTOCOL = '2024-11-05';
const AUDIT_ROTATE_BYTES = 5 * 1024 * 1024;
const RATE_BUCKET_SECONDS = 60;

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

const fail = (error: string, code: string, hint?: string): ToolResult => ({
  ok: false,
  error,
  code,
  hint,
});

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

// ─── Rate limiter (token bucket, in-memory) ──────────────────────────────────
const _rateWindow: number[] = [];
function rateLimitHit(limitPerMinute: number, now = Date.now()): boolean {
  const cutoff = now - RATE_BUCKET_SECONDS * 1000;
  while (_rateWindow.length > 0 && _rateWindow[0]! < cutoff) _rateWindow.shift();
  if (_rateWindow.length >= limitPerMinute) return true;
  _rateWindow.push(now);
  return false;
}

// ─── Argument shape inspector (heuristic, pure) ──────────────────────────────
/**
 * Pull the auditable triple `{ amountMicros, payTo, url }` out of arbitrary
 * tool args. We accept a few well-known field names (`max_price_micros`,
 * `amount_micros`, `budget_micros`, `pay_to`, `provider`, `to`, …) without
 * mandating each handler to standardize on one. Returns undefined fields
 * when a value can't be inferred — the dispatcher treats unknowns as "no
 * cap data, fall back to the safe global cap".
 */
export function inspectArgs(args: unknown): {
  amountMicros?: number;
  payTo?: string;
  url?: string;
  chain?: ChainKey;
} {
  const a = (args ?? {}) as Record<string, unknown>;
  const numLike = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const usdcStringToMicros = (v: unknown): number | undefined => {
    if (typeof v !== 'string') return undefined;
    const m = v.match(/^(\d+)(?:\.(\d{1,6}))?$/);
    if (!m) return undefined;
    const whole = Number(m[1]);
    const frac = m[2] ? Number((m[2] + '000000').slice(0, 6)) : 0;
    return whole * 1_000_000 + frac;
  };
  const amountMicros =
    numLike(a.max_price_micros) ??
    numLike(a.amount_micros) ??
    numLike(a.budget_micros) ??
    (numLike(a.rate_micros_per_sec) !== undefined &&
    numLike(a.duration_sec) !== undefined
      ? (a.rate_micros_per_sec as number) * (a.duration_sec as number)
      : undefined) ??
    usdcStringToMicros(a.amount_usdc) ??
    usdcStringToMicros(a.usdc_amount);
  const payTo =
    (typeof a.pay_to === 'string' && a.pay_to) ||
    (typeof a.provider === 'string' && a.provider) ||
    (typeof a.to === 'string' && a.to) ||
    (typeof a.destination === 'string' && a.destination) ||
    (typeof a.recipient === 'string' && a.recipient) ||
    (typeof a.spender === 'string' && a.spender) ||
    undefined;
  const url = typeof a.url === 'string' ? a.url : undefined;
  const chain = typeof a.chain === 'string' ? (a.chain as ChainKey) : undefined;
  return { amountMicros, payTo, url, chain };
}

// ─── Policy evaluation (pure) ────────────────────────────────────────────────
export interface PolicyDecision {
  allow: boolean;
  reason?: string;
  code?:
    | 'POLICY_STRICT_MODE'
    | 'POLICY_DENYLIST_PAYTO'
    | 'POLICY_DENYLIST_URL'
    | 'POLICY_ALLOWLIST_REQUIRED'
    | 'POLICY_CAP_EXCEEDED'
    | 'POLICY_CONFIRM_REQUIRED'
    | 'POLICY_BYPASS_FORBIDDEN';
}

function capsFor(
  policy: PolicyConfig,
  chain?: ChainKey,
): { maxPerTx?: number; maxPerDay?: number; confirmAbove?: number } {
  const g = policy.global;
  const c: PolicyCaps = (chain && policy.chains[chain]) || {};
  return {
    maxPerTx: c.maxPerTxMicros ?? g.maxPerTxMicros,
    maxPerDay: c.maxPerDayMicros ?? g.maxPerDayMicros,
    confirmAbove: c.requireConfirmAboveMicros ?? g.requireConfirmAboveMicros,
  };
}

export function evaluatePolicy(
  policy: PolicyConfig,
  call: { amountMicros?: number; payTo?: string; url?: string; chain?: ChainKey },
): PolicyDecision {
  if (policy.mode === 'strict') {
    return {
      allow: false,
      reason: 'Policy mode is strict; signing is disabled.',
      code: 'POLICY_STRICT_MODE',
    };
  }
  if (policy.mode === 'bypass') {
    const onMainnet = call.chain && /-mainnet$/.test(call.chain);
    if (onMainnet) {
      return {
        allow: false,
        reason: 'bypass mode is not allowed on mainnet chains.',
        code: 'POLICY_BYPASS_FORBIDDEN',
      };
    }
    return { allow: true };
  }
  // mode === 'policy'
  if (call.payTo && policy.denylist.payTo.includes(call.payTo)) {
    return {
      allow: false,
      reason: `pay_to ${call.payTo} is in the denylist.`,
      code: 'POLICY_DENYLIST_PAYTO',
    };
  }
  if (call.url && policy.denylist.urls.some((p) => call.url!.includes(p))) {
    return {
      allow: false,
      reason: `url matches the denylist.`,
      code: 'POLICY_DENYLIST_URL',
    };
  }
  if (policy.allowlist.payTo.length > 0 && call.payTo) {
    if (!policy.allowlist.payTo.includes(call.payTo)) {
      return {
        allow: false,
        reason: `pay_to ${call.payTo} is not in the allowlist.`,
        code: 'POLICY_ALLOWLIST_REQUIRED',
      };
    }
  }
  if (policy.allowlist.urls.length > 0 && call.url) {
    if (!policy.allowlist.urls.some((p) => call.url!.includes(p))) {
      return {
        allow: false,
        reason: `url is not in the allowlist.`,
        code: 'POLICY_ALLOWLIST_REQUIRED',
      };
    }
  }
  const caps = capsFor(policy, call.chain);
  if (
    typeof caps.maxPerTx === 'number' &&
    typeof call.amountMicros === 'number' &&
    call.amountMicros > caps.maxPerTx
  ) {
    return {
      allow: false,
      reason: `amount ${call.amountMicros} exceeds maxPerTxMicros ${caps.maxPerTx}.`,
      code: 'POLICY_CAP_EXCEEDED',
    };
  }
  // Note: maxPerDay enforcement uses the audit log; checked separately.
  return { allow: true };
}

/** Sum of amountMicros recorded in audit.log within the rolling 24h window. */
async function spentLast24h(home?: string): Promise<number> {
  const f = auditLogPath(home);
  if (!existsSync(f)) return 0;
  try {
    const raw = await readFile(f, 'utf8');
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let sum = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { ts?: string; amountMicros?: number; ok?: boolean };
        if (!r.ok) continue;
        const ts = r.ts ? Date.parse(r.ts) : NaN;
        if (Number.isFinite(ts) && ts >= cutoff && typeof r.amountMicros === 'number') {
          sum += r.amountMicros;
        }
      } catch {
        /* skip */
      }
    }
    return sum;
  } catch {
    return 0;
  }
}

// ─── Audit log (JSONL, append-only, redacted, rotated at 5 MiB) ──────────────
const REDACT_KEYS = /(privateKey|passphrase|seed|bearer|api[_-]?key|secret|password|token)/i;

/** Redact values that look like secrets regardless of key name. */
function isSecretValue(v: unknown): boolean {
  if (typeof v !== 'string' || v.length < 10) return false;
  // Private key (0x + 64 hex)
  if (/^0x[0-9a-f]{64}$/i.test(v)) return true;
  // XRPL seed (s + 28+ base58)
  if (/^s[A-Za-z0-9]{28,}$/.test(v)) return true;
  // Bearer token
  if (/^Bearer\s+.{10,}$/i.test(v)) return true;
  // Mnemonic (12+ words)
  if (v.split(' ').length >= 12 && /^[a-z ]+$/.test(v)) return true;
  return false;
}

export function redactArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactArgs);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEYS.test(k)) { out[k] = '<redacted>'; }
      else if (isSecretValue(v)) { out[k] = '<redacted-value>'; }
      else { out[k] = redactArgs(v); }
    }
    return out;
  }
  if (isSecretValue(value)) return '<redacted-value>';
  return value;
}

export interface AuditEntry {
  ts: string;
  tool: string;
  walletName: string;
  ok: boolean;
  code?: string;
  amountMicros?: number;
  payTo?: string;
  url?: string;
  chain?: ChainKey;
  args?: unknown;
}

async function rotateIfLarge(p: string): Promise<void> {
  if (!existsSync(p)) return;
  const s = await stat(p);
  if (s.size < AUDIT_ROTATE_BYTES) return;
  await rename(p, `${p}.1`);
}

export async function appendAudit(
  entry: AuditEntry,
  home?: string,
): Promise<void> {
  const p = auditLogPath(home);
  await mkdir(dirname(p), { recursive: true });
  await rotateIfLarge(p);
  const line = JSON.stringify({ ...entry, args: redactArgs(entry.args) }) + '\n';
  await appendFile(p, line, { mode: 0o600 });
  // Ensure mode on first write.
  if (!existsSync(p + '.chmodded')) {
    try {
      await chmod(p, 0o600);
    } catch {
      /* best-effort */
    }
  }
}

// ─── Signing guard (single chokepoint) ───────────────────────────────────────
// ─── Confirmation token (F-03) ───────────────────────────────────────────────
let _sessionSecret: Buffer | null = null;
function getSessionSecret(): Buffer {
  if (!_sessionSecret) _sessionSecret = randomBytes(32);
  return _sessionSecret;
}

/**
 * Validate a time-based HMAC confirmation token.
 * Token = HMAC-SHA256(sessionSecret, "tool:amountMicros:minuteBucket").slice(0, 16)
 * Valid for current minute and previous minute (2-minute window).
 */
function validateConfirmToken(token: string, tool: string, amountMicros: number): boolean {
  const secret = getSessionSecret();
  const now = Math.floor(Date.now() / 60_000);
  for (const offset of [0, -1]) {
    const expected = createHmac('sha256', secret)
      .update(`${tool}:${amountMicros}:${now + offset}`)
      .digest('hex')
      .slice(0, 16);
    if (token === expected) return true;
  }
  return false;
}

/** Generate a confirmation token (exposed for CLI `confirm` command). */
export function generateConfirmToken(tool: string, amountMicros: number): string {
  const secret = getSessionSecret();
  const now = Math.floor(Date.now() / 60_000);
  return createHmac('sha256', secret)
    .update(`${tool}:${amountMicros}:${now}`)
    .digest('hex')
    .slice(0, 16);
}

async function guardSigningCall(
  toolName: string,
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  const policy = await loadPolicy();
  const insp = inspectArgs(args);
  const chain = insp.chain ?? ctx.defaultChain;

  // 1. Mode-level rate limit (token bucket).
  if (rateLimitHit(policy.rateLimit.perMinute)) {
    return fail(
      `Rate limit exceeded: max ${policy.rateLimit.perMinute} signing calls/minute.`,
      'RATE_LIMIT',
      'Lower the call frequency or raise policy.rateLimit.perMinute.',
    );
  }

  // 2. Unlock required.
  if (!isUnlocked(ctx.walletName)) {
    return fail(
      `Wallet "${ctx.walletName}" is locked.`,
      'LOCKED',
      'Run `n-payment-skill unlock` (passphrase prompt).',
    );
  }

  // 3. Policy evaluation.
  const decision = evaluatePolicy(policy, { ...insp, chain });
  if (!decision.allow) {
    return fail(decision.reason ?? 'Policy denied the call.', decision.code ?? 'POLICY_DENIED');
  }

  // 4. Rolling 24h cap (uses audit log).
  const caps = capsFor(policy, chain);
  if (typeof caps.maxPerDay === 'number' && typeof insp.amountMicros === 'number') {
    const spent = await spentLast24h();
    if (spent + insp.amountMicros > caps.maxPerDay) {
      return fail(
        `Daily cap would be exceeded (${spent + insp.amountMicros} > ${caps.maxPerDay}).`,
        'POLICY_CAP_EXCEEDED',
        'Raise policy.global.maxPerDayMicros or wait for the rolling window to clear.',
      );
    }
  }

  // 5. F-03 fix: Confirmation threshold — require _confirmToken for high-value calls.
  if (
    typeof caps.confirmAbove === 'number' &&
    typeof insp.amountMicros === 'number' &&
    insp.amountMicros > caps.confirmAbove
  ) {
    const token = (args as Record<string, unknown> | null)?._confirmToken;
    if (typeof token !== 'string' || !validateConfirmToken(token, toolName, insp.amountMicros)) {
      return fail(
        `Amount ${insp.amountMicros} exceeds confirmation threshold (${caps.confirmAbove}). Provide _confirmToken to proceed.`,
        'POLICY_CONFIRM_REQUIRED',
        'Generate a confirmation token via `n-payment-skill confirm <tool> <amount>` and pass it as _confirmToken.',
      );
    }
  }

  return null;
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
      return rpcError(
        id,
        -32602,
        `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }

    // Single chokepoint for every signing call.
    let result: ToolResult;
    if (isSigningCall(p.name, parsed.data)) {
      const denied = await guardSigningCall(p.name, parsed.data, ctx);
      if (denied) {
        result = denied;
      } else {
        result = await tool.handler(parsed.data, ctx);
      }
      // Audit every signing call (allow or deny).
      const insp = inspectArgs(parsed.data);
      await appendAudit({
        ts: new Date().toISOString(),
        tool: p.name,
        walletName: ctx.walletName,
        ok: result.ok,
        code: result.ok ? undefined : result.code,
        amountMicros: insp.amountMicros,
        payTo: insp.payTo,
        url: insp.url,
        chain: insp.chain ?? ctx.defaultChain,
        args: parsed.data,
      });
    } else {
      result = await tool.handler(parsed.data, ctx);
    }

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
export async function runStdio(
  ctxFactory: () => Promise<ToolContext> = buildContext,
): Promise<void> {
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

// ─── HTTP transport (bearer-token protected) ────────────────────────────────
export interface HttpServerHandle {
  port: number;
  close(): Promise<void>;
}

/**
 * Verify the request carries `Authorization: Bearer <token>` matching the
 * stored MCP token. Returns null on success or a `(status, message)` pair
 * on failure. When no token is configured on disk, the server refuses
 * every /mcp request — fail-closed by default in v2.
 */
function authorize(
  req: IncomingMessage,
  expected: string | null,
): { status: number; message: string } | null {
  if (!expected) {
    return {
      status: 503,
      message:
        'MCP token not configured. Run `n-payment-skill setup` to generate ~/.n-payment/mcp.token.',
    };
  }
  const header = req.headers['authorization'];
  if (!header || Array.isArray(header)) {
    return { status: 401, message: 'Missing Authorization header.' };
  }
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m || m[1]!.trim() !== expected) {
    return { status: 401, message: 'Invalid bearer token.' };
  }
  return null;
}

export async function runHttp(
  port = 8081,
  ctxFactory: () => Promise<ToolContext> = buildContext,
  tokenLoader: () => Promise<string | null> = readMcpToken,
): Promise<HttpServerHandle> {
  const ctx = await ctxFactory();
  const expectedToken = await tokenLoader();
  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: MCP_VERSION }));
        return;
      }
      if (req.method === 'POST' && req.url === '/mcp') {
        const denied = authorize(req, expectedToken);
        if (denied) {
          res.writeHead(denied.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(rpcError(null, -32001, denied.message)));
          return;
        }
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
    },
  );
  const host = process.env.MCP_HTTP_HOST || '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const actualPort = (server.address() as { port: number }).port;
  return {
    port: actualPort,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
