// `n-payment-skill` CLI — commander-based subcommand router.
//
// Zero-arg invocation runs `setup`: detect hosts, write skill/MCP config,
// generate (or migrate) wallet, faucet, run doctor, print next-step summary.
//
// v2 additions: unlock/lock/policy/audit subcommands; setup now ensures the
// wallet is encrypted (Web3 Secret Storage v3) and the MCP bearer token
// exists; wallet show uses publicView so locked wallets can still be
// inspected for the address.

import { Command } from 'commander';
import prompts from 'prompts';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { TOOLS, TOOL_BY_NAME, type ChainKey } from './tools.js';
import { toJsonSchema } from './schema.js';
import {
  createEncryptedWallet,
  ensureWallet,
  isWalletEncrypted,
  listWallets,
  lock,
  lockAll,
  migrateLegacyPlaintext,
  publicView,
  purgeLegacy,
  unlock,
} from './wallet.js';
import {
  auditLogPath,
  ensureMcpToken,
  loadConfig,
  loadPolicy,
  patchPolicyAt,
  readMcpToken,
  resetPolicy,
  saveConfig,
  savePolicy,
} from './config.js';
import { CHAIN_META, isTestnetChain, requestFaucet, runDoctor } from './faucet.js';
import { renderSkill } from './skill.js';
import { detectHosts, installHosts, HOSTS, type HostId } from './hosts.js';
import { runStdio, runHttp, MCP_VERSION } from './mcp.js';

const VERSION = '2.0.0';

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

// ─── Passphrase helper ───────────────────────────────────────────────────────
/**
 * Resolve a passphrase from the safest available source:
 *   1. explicit `--passphrase` flag (least safe — visible in shell history),
 *   2. `N_PAYMENT_PASSPHRASE` env var (CI),
 *   3. interactive TTY prompt (preferred),
 *   4. random 32-byte hex printed once (non-TTY fallback).
 */
async function resolvePassphrase(opts: {
  flag?: string;
  prompt?: string;
  allowGenerate?: boolean;
}): Promise<{ passphrase: string; generated: boolean }> {
  if (opts.flag) return { passphrase: opts.flag, generated: false };
  const fromEnv = process.env.N_PAYMENT_PASSPHRASE;
  if (fromEnv) return { passphrase: fromEnv, generated: false };
  if (process.stdin.isTTY) {
    const a = await prompts({
      type: 'password',
      name: 'pw',
      message: opts.prompt ?? 'Wallet passphrase (min 8 chars)',
      validate: (v: string) => (v.length >= 8 ? true : 'min 8 chars'),
    });
    if (typeof a.pw !== 'string') die('Cancelled.');
    return { passphrase: a.pw as string, generated: false };
  }
  if (!opts.allowGenerate) {
    die(
      'No TTY and no passphrase provided. Set N_PAYMENT_PASSPHRASE or pass --passphrase.',
    );
  }
  return { passphrase: randomBytes(32).toString('hex'), generated: true };
}

