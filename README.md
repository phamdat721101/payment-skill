<div align="center">

# 💸 n-payment-skill

### **One skill. Your AI agent can pay, get paid, and earn yield.**

*No SDK glue. No protocol homework. Just talk to your agent.*

[![npm](https://img.shields.io/npm/v/n-payment-skill?logo=npm&color=cb3837)](https://www.npmjs.com/package/n-payment-skill)
[![hosts](https://img.shields.io/badge/works%20with-7%20AI%20hosts-blue)](#-works-with-every-agent-host)
[![license](https://img.shields.io/github/license/phamdat721101/payment-skill)](./LICENSE)

```bash
npx -y github:phamdat721101/payment-skill
```

</div>

---

## ✨ What You Get

| 💸 **Pay services** | 🏪 **Sell services** | 📈 **Earn while idle** |
|:---|:---|:---|
| Pay any paid API or web service from chat. The skill handles the wallet, the signature, the retry — your agent just gets the answer. | Turn any HTTP endpoint into a paid service in one prompt. The skill generates a drop-in Express middleware. | Idle balance = lost yield. One prompt parks your stablecoins in a battle-tested money market and gives them back the moment you need to spend. |

> **One wallet, one config, one install** — every feature shares the same secure local key.

---

## 🚀 1-Line Install

```bash
npx -y github:phamdat721101/payment-skill
```

That single command does everything for you:

- 🧩 **Detects your AI host** (Claude Code, Kiro, Cursor, Windsurf, Continue, Gemini CLI, Copilot) and wires the skill in place.
- 🔐 **Creates your wallet** — local, mode `0600`, never echoed to chat, never sent anywhere.
- 💧 **Drips testnet funds** so you can try every flow without spending real money.
- 🩺 **Runs a doctor check** and prints the next prompt to try.

> 💡 Re-run it any time — it's idempotent. Upgrades the skill, never duplicates config.

---

## 🎯 Three Prompts To Try

Open your agent and paste these exactly. The skill picks the right tool every time.

### 1️⃣ 💸 Pay for an API

> *"Pay for https://x402-demo.example/data"*

The agent reads the price tag, signs from your wallet, calls the endpoint, and hands you the response body. No keys. No CLI. No clicking *"Approve"*.

### 2️⃣ 🏪 Monetize your own API

> *"Create a paywall for /forecast at 0.05 USDC on base-sepolia"*

You get ready-to-run Express middleware back:

```ts
import express from 'express';
import { createAgentProvider, paidTool } from 'n-payment';

const provider = createAgentProvider({
  name: 'forecast',
  payTo: '0xYourMerchantAddress',
  chain: 'base-sepolia',
  tools: [paidTool({ name: 'forecast', price: 50_000, handler: async () => ({ ok: true }) })],
});

express().use(provider.middleware()).listen(3000);
```

Drop it in, run `node server.js`, and any AI agent on the network can pay your endpoint.

### 3️⃣ 📈 Earn yield while you wait to spend

> *"Earn yield on my idle USDC"*

The skill supplies your stablecoin into a leading on-chain money market and returns the yield-bearing receipt token. You keep custody. You can pull funds back any time:

| Ask the agent | What happens |
|---|---|
| *"check my yield position"* | Reads your principal + accrued interest. |
| *"supply 5 USDC to earn yield"* | Adds 5 USDC to the position. |
| *"withdraw 0.5 USDC from yield"* | Pulls funds back to your spending wallet instantly. |

> 📖 Full walkthroughs live in [`docs/`](./docs) — payments, monetization, and yield each get a 3-minute article.

---

## 🔐 Security Model — Encrypted, Policy-Gated, Auditable

v2 retires the "unverified credentials, low trustworthiness, high
permissions" warning at install time. The skill ships with a **hardware-
wallet-style key vault** on disk and a **single-chokepoint guard** around
every signing call. You get a working testnet wallet in one command, and a
production-grade trust posture the moment you opt into mainnet.

| ✅ Property | What it means for you |
|---|---|
| 🔒 **Encrypted at rest** | Keys live in a Web3 Secret Storage v3 file (`scrypt` + AES-128-CTR + Keccak MAC). Interop with viem / ethers / geth / hardware-wallet imports. No plaintext after `setup`. |
| 🔓 **In-memory unlock** | `n-payment-skill unlock` decrypts once per session. Cache auto-evicts after `policy.unlockTtlSeconds` (30 min default). No private key ever touches disk after the upgrade. |
| 🛂 **Policy-gated dispatcher** | Every signing call passes through one guard: `unlock` → `denylist` → `allowlist` → `per-tx cap` → `per-day cap` (from audit log) → `rate limit`. Read-only tools bypass. |
| 📜 **Audit log** | Append-only JSONL at `~/.n-payment/audit.log` (mode 0600, rotated at 5 MiB). Secret-shaped keys (`privateKey`, `passphrase`, `seed`, `bearer`, `api_key`, …) are redacted before write. |
| 🛡️ **Bearer-token MCP HTTP** | `POST /mcp` requires `Authorization: Bearer <~/.n-payment/mcp.token>`. Fails closed (503) when no token is configured; 401 on missing/wrong. |
| 🚫 **Mainnet guard** | Policy mode `bypass` is refused on `*-mainnet` chains. Default chain caps (e.g. `base-mainnet`) are 100k micros (~$0.10) per tx until you raise them. |
| 🩹 **Migrates v1 in place** | Re-run `n-payment-skill setup` and any v1 plaintext keystore is encrypted in place; the original is preserved as `default.json.legacy` until you run `wallet purge-legacy`. |
| 📦 **Supply chain proof** | npm artifact is published with `--provenance` via GitHub Actions; verifiable through Sigstore + the public transparency log. |

```bash
n-payment-skill unlock                       # decrypt + cache (prompts)
n-payment-skill policy show                  # current policy
n-payment-skill policy set global.maxPerTxMicros 200000
n-payment-skill audit tail -n 20             # last 20 signed/denied calls
n-payment-skill mcp token                    # print the bearer token
n-payment-skill wallet migrate               # v1 plaintext → v3 keystore
n-payment-skill wallet purge-legacy          # delete the .legacy backup
```

Opting into mainnet:

```bash
n-payment-skill config set testnetMode false    # also flips policy.mode
n-payment-skill policy set chains.base-mainnet.maxPerTxMicros 1000000
```

---

## 🤖 Works With Every Agent Host

| Host | Auto-install | Transport |
|---|:---:|---|
| 🟣 Claude Code | ✅ | filesystem skill |
| 🟢 Kiro | ✅ | filesystem skill |
| 🔷 Cursor | ✅ | MCP (stdio) |
| 🌊 Windsurf | ✅ | MCP (stdio) |
| 🔁 Continue | ✅ | MCP (stdio) |
| ✨ Gemini CLI | ✅ | extension + MCP |
| 🐙 GitHub Copilot | ✅ | project rules |
| 💬 ChatGPT custom GPT | 📋 paste | OpenAPI Action |
| 🤖 OpenAI Assistants | 📋 paste | `tools.json` export |
| 🦙 LlamaIndex (JS / Python) | 📋 paste | function-tool export |
| 🐍 Any Python agent | 📋 15 lines | MCP `stdio` subprocess |

Generic MCP works too:

```bash
n-payment-skill mcp --http --port 8081   # POST /mcp, GET /health
```

Need paste-ready bindings? `n-payment-skill export openai | chatgpt-gpt | langchain | llamaindex`.

---

## ⚙️ Configuration

```bash
# View / change settings
n-payment-skill config get defaultChain
n-payment-skill config set defaultChain base-sepolia
n-payment-skill config set testnetMode false   # opt into mainnet
n-payment-skill config set telemetry off       # default
```

| Key | Default | Notes |
|---|---|---|
| `defaultWallet` | `default` | Wallet name under `~/.n-payment/wallets/`. |
| `defaultChain` | `goat-testnet` | Sane testnet default. Many chains supported (EVM, XRPL, Stellar, Solana, Cosmos). |
| `testnetMode` | `true` | Refuses mainnet sends until you flip it. |
| `telemetry` | `off` | Opt in with `community` or `anonymous`. |

> 🔧 Per-feature credentials (off-ramp, residential proxy, bridges, etc.) live in env vars. Run `n-payment-skill tools list` or read [`SKILL.md`](./SKILL.md) for the full list — the skill always raises a friendly, fix-it-now error when a key is missing.

---

## 🛟 Troubleshooting

| Symptom | Fix |
|---|---|
| `n-payment is not installed` | `npm i n-payment` |
| `MAINNET_GUARD` | `n-payment-skill config set testnetMode false` |
| `INSUFFICIENT_FUNDS` | `n-payment-skill faucet --chain base-sepolia` |
| `INSUFFICIENT_GAS` (Base Sepolia) | Drip ~0.001 ETH at https://www.alchemy.com/faucets/base-sepolia |
| `RPC unreachable` | Check internet / proxy, then `n-payment-skill doctor` |
| Cursor / Windsurf doesn't see tools | Restart the IDE after install |
| `npm i -g` permission denied | Use `sudo`, or set a user-writable `npm prefix` |

Run `n-payment-skill doctor` any time for a colored health report.

---

## 🛠️ For Builders

```
payment-skill/
├── SKILL.md         # canonical agent skill (auto-rendered with live tool list)
├── src/
│   ├── tools.ts     # single source of truth — 39 tools
│   ├── handlers.ts  # imperative implementations
│   ├── wallet.ts    # OWS keyfile store (0600)
│   ├── config.ts    # ~/.n-payment/config.json
│   ├── hosts.ts     # declarative host registry
│   ├── mcp.ts       # MCP stdio + HTTP transport
│   ├── exports.ts   # paste-ready OpenAI / ChatGPT / LlamaIndex
│   └── cli.ts       # commander-based CLI
└── test/            # 127 vitest tests
```

**Add a tool** — one entry in `src/tools.ts`, one handler in `src/handlers.ts`. Every host picks it up automatically (SKILL.md, MCP, OpenAI, LlamaIndex, ChatGPT).

**Add a host** — one `HostDefinition` in `src/hosts.ts` + one smoke test.

```bash
git clone https://github.com/phamdat721101/payment-skill && cd payment-skill
npm install
npm test          # 127 tests
npm run build
```

PRs welcome.

---

<div align="center">

**[📖 Docs](./docs)** · **[🛡️ Security](#-ows-wallet--local-secure-multi-chain)** · **[💬 Issues](https://github.com/phamdat721101/payment-skill/issues)**

MIT · Built for the agentic economy.

</div>
