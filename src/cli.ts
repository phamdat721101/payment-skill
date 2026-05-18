// `n-payment-skill` CLI — commander-based subcommand router.
//
// Zero-arg invocation runs `setup`: detect hosts, write skill/MCP config,
// generate wallet, fund testnet, run doctor, print next-step summary.

import { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import { TOOLS, TOOL_BY_NAME, type ChainKey } from './tools.js';
import { exportOpenAITools, toJsonSchema } from './schema.js';
import { ensureWallet, listWallets, summarize } from './wallet.js';
import { loadConfig, saveConfig } from './config.js';
import { CHAIN_META, isTestnetChain, requestFaucet, runDoctor } from './faucet.js';
import { renderSkill } from './skill.js';
import { detectHosts, installHosts, HOSTS, type HostId } from './hosts.js';
import { runStdio, runHttp, MCP_VERSION } from './mcp.js';

const VERSION = '1.0.0';

// ─── Pretty-print helpers ────────────────────────────────────────────────────
const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};
const log = (...a: unknown[]): void => console.log(...a);
const die = (msg: string, code = 1): never => {
  console.error(c.red(msg));
  process.exit(code);
};

// ─── Setup orchestrator (zero-arg default) ──────────────────────────────────
async function runSetup(opts: { quiet?: boolean; mainnet?: boolean } = {}): Promise<void> {
  const quiet = !!opts.quiet;
  const banner = `n-payment-skill v${VERSION} — one-line setup`;
  if (!quiet) log(c.bold(banner));

  // 1. Hosts
  const detected = detectHosts();
  if (detected.length === 0) {
    if (!quiet)
      log(
        c.yellow('No supported AI host detected.'),
        '\n  → Skipping host wiring. Run `n-payment-skill install --target <host>` later.',
      );
  } else {
    const report = await installHosts('auto');
    if (!quiet) {
      for (const r of report.applied) {
        const status = r.ok ? c.green('✓') : c.red('✗');
        log(`  ${status} ${r.host} (${r.files.length} files)`);
      }
    }
  }

  // 2. Wallet
  const cfg = await loadConfig();
  const wallet = await ensureWallet(cfg.defaultWallet);
  if (!quiet) log(c.green(`  ✓ wallet ready: ${wallet.address}`));

  // 3. Faucet (testnet only, mainnet opt-in skips)
  if (!opts.mainnet && isTestnetChain(cfg.defaultChain)) {
    const r = await requestFaucet(wallet.address, cfg.defaultChain);
    if (!quiet) log(`  ${r.ok ? c.green('✓') : c.yellow('⚠')} faucet: ${r.message}`);
    if (r.manualUrl && !quiet) log(c.dim(`    → manual: ${r.manualUrl}`));
  }

  // 4. Doctor
  if (!quiet) {
    const report = await runDoctor(wallet.address, cfg.defaultChain);
    log(c.bold('\nDoctor:'));
    for (const ck of report.checks) {
      const tag =
        ck.status === 'ok' ? c.green('✓') : ck.status === 'warn' ? c.yellow('⚠') : c.red('✗');
      log(`  ${tag} ${ck.name}: ${ck.message}`);
      if (ck.hint) log(c.dim(`     → ${ck.hint}`));
    }
  }

  // 5. Next-step summary
  if (!quiet) {
    log(
      c.bold('\nNext:'),
      `\n  Tell your AI agent: "${c.bold('pay for https://x402-demo.example/data')}"`,
      `\n  Or: "${c.bold('check my balance on base-sepolia')}"`,
      `\n  Switch to mainnet: ${c.dim('n-payment-skill config set testnetMode false')}`,
    );
  }
}

// ─── Commander wiring ────────────────────────────────────────────────────────
const program = new Command();
program
  .name('n-payment-skill')
  .description('One-line install web3 payment skill for AI agents.')
  .version(VERSION);

program
  .command('setup', { isDefault: true })
  .description('Auto-detect host, install skill, generate wallet, faucet, doctor.')
  .option('-q, --quiet', 'Suppress non-error output')
  .option('--mainnet', 'Skip testnet faucet (requires real keys)')
  .action(runSetup);

program
  .command('install')
  .description('Install the skill into one or all detected AI hosts.')
  .option('-t, --target <host>', 'claude | kiro | cursor | windsurf | continue | gemini | copilot | all', 'all')
  .action(async (opts: { target: string }) => {
    const targets = opts.target === 'all' ? 'auto' : ([opts.target as HostId]);
    const r = await installHosts(targets);
    for (const a of r.applied) {
      const tag = a.ok ? c.green('✓') : c.red('✗');
      log(`${tag} ${a.host}: ${a.files.join(', ') || a.error || ''}`);
    }
  });

