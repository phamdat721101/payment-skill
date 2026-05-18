// Declarative host registry + install dispatcher.
//
// Each host is a record { id, name, detect, apply }. The registry is the
// only place new hosts are added — `installHosts()` iterates and never
// branches on host id. JSON merges preserve user data; markdown writers
// append idempotently.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { renderSkill } from './skill.js';

// ─── Shared MCP server entry ─────────────────────────────────────────────────
const MCP_SERVER_ENTRY = {
  command: 'n-payment-skill',
  args: ['mcp', '--stdio'],
  env: {},
} as const;

const SKILL_TAG = '<!-- n-payment-skill: managed block -->';

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

async function readJson<T = unknown>(p: string, fallback: T): Promise<T> {
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(await readFile(p, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(p: string, data: unknown): Promise<void> {
  await ensureDir(dirname(p));
  await writeFile(p, JSON.stringify(data, null, 2) + '\n');
}

/** Merge our MCP server entry into a host's mcp.json-style config. */
async function upsertMcpServer(p: string): Promise<string> {
  type Cfg = { mcpServers?: Record<string, unknown>; [k: string]: unknown };
  const cfg = await readJson<Cfg>(p, {});
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), 'n-payment': MCP_SERVER_ENTRY };
  await writeJson(p, cfg);
  return p;
}

/** Idempotent SKILL.md drop. */
async function writeSkillFile(dir: string): Promise<string> {
  await ensureDir(dir);
  const target = join(dir, 'SKILL.md');
  await writeFile(target, renderSkill());
  return target;
}

/** Append a small managed block to a markdown instructions file. */
async function upsertMarkdownBlock(p: string, body: string): Promise<string> {
  await ensureDir(dirname(p));
  const block = `\n${SKILL_TAG}\n${body}\n${SKILL_TAG.replace('managed block', 'end')}\n`;
  if (!existsSync(p)) {
    await writeFile(p, block);
    return p;
  }
  const cur = await readFile(p, 'utf8');
  if (cur.includes(SKILL_TAG)) {
    const re = new RegExp(`${SKILL_TAG}[\\s\\S]*?${SKILL_TAG.replace('managed block', 'end')}`);
    await writeFile(p, cur.replace(re, block.trim()));
  } else {
    await appendFile(p, block);
  }
  return p;
}

// ─── Host contract ───────────────────────────────────────────────────────────
export type HostId =
  | 'claude'
  | 'kiro'
  | 'cursor'
  | 'windsurf'
  | 'continue'
  | 'gemini'
  | 'copilot';

export interface InstallOptions {
  home?: string; // override $HOME (tests)
  cwd?: string; // override CWD (project-scoped writes)
}

export interface HostDefinition {
  id: HostId;
  name: string;
  scope: 'user' | 'project';
  detect(opts: { home: string; cwd: string }): boolean;
  apply(opts: { home: string; cwd: string }): Promise<string[]>;
}

const RULES_BODY = `## n-payment-skill

Use the \`n-payment\` tools (pay, check_balance, create_paywall, discover, …)
when the user asks to pay for an API, accept payments, off-ramp USDC,
generate a payment QR, manage agent identity, or delegate budgets across
agents. The skill auto-bootstraps a testnet wallet at
\`~/.n-payment/wallets/default.json\`. See \`~/.claude/skills/n-payment/SKILL.md\`.`;

// ─── Registry ────────────────────────────────────────────────────────────────
export const HOSTS: ReadonlyArray<HostDefinition> = [
  {
    id: 'claude',
    name: 'Claude Code',
    scope: 'user',
    detect: ({ home }) => existsSync(join(home, '.claude')),
    apply: async ({ home }) => [
      await writeSkillFile(join(home, '.claude', 'skills', 'n-payment')),
    ],
  },
  {
    id: 'kiro',
    name: 'Kiro',
    scope: 'user',
    detect: ({ home }) => existsSync(join(home, '.kiro')),
    apply: async ({ home }) => [
      await writeSkillFile(join(home, '.kiro', 'skills', 'n-payment')),
    ],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    scope: 'user',
    detect: ({ home }) => existsSync(join(home, '.cursor')),
    apply: async ({ home, cwd }) => {
      const out: string[] = [];
      out.push(await upsertMcpServer(join(home, '.cursor', 'mcp.json')));
      if (existsSync(join(cwd, '.cursor')) || existsSync(join(cwd, '.git'))) {
        out.push(
          await upsertMarkdownBlock(
            join(cwd, '.cursor', 'rules', 'n-payment.mdc'),
            RULES_BODY,
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    scope: 'user',
    detect: ({ home }) => existsSync(join(home, '.codeium', 'windsurf')),
    apply: async ({ home, cwd }) => {
      const out = [
        await upsertMcpServer(
          join(home, '.codeium', 'windsurf', 'mcp_config.json'),
        ),
      ];
      if (existsSync(join(cwd, '.git'))) {
        out.push(await upsertMarkdownBlock(join(cwd, '.windsurfrules'), RULES_BODY));
      }
      return out;
    },
  },
  {
    id: 'continue',
    name: 'Continue',
    scope: 'user',
    detect: ({ home }) => existsSync(join(home, '.continue')),
    apply: async ({ home, cwd }) => {
      const out = [await upsertMcpServer(join(home, '.continue', 'config.json'))];
      if (existsSync(join(cwd, '.git'))) {
        out.push(await upsertMarkdownBlock(join(cwd, '.continuerules'), RULES_BODY));
      }
      return out;
    },
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    scope: 'user',
    detect: ({ home }) => existsSync(join(home, '.gemini')),
    apply: async ({ home }) => {
      const dir = join(home, '.gemini', 'extensions', 'n-payment');
      await ensureDir(dir);
      const manifest = {
        name: 'n-payment',
        version: '1.0.0',
        description: 'n-payment-skill: pay HTTP 402, x402, MPP, GOAT.',
        mcpServers: { 'n-payment': MCP_SERVER_ENTRY },
      };
      await writeJson(join(dir, 'gemini-extension.json'), manifest);
      await writeFile(join(dir, 'GEMINI.md'), renderSkill());
      return [join(dir, 'gemini-extension.json'), join(dir, 'GEMINI.md')];
    },
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    scope: 'project',
    detect: ({ cwd }) => existsSync(join(cwd, '.git')),
    apply: async ({ cwd }) => [
      await upsertMarkdownBlock(
        join(cwd, '.github', 'copilot-instructions.md'),
        RULES_BODY,
      ),
    ],
  },
];

export const HOST_BY_ID: Readonly<Record<HostId, HostDefinition>> = Object.freeze(
  Object.fromEntries(HOSTS.map((h) => [h.id, h])) as Record<HostId, HostDefinition>,
);

// ─── Dispatcher ──────────────────────────────────────────────────────────────
export interface HostResult {
  host: HostId;
  ok: boolean;
  files: string[];
  error?: string;
}

export interface InstallReport {
  detected: HostId[];
  applied: HostResult[];
}

export function detectHosts(opts: InstallOptions = {}): HostId[] {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  return HOSTS.filter((h) => h.detect({ home, cwd })).map((h) => h.id);
}

export async function installHosts(
  targets: HostId[] | 'auto',
  opts: InstallOptions = {},
): Promise<InstallReport> {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const ids = targets === 'auto' ? detectHosts({ home, cwd }) : targets;
  const detected = detectHosts({ home, cwd });
  const applied: HostResult[] = [];
  for (const id of ids) {
    const host = HOST_BY_ID[id];
    if (!host) {
      applied.push({ host: id, ok: false, files: [], error: 'Unknown host' });
      continue;
    }
    try {
      const files = await host.apply({ home, cwd });
      applied.push({ host: id, ok: true, files });
    } catch (e) {
      applied.push({ host: id, ok: false, files: [], error: (e as Error).message });
    }
  }
  return { detected, applied };
}