// ─── Setup orchestrator (zero-arg default) ──────────────────────────────────
async function runSetup(
  opts: { quiet?: boolean; mainnet?: boolean; passphrase?: string } = {},
): Promise<void> {
  const quiet = !!opts.quiet;
  if (!quiet) log(c.bold(`n-payment-skill v${VERSION} — one-line setup`));

  const cfg = await loadConfig();

  // 1. Wallet: encrypt fresh, or migrate v1 plaintext in place.
  const encrypted = await isWalletEncrypted(cfg.defaultWallet);
  const walletExists = (await publicView(cfg.defaultWallet)) !== null;

  let walletAddress: string;
  if (!walletExists) {
    const { passphrase, generated } = await resolvePassphrase({
      flag: opts.passphrase,
      prompt: 'Set a passphrase to encrypt your wallet',
      allowGenerate: true,
    });
    const w = await createEncryptedWallet(cfg.defaultWallet, passphrase);
    walletAddress = w.address;
    if (!quiet) {
      log(c.green(`  ✓ wallet encrypted: ${w.address}`));
      if (generated) {
        log(
          c.yellow(
            `  ⚠ auto-generated passphrase (save it now — printed once): ${passphrase}`,
          ),
        );
      }
    }
  } else if (!encrypted) {
    if (!quiet) log(c.yellow('  ⚠ legacy plaintext wallet detected; migrating…'));
    const { passphrase } = await resolvePassphrase({
      flag: opts.passphrase,
      prompt: 'New passphrase to encrypt the legacy wallet',
      allowGenerate: true,
    });
    const r = await migrateLegacyPlaintext(cfg.defaultWallet, passphrase);
    const v = await publicView(cfg.defaultWallet);
    walletAddress = v?.address ?? '0x?';
    if (!quiet) {
      log(c.green(`  ✓ migrated to v3 keystore (.legacy preserved)`));
      log(c.dim(`    → ${r.legacyPath}`));
      log(c.dim(`    → run \`n-payment-skill wallet purge-legacy\` to remove`));
    }
  } else {
    const v = await publicView(cfg.defaultWallet);
    walletAddress = v?.address ?? '0x?';
    if (!quiet) log(c.green(`  ✓ wallet already encrypted: ${walletAddress}`));
  }

  // 2. MCP bearer token (idempotent).
  const token = await ensureMcpToken();
  if (!quiet) log(c.green(`  ✓ MCP bearer token ready (${token.slice(0, 8)}…)`));

  // 3. Hosts.
  const detected = detectHosts();
  if (detected.length === 0) {
    if (!quiet) {
      log(
        c.yellow('No supported AI host detected.'),
        '\n  → Skipping host wiring. Run `n-payment-skill install --target <host>` later.',
      );
    }
  } else {
    const report = await installHosts('auto');
    if (!quiet) {
      for (const r of report.applied) {
        const status = r.ok ? c.green('✓') : c.red('✗');
        log(`  ${status} ${r.host} (${r.files.length} files)`);
      }
    }
  }

  // 4. Faucet (testnet only, mainnet opt-in skips).
  if (!opts.mainnet && isTestnetChain(cfg.defaultChain)) {
    const r = await requestFaucet(walletAddress as `0x${string}`, cfg.defaultChain);
    if (!quiet) log(`  ${r.ok ? c.green('✓') : c.yellow('⚠')} faucet: ${r.message}`);
    if (r.manualUrl && !quiet) log(c.dim(`    → manual: ${r.manualUrl}`));
  }

  // 5. Doctor.
  if (!quiet) {
    const report = await runDoctor(walletAddress as `0x${string}`, cfg.defaultChain);
    log(c.bold('\nDoctor:'));
    for (const ck of report.checks) {
      const tag =
        ck.status === 'ok' ? c.green('✓') : ck.status === 'warn' ? c.yellow('⚠') : c.red('✗');
      log(`  ${tag} ${ck.name}: ${ck.message}`);
      if (ck.hint) log(c.dim(`     → ${ck.hint}`));
    }
  }

  // 6. Next-step summary.
  if (!quiet) {
    log(
      c.bold('\nNext:'),
      `\n  Unlock to sign:   ${c.bold('n-payment-skill unlock')}`,
      `\n  Talk to the agent: "${c.bold('pay for https://x402-demo.example/data')}"`,
      `\n  Inspect policy:   ${c.dim('n-payment-skill policy show')}`,
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
  .description('Auto-detect host, install skill, encrypt wallet, faucet, doctor.')
  .option('-q, --quiet', 'Suppress non-error output')
  .option('--mainnet', 'Skip testnet faucet (requires real keys)')
  .option('--passphrase <pw>', 'Passphrase for wallet encryption (avoid in shared shells)')
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

// ─── unlock / lock ───────────────────────────────────────────────────────────
program
  .command('unlock')
  .description('Decrypt the wallet into the in-memory cache (TTL-bounded).')
  .option('--passphrase <pw>', 'Pass via flag (avoid in shared shells)')
  .option('--ttl <seconds>', 'Override default unlock TTL', '1800')
  .action(async (opts: { passphrase?: string; ttl: string }) => {
    const cfg = await loadConfig();
    const policy = await loadPolicy();
    const ttl = Number(opts.ttl) || policy.unlockTtlSeconds;
    const { passphrase } = await resolvePassphrase({ flag: opts.passphrase });
    try {
      const r = await unlock(cfg.defaultWallet, passphrase, ttl);
      log(
        c.green(`✓ unlocked ${cfg.defaultWallet} (${r.address})`),
        c.dim(`expires ${new Date(r.expiresAt).toISOString()}`),
      );
    } catch (e) {
      const err = e as Error & { code?: string };
      die(`✗ ${err.code ?? 'ERROR'}: ${err.message}`);
    }
  });

program
  .command('lock')
  .description('Clear the in-memory unlock cache for all wallets.')
  .action(() => {
    lockAll();
    log(c.green('✓ all wallets locked'));
    void lock; // keep import alive (used by future per-wallet lock command)
  });

// ─── Wallet ──────────────────────────────────────────────────────────────────
const wallet = program.command('wallet').description('Manage local wallets.');

wallet
  .command('show')
  .option('--address', 'Print only the address')
  .action(async (opts: { address?: boolean }) => {
    const cfg = await loadConfig();
    const v = await publicView(cfg.defaultWallet);
    if (!v) return die(`No wallet: ${cfg.defaultWallet}`);
    if (opts.address) log(v.address);
    else log(JSON.stringify(v, null, 2));
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
  .option('--passphrase <pw>', 'Encrypt the new wallet with this passphrase')
  .option('--plaintext', 'Skip encryption (NOT RECOMMENDED — testing only)')
  .action(
    async (
      name: string,
      opts: { passphrase?: string; plaintext?: boolean },
    ) => {
      if (opts.plaintext) {
        const w = await ensureWallet(name);
        log(c.yellow(`⚠ plaintext wallet ${name}: ${w.address}`));
        return;
      }
      const { passphrase } = await resolvePassphrase({
        flag: opts.passphrase,
        prompt: `Passphrase for new wallet "${name}"`,
        allowGenerate: false,
      });
      const w = await createEncryptedWallet(name, passphrase);
      log(c.green(`✓ encrypted wallet ${name}: ${w.address}`));
    },
  );

wallet
  .command('migrate')
  .description('Encrypt a v1 plaintext wallet in place (preserves .legacy).')
  .option('--name <name>', 'Wallet name', 'default')
  .option('--passphrase <pw>', 'Passphrase to encrypt with')
  .action(async (opts: { name: string; passphrase?: string }) => {
    const { passphrase } = await resolvePassphrase({ flag: opts.passphrase });
    const r = await migrateLegacyPlaintext(opts.name, passphrase);
    if (!r.migrated) return log(c.dim(`${opts.name} is already encrypted`));
    log(c.green(`✓ ${opts.name} encrypted (${r.legacyPath})`));
  });

wallet
  .command('purge-legacy')
  .description('Delete the .legacy plaintext backup left by `wallet migrate`.')
  .option('--name <name>', 'Wallet name', 'default')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (opts: { name: string; yes?: boolean }) => {
    if (!opts.yes && process.stdin.isTTY) {
      const a = await prompts({
        type: 'confirm',
        name: 'ok',
        message: `Delete ${opts.name}.json.legacy? This cannot be undone.`,
        initial: false,
      });
      if (!a.ok) return log(c.dim('cancelled'));
    }
    const r = await purgeLegacy(opts.name);
    log(c.green(`✓ removed ${r.removed} legacy file(s)`));
  });

// ─── Doctor / Faucet ─────────────────────────────────────────────────────────
program
  .command('doctor')
  .description('Run health checks against the wallet + RPC + faucet.')
  .option('--chain <chain>', 'Override the default chain')
  .action(async (opts: { chain?: ChainKey }) => {
    const cfg = await loadConfig();
    const v = await publicView(cfg.defaultWallet);
    if (!v) return die(`No wallet: ${cfg.defaultWallet}`);
    const chain = opts.chain ?? cfg.defaultChain;
    const r = await runDoctor(v.address, chain);
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
    const v = await publicView(cfg.defaultWallet);
    if (!v) return die(`No wallet: ${cfg.defaultWallet}`);
    const r = await requestFaucet(v.address, opts.chain);
    log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  });

// ─── Config ──────────────────────────────────────────────────────────────────
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

// ─── Policy ──────────────────────────────────────────────────────────────────
const policy = program
  .command('policy')
  .description('Inspect or edit the policy gate (~/.n-payment/policy.json).');
policy
  .command('show')
  .action(async () => {
    log(JSON.stringify(await loadPolicy(), null, 2));
  });
policy
  .command('set')
  .argument('<path>', 'dot.path inside policy.json (e.g. global.maxPerTxMicros)')
  .argument('<value>', 'JSON-coerced value (true/false/numbers/strings/arrays)')
  .action(async (path: string, value: string) => {
    const current = await loadPolicy();
    const next = patchPolicyAt(current, path, value);
    const saved = await savePolicy(next);
    log(c.green(`✓ ${path} updated`));
    log(c.dim(JSON.stringify(saved, null, 2)));
  });
policy
  .command('reset')
  .action(async () => {
    const fresh = await resetPolicy();
    log(c.green('✓ policy reset to defaults'));
    log(c.dim(JSON.stringify(fresh, null, 2)));
  });

// ─── Audit ───────────────────────────────────────────────────────────────────
const audit = program.command('audit').description('Inspect the audit log.');
audit
  .command('tail')
  .option('-n, --lines <n>', 'Number of lines from the tail', '50')
  .action(async (opts: { lines: string }) => {
    const p = auditLogPath();
    if (!existsSync(p)) return log(c.dim('(audit log is empty)'));
    const raw = await readFile(p, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const n = Math.max(1, Number(opts.lines) || 50);
    for (const line of lines.slice(-n)) log(line);
  });

// ─── MCP ─────────────────────────────────────────────────────────────────────
const mcp = program
  .command('mcp')
  .description('Run the MCP server (stdio by default).');
mcp
  .option('--stdio', 'Use stdio transport (default)', true)
  .option('--http', 'Use HTTP transport')
  .option('-p, --port <port>', 'HTTP port', '8081')
  .action(async (opts: { http?: boolean; port: string }) => {
    if (opts.http) {
      const handle = await runHttp(Number(opts.port));
      log(c.green(`MCP HTTP listening on :${handle.port} (mcp v${MCP_VERSION})`));
      log(c.dim('  Authorization: Bearer <token from `n-payment-skill mcp token`>'));
      return new Promise(() => {}); // keep alive
    }
    await runStdio();
  });
mcp
  .command('token')
  .description('Print (or generate) the MCP bearer token.')
  .action(async () => {
    const t = (await readMcpToken()) ?? (await ensureMcpToken());
    log(t);
  });

// ─── Tools registry inspectors ───────────────────────────────────────────────
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
  .action(
    async (target: string, opts: { out?: string; serverUrl?: string }) => {
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
    },
  );

// Touch unused imports to silence linters.
void CHAIN_META;
void HOSTS;

program.parseAsync().catch((e) => die((e as Error).message));