program
  .command('mcp')
  .description('Run the MCP server (stdio by default).')
  .option('--stdio', 'Use stdio transport (default)', true)
  .option('--http', 'Use HTTP transport')
  .option('-p, --port <port>', 'HTTP port', '8081')
  .action(async (opts: { http?: boolean; port: string }) => {
    if (opts.http) {
      const handle = await runHttp(Number(opts.port));
      log(c.green(`MCP HTTP listening on :${handle.port} (mcp v${MCP_VERSION})`));
      // keep alive — return a never-resolving promise so node stays running
      return new Promise(() => {});
    }
    await runStdio();
  });

const wallet = program.command('wallet').description('Manage local wallets.');
wallet
  .command('show')
  .option('--address', 'Print only the address')
  .action(async (opts: { address?: boolean }) => {
    const cfg = await loadConfig();
    const w = await ensureWallet(cfg.defaultWallet);
    if (opts.address) log(w.address);
    else log(JSON.stringify(summarize(w), null, 2));
  });
wallet
  .command('list')
  .action(async () => {
    const all = await listWallets();
    log(JSON.stringify(all, null, 2));
  });
wallet
  .command('new')
  .argument('<name>')
  .action(async (name: string) => {
    const w = await ensureWallet(name);
    log(c.green(`✓ wallet ${name}: ${w.address}`));
  });

program
  .command('doctor')
  .description('Run health checks against the wallet + RPC + faucet.')
  .option('--chain <chain>', 'Override the default chain')
  .action(async (opts: { chain?: ChainKey }) => {
    const cfg = await loadConfig();
    const w = await ensureWallet(cfg.defaultWallet);
    const chain = opts.chain ?? cfg.defaultChain;
    const r = await runDoctor(w.address, chain);
    for (const ck of r.checks) {
      const tag =
        ck.status === 'ok' ? c.green('✓') : ck.status === 'warn' ? c.yellow('⚠') : c.red('✗');
      log(`${tag} ${ck.name}: ${ck.message}`);
      if (ck.hint) log(c.dim(`  → ${ck.hint}`));
    }
    process.exit(r.ok ? 0 : 1);
  });

program
  .command('faucet')
  .description('Request testnet USDC from a public faucet.')
  .option('--chain <chain>', 'Chain to drip from', 'base-sepolia')
  .action(async (opts: { chain: ChainKey }) => {
    const cfg = await loadConfig();
    const w = await ensureWallet(cfg.defaultWallet);
    const r = await requestFaucet(w.address, opts.chain);
    log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  });

const cfg = program.command('config').description('Get/set skill config.');
cfg
  .command('get')
  .argument('<key>')
  .action(async (key: string) => {
    const c2 = await loadConfig();
    log(String((c2 as unknown as Record<string, unknown>)[key] ?? ''));
  });
cfg
  .command('set')
  .argument('<key>')
  .argument('<value>')
  .action(async (key: string, value: string) => {
    const parsed = value === 'true' ? true : value === 'false' ? false : value;
    await saveConfig({ [key]: parsed } as never);
    log(c.green(`✓ ${key}=${parsed}`));
  });

const tools = program.command('tools').description('Inspect the tool registry.');
tools.command('list').action(() => {
  for (const t of TOOLS) log(`${t.name.padEnd(20)} ${t.description}`);
});
tools
  .command('schema')
  .argument('<name>')
  .action((name: string) => {
    const t = TOOL_BY_NAME[name];
    if (!t) return die(`Unknown tool: ${name}`);
    log(JSON.stringify(toJsonSchema(t), null, 2));
  });

program
  .command('skill')
  .description('Render the SKILL.md (with the live tools list injected).')
  .option('-o, --out <file>', 'Write to file instead of stdout')
  .action(async (opts: { out?: string }) => {
    const md = renderSkill();
    if (opts.out) {
      await writeFile(opts.out, md);
      log(c.green(`✓ wrote ${opts.out}`));
    } else log(md);
  });

program
  .command('export')
  .description('Generate paste-ready tool artifacts for a target.')
  .argument('<target>', 'openai | chatgpt-gpt | langchain | llamaindex')
  .option('-o, --out <file>', 'Write to file instead of stdout')
  .option('--server-url <url>', 'Public URL of the MCP HTTP server (chatgpt-gpt only)')
  .action(async (target: string, opts: { out?: string; serverUrl?: string }) => {
    const { openaiTools, chatgptGptOpenApi, langchainJsSnippet, llamaindexJsSnippet } =
      await import('./exports.js');
    let body: string;
    switch (target) {
      case 'openai':
        body = JSON.stringify(openaiTools(), null, 2);
        break;
      case 'chatgpt-gpt':
        body = JSON.stringify(chatgptGptOpenApi(opts.serverUrl), null, 2);
        break;
      case 'langchain':
        body = langchainJsSnippet();
        break;
      case 'llamaindex':
        body = llamaindexJsSnippet();
        break;
      default:
        return die(`Unknown export target: ${target}`);
    }
    if (opts.out) {
      await writeFile(opts.out, body);
      log(c.green(`✓ wrote ${opts.out}`));
    } else log(body);
  });

// Touch unused name to silence linters when chains map is unused at top level.
void CHAIN_META;
void HOSTS;

program.parseAsync().catch((e) => die(e.message));
