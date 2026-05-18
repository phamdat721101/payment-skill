import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { detectHosts, installHosts, HOSTS } from '../src/hosts.ts';

let HOME = '';
let CWD = '';

beforeEach(async () => {
  HOME = await mkdtemp(join(tmpdir(), 'n-payment-host-'));
  CWD = await mkdtemp(join(tmpdir(), 'n-payment-cwd-'));
  // Project must look like a git repo for project-scoped hosts to engage.
  await mkdir(join(CWD, '.git'), { recursive: true });
});
afterEach(async () => {
  await rm(HOME, { recursive: true, force: true });
  await rm(CWD, { recursive: true, force: true });
});

describe('host registry', () => {
  it('exposes seven hosts (claude, kiro, cursor, windsurf, continue, gemini, copilot)', () => {
    expect(HOSTS.map((h) => h.id).sort()).toEqual([
      'claude',
      'continue',
      'copilot',
      'cursor',
      'gemini',
      'kiro',
      'windsurf',
    ]);
  });

  it('detects no user-scoped hosts on a clean HOME', () => {
    const ids = detectHosts({ home: HOME, cwd: CWD });
    // copilot is project-scoped and we created .git, so it shows up.
    expect(ids.includes('claude')).toBe(false);
    expect(ids.includes('copilot')).toBe(true);
  });

  it('detects claude when ~/.claude exists', async () => {
    await mkdir(join(HOME, '.claude'), { recursive: true });
    expect(detectHosts({ home: HOME, cwd: CWD })).toContain('claude');
  });
});

describe('installHosts', () => {
  it('writes SKILL.md for Claude Code under ~/.claude/skills/n-payment/', async () => {
    await mkdir(join(HOME, '.claude'), { recursive: true });
    const r = await installHosts(['claude'], { home: HOME, cwd: CWD });
    expect(r.applied[0]?.ok).toBe(true);
    const out = join(HOME, '.claude', 'skills', 'n-payment', 'SKILL.md');
    expect(existsSync(out)).toBe(true);
    const md = await readFile(out, 'utf8');
    expect(md.startsWith('---\nname: n-payment')).toBe(true);
  });

  it('upserts MCP server for Cursor without clobbering existing entries', async () => {
    const cfgFile = join(HOME, '.cursor', 'mcp.json');
    await mkdir(join(HOME, '.cursor'), { recursive: true });
    await writeFile(
      cfgFile,
      JSON.stringify({ mcpServers: { other: { command: 'x' } }, foo: 1 }, null, 2),
    );
    await installHosts(['cursor'], { home: HOME, cwd: CWD });
    const cfg = JSON.parse(await readFile(cfgFile, 'utf8')) as {
      mcpServers: Record<string, unknown>;
      foo: number;
    };
    expect(cfg.mcpServers.other).toEqual({ command: 'x' });
    expect(cfg.mcpServers['n-payment']).toBeDefined();
    expect(cfg.foo).toBe(1);
  });

  it('writes Gemini extension manifest with mcpServers + GEMINI.md', async () => {
    await mkdir(join(HOME, '.gemini'), { recursive: true });
    const r = await installHosts(['gemini'], { home: HOME, cwd: CWD });
    expect(r.applied[0]?.ok).toBe(true);
    const dir = join(HOME, '.gemini', 'extensions', 'n-payment');
    expect(existsSync(join(dir, 'gemini-extension.json'))).toBe(true);
    expect(existsSync(join(dir, 'GEMINI.md'))).toBe(true);
    const manifest = JSON.parse(
      await readFile(join(dir, 'gemini-extension.json'), 'utf8'),
    ) as { mcpServers: Record<string, unknown> };
    expect(manifest.mcpServers['n-payment']).toBeDefined();
  });

  it('writes Copilot instructions in project .github/ when in a git repo', async () => {
    const r = await installHosts(['copilot'], { home: HOME, cwd: CWD });
    expect(r.applied[0]?.ok).toBe(true);
    const out = join(CWD, '.github', 'copilot-instructions.md');
    expect(existsSync(out)).toBe(true);
    const md = await readFile(out, 'utf8');
    expect(md).toContain('n-payment-skill');
  });

  it('is idempotent — re-running keeps a single managed block', async () => {
    await installHosts(['copilot'], { home: HOME, cwd: CWD });
    await installHosts(['copilot'], { home: HOME, cwd: CWD });
    const md = await readFile(
      join(CWD, '.github', 'copilot-instructions.md'),
      'utf8',
    );
    const occurrences = (md.match(/managed block/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('"auto" target installs every detected host in one pass', async () => {
    await mkdir(join(HOME, '.claude'), { recursive: true });
    await mkdir(join(HOME, '.kiro'), { recursive: true });
    const r = await installHosts('auto', { home: HOME, cwd: CWD });
    const ids = r.applied.map((a) => a.host).sort();
    expect(ids).toContain('claude');
    expect(ids).toContain('kiro');
    expect(ids).toContain('copilot');
  });
});
