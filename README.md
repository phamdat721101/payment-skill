<div align="center">

# 💸 Payment Agent-Skill

### **A single skill that gives any AI agent the ability to pay, get paid, and move money across chains.**

*One install. One wallet. Every host. Every chain the SDK speaks.*

[![npm](https://img.shields.io/npm/v/n-payment-skill?logo=npm&color=cb3837)](https://www.npmjs.com/package/n-payment-skill)
[![hosts](https://img.shields.io/badge/works%20with-7%20AI%20hosts-blue)](#-works-with-every-agent-host)
[![license](https://img.shields.io/github/license/phamdat721101/payment-skill)](./LICENSE)

```bash
npx -y github:phamdat721101/payment-skill
```

</div>

---

## 🧭 What is a payment agent-skill?

A **payment agent-skill** is a small, self-installing package that turns any AI host (Claude Code, Kiro, Cursor, Windsurf, Continue, Gemini CLI, Copilot) into an economic actor. The host doesn't learn a new API. The user asks in plain English. The skill picks the right on-chain rail, signs the right transaction, and hands the result back to the agent.

Three properties define the shape:

- 🧩 **One skill, many hosts.** The same install produces MCP tools, function-call schemas, and OpenAPI actions — so the exact same 48 tools work under every host without per-host glue.
- 🔐 **One wallet, many chains.** A single encrypted keyfile derives usable keypairs across EVM, XRPL, Stellar, Solana, Cosmos, and BTC-L2 chains.
- 🛡️ **One policy engine, every call.** Every signing path passes through unlock → denylist → allowlist → per-tx cap → per-day cap → rate limit. No side doors.

This repo is the reference implementation.

---

## ✨ What it does

The skill exposes 48 tools an agent can call. Grouped by intent:

- 💸 **Pay any URL** — auto-detects x402 / MPP / GOAT paywalls, handles the 402 challenge, signs, retries, returns the response body.
- 🏪 **Monetize an endpoint** — generates ready-to-paste Express middleware so any HTTP endpoint becomes a paid tool other agents can consume.
- 🔎 **Discover services** — searches the bazaar, ranks providers by reputation-weighted routing, negotiates payment terms.
- 📈 **Earn yield on idle stablecoins** — supplies USDC into a battle-tested money market and returns the receipt token. Withdraw any time.
- 🔬 **Research DeFi positions and markets** — read-only Aave/XRPL-vault position snapshots and Morpho/Pendle market comparisons (APY, TVL, utilization, LTV, health factor). Pure reads, never signs.
- 🌍 **Cash out to fiat** — MoneyGram retail pickup at ~500 000 locations across 174 countries via Stellar SEP-24; SEP-31 for agent-to-agent fiat payouts.
- 🔁 **Bridge across chains** — XRP → FXRP on Flare, FXRP → RLUSD on XRPL/EVM, USDC → iUSD on Initia, BTC → USDC on GOAT.
- 🪪 **On-chain identity + reputation** — register on ERC-8004, give and read feedback, delegate multi-agent budgets.
- 🧾 **Universal QR** — generate ERC-681 (EVM) or SEP-7 (Stellar) payment URIs scannable by any wallet.

Run `n-payment-skill tools list` for the full catalog. Run `n-payment-skill tools schema <name>` to inspect the input contract.

---

## 🚀 Install

One command:

```bash
npx -y github:phamdat721101/payment-skill
```

What that does:

- 🧩 Detects your host and wires the skill into place.
- 🔐 Creates an encrypted local wallet at `~/.n-payment/wallets/default.json` (chmod 0600, Web3 Secret Storage v3).
- 💧 Drips testnet funds so you can try every flow without spending real money.
- 🩺 Runs a doctor check and prints the next prompt to try.
- 🔁 Idempotent — re-run any time to upgrade in place.

---

## 🎯 Prompts to try

Open your agent and paste. The skill picks the right tool.

- *"Pay for https://x402-demo.example/data"* → `pay`
- *"Create a paywall for /forecast at 0.05 USDC on base-sepolia"* → `create_paywall`
- *"Earn yield on my idle USDC"* → `aave_yield`
- *"Cash out 20 USDC to USD through MoneyGram on Stellar testnet"* → `stellar_off_ramp`
- *"Open a Stellar payment session with 1 USDC to G…"* → `stellar_session`
- *"Register my agent identity on ERC-8004"* → `register_identity`
- *"Bridge 10 XRP to FXRP on Flare"* → `xrpl_to_fxrp_bridge`

Full walkthroughs live in [`docs/`](./docs).

---

## 🌍 Payment rails supported

The SDK speaks many rails. The skill exposes them behind chain-agnostic tools so the agent picks the rail per request:

- 🟣 **EVM x402** — Base, Arbitrum, Ethereum, Optimism, Ink, Unichain, Morph, BNB, Creditcoin
- 🔵 **Stellar rails** — x402 + MPP on Soroban; MoneyGram SEP-24/31/38 off-ramp; SEP-7 QR
- 🔷 **XRPL** — RLUSD payments, native vaults, DIA oracle, trust lines
- 🟠 **GOAT Network** — BTC-collateralized USDC; BTC-lending; native swap router
- 🟢 **Solana** — SPL USDC (via SDK)
- 🟡 **Cosmos / Initia** — iUSD bridge via Skip API
- 🔴 **Flare** — FAssets bridge (XRP ↔ FXRP), Smart Accounts
- 🌊 **SpaceRouter (Creditcoin)** — residential-proxy payments in SPACE

Each rail has an explicit testnet chain-key (`*-testnet`, `*-sepolia`, `*-devnet`, `*-coston2`, `*-hoodi`) and a mainnet chain-key. The skill defaults to testnet until you opt into mainnet.

---

## 🔐 Security posture

Every property is enforced in code, not documentation:

- 🔒 **Encrypted at rest** — keys live in Web3 Secret Storage v3 (`scrypt` + AES-128-CTR + Keccak MAC). Interop with viem, ethers, geth, hardware-wallet imports.
- 🔓 **Session unlock** — `n-payment-skill unlock` decrypts once per session; cache auto-evicts after `policy.unlockTtlSeconds` (30 min default). Private key never touches disk again.
- 🛂 **Policy-gated dispatcher** — every signing call passes through one guard chain: unlock → denylist → allowlist → per-tx cap → per-day cap → rate limit. Read-only tools bypass.
- 📜 **Audit log** — append-only JSONL at `~/.n-payment/audit.log` (0600, rotated at 5 MiB). Secret-shaped keys (`privateKey`, `passphrase`, `seed`, `bearer`, `api_key`) are redacted before write.
- 🛡️ **Bearer-token MCP HTTP** — `POST /mcp` requires `Authorization: Bearer <~/.n-payment/mcp.token>`. Fails closed (503) with no token; 401 with wrong token.
- 🚫 **Mainnet guard** — policy mode `bypass` refused on `*-mainnet`. Default chain caps (e.g. `base-mainnet`) are 100 k micros (~$0.10) per tx until raised.
- 🩹 **Legacy migration** — re-running `setup` encrypts any v1 plaintext keystore in place. The original is preserved as `.legacy` until `wallet purge-legacy`.
- 📦 **Provenance** — npm artifact published with `--provenance` via GitHub Actions; verifiable through Sigstore and the public transparency log.

Common CLI:

```bash
n-payment-skill unlock                       # decrypt + cache (prompts)
n-payment-skill policy show                  # current policy
n-payment-skill policy set global.maxPerTxMicros 200000
n-payment-skill audit tail -n 20             # last 20 signed / denied calls
n-payment-skill mcp token                    # print the bearer token
n-payment-skill wallet migrate               # v1 plaintext → v3 keystore
```

Opting into mainnet:

```bash
n-payment-skill config set testnetMode false                     # also flips policy.mode
n-payment-skill policy set chains.base-mainnet.maxPerTxMicros 1000000
```

---

## 🤖 Host compatibility

Auto-installed:

- 🟣 Claude Code — filesystem skill
- 🟢 Kiro — filesystem skill
- 🔷 Cursor — MCP (stdio)
- 🌊 Windsurf — MCP (stdio)
- 🔁 Continue — MCP (stdio)
- ✨ Gemini CLI — extension + MCP
- 🐙 GitHub Copilot — project rules

Paste-ready:

- 💬 ChatGPT custom GPT — OpenAPI action
- 🤖 OpenAI Assistants — `tools.json` export
- 🦙 LlamaIndex (JS / Python) — function-tool export
- 🐍 Any Python agent — 15-line MCP stdio subprocess

Generic MCP server:

```bash
n-payment-skill mcp --http --port 8081   # POST /mcp, GET /health
```

Bindings:

```bash
n-payment-skill export openai | chatgpt-gpt | langchain | llamaindex
```

---

## ⚙️ Configuration

Configuration lives in `~/.n-payment/config.json`. Change via CLI:

```bash
n-payment-skill config get defaultChain
n-payment-skill config set defaultChain base-sepolia
n-payment-skill config set testnetMode false   # opt into mainnet
n-payment-skill config set telemetry off       # default
```

Core keys:

- `defaultWallet` — wallet name under `~/.n-payment/wallets/`. Default `default`.
- `defaultChain` — sane testnet default. Every rail supported.
- `testnetMode` — refuses mainnet sends until flipped. Default `true`.
- `telemetry` — opt in with `community` or `anonymous`. Default `off`.

Per-feature credentials (off-ramp, residential proxy, bridges, MoneyGram anchor host) live in env vars. `n-payment-skill tools list` and [`SKILL.md`](./SKILL.md) enumerate every required var — the skill always raises a friendly, fix-it-now error when one is missing.

---

## 🛟 Troubleshooting

Every failure returns `{ ok: false, code, hint }`. Common codes:

- `MAINNET_GUARD` — `n-payment-skill config set testnetMode false`
- `INSUFFICIENT_FUNDS` — `n-payment-skill faucet --chain <chain>`
- `INSUFFICIENT_GAS` (Base Sepolia) — drip ~0.001 ETH at https://www.alchemy.com/faucets/base-sepolia
- `RPC unreachable` — check internet / proxy, then `n-payment-skill doctor`
- `OFFRAMP_NO_ANCHOR` (Stellar) — testnet auto-registers SDF's `testanchor.stellar.org`; mainnet needs `STELLAR_ANCHOR_MONEYGRAM_COM_TOML_URL` (allowlisted MoneyGram Preview host)
- `STELLAR_OZ_KEY_MISSING` — generate at https://channels.openzeppelin.com/gen; `export STELLAR_OZ_API_KEY=…`
- `LOCKED` — `n-payment-skill unlock` (session cache is cold)
- Cursor / Windsurf doesn't see tools — restart the IDE after install
- `npm i -g` permission denied — use `sudo`, or set a user-writable `npm prefix`

`n-payment-skill doctor` runs a colored health report on demand.

---

## 🛠️ Building on top

Layout of a payment agent-skill:

```
payment-skill/
├── SKILL.md         # canonical agent skill (auto-rendered with live tool list)
├── src/
│   ├── tools.ts     # single source of truth — 48 tools (declarative)
│   ├── handlers.ts  # imperative implementations
│   ├── wallet.ts    # encrypted keyfile store
│   ├── config.ts    # ~/.n-payment/config.json
│   ├── hosts.ts     # declarative host registry
│   ├── mcp.ts       # MCP stdio + HTTP transport
│   ├── exports.ts   # paste-ready OpenAI / ChatGPT / LangChain / LlamaIndex
│   └── cli.ts       # commander-based CLI
└── test/            # 277 vitest tests
```

Extending the surface:

- **Add a tool** — one entry in `src/tools.ts`, one handler in `src/handlers.ts`. Every host picks it up (SKILL.md, MCP, OpenAI, LlamaIndex, ChatGPT) via the shared declarative registry.
- **Add a host** — one `HostDefinition` in `src/hosts.ts` plus one smoke test.
- **Add a rail** — one adapter that satisfies the SDK's payment-client interface; register the chain key in `src/faucet.ts` `CHAIN_META`.

```bash
git clone https://github.com/phamdat721101/payment-skill && cd payment-skill
npm install
npm test          # 277 vitest tests
npm run build     # tsup ESM + .d.ts
```

PRs welcome.

---

<div align="center">

**[📖 Docs](./docs)** · **[🛡️ Security](#-security-posture)** · **[💬 Issues](https://github.com/phamdat721101/payment-skill/issues)**

MIT · Built for the agentic economy.

</div>
