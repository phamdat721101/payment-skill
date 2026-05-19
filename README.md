# n-payment-skill

> One-line install web3 payment skill for every mainstream AI agent.
> Pay HTTP 402 endpoints, monetize APIs, off-ramp USDC, manage agent
> identity, delegate budgets across agents — through the
> [`n-payment`](https://www.npmjs.com/package/n-payment) SDK.

[![npm](https://img.shields.io/npm/v/n-payment-skill?logo=npm)](https://www.npmjs.com/package/n-payment-skill)
[![license](https://img.shields.io/github/license/phamdat721101/payment-skill)](./LICENSE)

```bash
# One line. Detects your AI host, drops the skill, generates a wallet,
# funds testnet, runs doctor — every machine gets the same outcome.
npx n-payment-skill
```

📖 **3-minute walkthrough:** [docs/article.md](./docs/article.md) — build a paid endpoint and pay it from another script in one prompt.

---

## What you get

23 tools, exposed identically to **Claude Code, Kiro, Gemini CLI, Cursor,
Windsurf, Continue, GitHub Copilot, generic MCP, OpenAI / ChatGPT,
LangChain, and LlamaIndex** — Node-native, with a 15-line Python snippet
for the rest (no separate Python package needed).

| # | Tool | Purpose |
|---|------|---------|
| 1 | `pay` | Pay any HTTP 402 URL (auto x402 / MPP / GOAT). |
| 2 | `check_balance` | USDC + native balance on a chain. |
| 3 | `create_paywall` | Generate Express middleware to monetize endpoints. |
| 4 | `list_provider_tools` | Fetch a provider's `/.well-known/tools`. |
| 5 | `discover` | Search the bazaar for paid services. |
| 6 | `select_provider` | Reputation-weighted routing. |
| 7 | `negotiate` | Recommend direct / escrow / credit terms. |
| 8 | `create_session` | Open a micropayment session. |
| 9 | `create_escrow` | ERC-8183 lock funds for high-value tasks. |
| 10 | `delegate_budget` | Multi-agent budget chain (root → child → spend). |
| 11 | `generate_qr` | ERC-681 USDC payment URI. |
| 12 | `off_ramp` | Convert USDC to fiat (MoonPay / Transak). |
| 13 | `btc_lend` | Lock BTC, borrow USDC on GOAT Network. |
| 14 | `register_identity` | Register agent on ERC-8004 IdentityRegistry. |
| 15 | `get_reputation` | Read on-chain reputation summary. |
| 16 | `give_feedback` | Submit ERC-8004 feedback (1–5). |
| 17 | `batch_settle` | Aggregate vouchers into one settlement tx. |
| 18 | `stream_pay` | Per-second streaming USDC payments. |
| 19 | `ap2_mandate` | Sign / verify AP2 mandates and intents. |
| 20 | `policy_check` | Evaluate sends against the PolicyEngine. |
| 21 | `morph_reference_key` | Attach / query a Morph Reference Key (merchant order ID linked on-chain). |
| 22 | `morph_altfee_pay` | STUB: pay gas in USDC / USDT0 / BGB on Morph (awaiting SDK upstream). |
| 23 | `morph_passkey_pay` | STUB: passwordless WebAuthn payment on Morph (awaiting SDK upstream). |

### Host coverage

| Host | Auto-install | Transport | Where it writes |
|------|:---:|------|------|
| Claude Code | ✅ | filesystem skill | `~/.claude/skills/n-payment/` |
| Kiro | ✅ | filesystem skill | `~/.kiro/skills/n-payment/` |
| Gemini CLI | ✅ | extension + MCP | `~/.gemini/extensions/n-payment/` |
| Cursor | ✅ | MCP stdio | `~/.cursor/mcp.json` |
| Windsurf | ✅ | MCP stdio | `~/.codeium/windsurf/mcp_config.json` |
| Continue | ✅ | MCP stdio | `~/.continue/config.json` |
| GitHub Copilot | ✅ | project rules | `.github/copilot-instructions.md` |
| Generic MCP (HTTP) | ✅ | HTTP `/mcp` | Run `n-payment-skill mcp --http` |
| ChatGPT custom GPT | 📋 paste | OpenAPI Action | `n-payment-skill export chatgpt-gpt` |
| OpenAI Assistants | 📋 paste | tools.json | `n-payment-skill export openai` |
| LangChain JS | 📋 paste | DynamicStructuredTool | `n-payment-skill export langchain` |
| LlamaIndex JS | 📋 paste | tool() | `n-payment-skill export llamaindex` |
| LangChain Python | 📋 paste | 15-line subprocess snippet | See [Use from Python](#use-from-python) |
| LlamaIndex Python | 📋 paste | 15-line subprocess snippet | See [Use from Python](#use-from-python) |

---

## Install in one line

Pick whichever your environment prefers — they produce the same outcome.

### npx (any machine with Node ≥ 18)

```bash
npx n-payment-skill                # auto-detects every supported host
npx n-payment-skill --target cursor  # only wire Cursor
```

### curl | sh

```bash
curl -fsSL https://n-payment.dev/install.sh | sh
```

### Paste-to-agent

Paste this single line into your AI chat:

> Run `npx n-payment-skill` to install the n-payment web3 payment skill.
> It gives you 20 tools for paying APIs, accepting payments, off-ramping
> USDC, generating QR codes, and delegating budgets to sub-agents.

The agent will run the command and confirm the host, wallet, and faucet.

### Python

No separate package — Python users call the Node MCP server with a 15-line
snippet. See [Use from Python](#use-from-python).

---

## Install without publishing

You don't need to push to npm or PyPI. Every install path below works against
a fresh GitHub repo, a tarball, or a local checkout.

### From GitHub (no npm publish required)

```bash
# One-shot run — npm clones the repo, runs `prepare` to compile dist/, then runs the bin.
npx github:phamdat721101/payment-skill

# Persistent global install (same idea, just stays installed).
npm install -g github:phamdat721101/payment-skill

# Pin to a branch, tag, or commit:
npm install -g github:phamdat721101/payment-skill#main
npm install -g github:phamdat721101/payment-skill#v1.0.0
npm install -g github:phamdat721101/payment-skill#a1b2c3d
```

### From a tarball (offline / private mirror)

```bash
git clone https://github.com/phamdat721101/payment-skill && cd n-payment-skill
npm install && npm pack                     # produces n-payment-skill-1.0.0.tgz
npm install -g ./n-payment-skill-1.0.0.tgz   # ship that file anywhere
```

### From a local checkout (development)

```bash
git clone https://github.com/phamdat721101/payment-skill
cd n-payment-skill && npm install
npm install -g .                             # global "n-payment-skill" bin points at this checkout
# …or just run the un-installed bin:
node dist/cli.js setup
```

### Curl | sh against any of the above

```bash
# Default — npm registry:
curl -fsSL https://n-payment.dev/install.sh | sh

# GitHub (no publish):
curl -fsSL https://raw.githubusercontent.com/phamdat721101/payment-skill/main/install.sh \
  | sh -s -- --from-git phamdat721101/payment-skill

# Pinned ref:
curl -fsSL …/install.sh | sh -s -- --from-git phamdat721101/payment-skill#main

# Tarball URL (e.g., a GitHub release asset):
curl -fsSL …/install.sh | sh -s -- --from-tarball https://github.com/phamdat721101/payment-skill/releases/download/v1.0.0/n-payment-skill-1.0.0.tgz

# Local directory (already-cloned repo):
curl -fsSL …/install.sh | sh -s -- --from-path /Users/me/work/n-payment-skill
```

### Python without PyPI

There is no separate Python package — Python users call the Node MCP server
over stdio. See [Use from Python](#use-from-python) for the 15-line snippet.

> Note on the `n-payment` SDK peer dependency: it is declared `optional`, so
> install never fails when the SDK is not on the registry yet. Tools that
> need the SDK (e.g. `pay`, `register_identity`) raise a friendly error at
> call time. If you also have `n-payment` only on GitHub, install both:
>
> ```bash
> npm install -g github:phamdat721101/n-payment github:phamdat721101/payment-skill
> ```

---

## Quickstart (3 minutes)

```bash
# 1. install
npx n-payment-skill
# ...  ✓ claude (1 file)
# ...  ✓ wallet ready: 0xabc…
# ...  ✓ faucet: Circle faucet dripped 10 USDC to … on Base Sepolia.

# 2. tell your AI agent
> "pay for https://x402-demo.example/data on base-sepolia"
# agent: { status: 200, body: "{...}" }

# 3. monetize your own endpoint
> "create paywall for /forecast at 0.05 USDC on base-sepolia"
# agent pastes ready-made Express middleware.

# 4. switch to mainnet (opt-in)
n-payment-skill config set testnetMode false
export GOAT_API_KEY=… GOAT_API_SECRET=… GOAT_MERCHANT_ID=…
```

---

## How it works

```mermaid
flowchart LR
    user[("User\nin AI chat")] -->|"pay for X"| host
    host{{"AI host\n(Claude / Kiro / Cursor / Gemini / …)"}} -->|MCP stdio<br/>tools/call| binary
    binary[["n-payment-skill CLI\n(Node, single binary)"]] --> tools
    tools["20 tool handlers"] --> sdk
    sdk[("n-payment SDK\nx402 / MPP / GOAT / Stellar / XRPL / Solana")] --> chain[("Chain RPCs\nUSDC contracts")]
    binary --> wallet[(["~/.n-payment/wallets/default.json\n(0600)"])]
```

**Single source of truth.** A declarative `TOOLS` array in
[`src/tools.ts`](./src/tools.ts) drives:

- the SKILL.md tool table,
- the MCP `tools/list` and `tools/call` handlers,
- the OpenAI / Anthropic function-call schema,
- the LangChain & LlamaIndex JS adapters (auto-exported),
- the ChatGPT custom-GPT OpenAPI manifest,
- and (via MCP stdio) any Python / Go / Rust client.

Adding a tool is **one new entry** — every host gets it automatically.

```mermaid
flowchart TB
    A["src/tools.ts (TOOLS)"] --> B[SKILL.md]
    A --> C["MCP /tools (stdio + HTTP)"]
    A --> D[tools.json]
    A --> E[LangChain JS]
    A --> F[LlamaIndex JS]
    A --> G[ChatGPT OpenAPI]
    C --> H["Python / Go / Rust\n(any MCP stdio client)"]
```

---

## Per-host guides

### Claude Code & Kiro (filesystem skill)

```bash
npx n-payment-skill --target claude   # or --target kiro
```

Writes `~/.claude/skills/n-payment/SKILL.md` (or `~/.kiro/...`). Open
Claude Code in any project; tell it "pay for https://x402-demo.example".
The skill auto-activates via the trigger phrases in the YAML frontmatter.

### Cursor / Windsurf / Continue (MCP stdio)

```bash
npx n-payment-skill --target cursor       # or windsurf / continue
```

Adds an `mcpServers.n-payment` entry to the host's MCP config without
disturbing existing servers. Restart the host; the 20 tools appear under
the **n-payment** server.

### Gemini CLI (extension)

```bash
npx n-payment-skill --target gemini
gemini "send 0.1 USDC to vitalik.eth on base-sepolia"
```

Drops `~/.gemini/extensions/n-payment/{gemini-extension.json,GEMINI.md}`.

### GitHub Copilot (project rules)

```bash
cd /path/to/your/repo
npx n-payment-skill --target copilot
```

Appends a managed block to `.github/copilot-instructions.md`. Copilot Chat
will then suggest n-payment SDK code when the conversation calls for it.

### Generic MCP HTTP (Docker, hosted)

```bash
docker run -p 8081:8081 \
  -v ~/.n-payment:/root/.n-payment \
  ghcr.io/phamdat721101/payment-skill:latest

# → POST http://host:8081/mcp { "jsonrpc": "2.0", "method": "tools/list" }
# → GET  http://host:8081/health
```

### ChatGPT custom GPT

```bash
# 1. Run the MCP HTTP server (Docker above, or `n-payment-skill mcp --http`).
# 2. Generate an OpenAPI spec pointing at it:
n-payment-skill export chatgpt-gpt --server-url https://your-host/mcp \
  > custom-gpt.json

# 3. In ChatGPT → Build a GPT → Actions → Import → upload custom-gpt.json.
```

### OpenAI Assistants / function calling

```bash
n-payment-skill export openai > tools.json
```

```ts
import OpenAI from 'openai';
import tools from './tools.json' assert { type: 'json' };

const openai = new OpenAI();
const run = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'pay for https://x402-demo.example/data' }],
  tools,
});
```

### LangChain JS

```bash
n-payment-skill export langchain > n-payment-tools.ts
```

The generated file exports `nPaymentTools` (an array of
`DynamicStructuredTool`s) that you bind to your model.

### LlamaIndex.TS

```bash
n-payment-skill export llamaindex > n-payment-tools.ts
```

### Use from Python

No `pip install` package — `n-payment-skill` ships only as the Node binary.
Python users call its MCP stdio server directly. **15 lines, zero deps:**

```python
import atexit, json, subprocess

_proc = subprocess.Popen(
    ["n-payment-skill", "mcp", "--stdio"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1,
)
atexit.register(_proc.terminate)
_id = 0

def call(method, params=None):
    global _id; _id += 1
    _proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": _id, "method": method,
                                  "params": params or {}}) + "\n")
    _proc.stdin.flush()
    return json.loads(_proc.stdout.readline())

call("initialize")
tools = call("tools/list")["result"]["tools"]               # all 20 tools
print(call("tools/call",
           {"name": "negotiate",
            "arguments": {"price_micros": 10_000, "caller_reputation": 95}}))
```

**LangChain** (build a `BaseTool` from each entry of `tools`):

```python
from langchain_core.tools import BaseTool
def make_tool(t):
    class _T(BaseTool):
        name = t["name"]; description = t["description"]
        def _run(self, **kwargs):
            return call("tools/call", {"name": self.name, "arguments": kwargs})
    return _T()
lc_tools = [make_tool(t) for t in tools]
```

**LlamaIndex** (build a `FunctionTool` per entry):

```python
from llama_index.core.tools import FunctionTool
def make_tool(t):
    return FunctionTool.from_defaults(
        fn=lambda **kw: call("tools/call", {"name": t["name"], "arguments": kw}),
        name=t["name"], description=t["description"],
    )
li_tools = [make_tool(t) for t in tools]
```

Schema parity is automatic — adding a tool to `src/tools.ts` makes it
available in Python on the next process start, no Python-side changes.

---

## Configuration

```bash
n-payment-skill config get defaultChain          # → goat-testnet
n-payment-skill config set defaultChain base-sepolia
n-payment-skill config set testnetMode false     # opt into mainnet
n-payment-skill config set telemetry off         # default
```

| Key | Default | Notes |
|---|---|---|
| `defaultWallet` | `default` | Wallet name under `~/.n-payment/wallets/` |
| `defaultChain` | `goat-testnet` | Any of the 13 supported `ChainKey`s |
| `testnetMode` | `true` | `pay` refuses mainnet sends until you set this to `false` |
| `telemetry` | `off` | Opt in: `community` or `anonymous` |

| Env var | Used by | Purpose |
|---|---|---|
| `GOAT_API_KEY` / `GOAT_API_SECRET` / `GOAT_MERCHANT_ID` | `pay` (GOAT chains) | x402 facilitator credentials |
| `MORPH_ACCESS_KEY` / `MORPH_ACCESS_SECRET` | `pay` (Morph chains) | HMAC credentials for the Morph x402 Facilitator (register at https://morph-rails.morph.network/x402) |
| `STELLAR_SECRET_KEY` | `pay` / `check_balance` (Stellar chains) | Stellar `S…` secret key. If unset, derived deterministically from the existing wallet file. |
| `STELLAR_OZ_API_KEY` | `pay` (Stellar mainnet) | OpenZeppelin Relayer x402 API key (generate at https://channels.openzeppelin.com/gen). Testnet uses Coinbase free facilitator. |
| `NPAYMENT_ESCROW_CONTRACT` | `create_escrow` | ERC-8183 contract address |
| `NPAYMENT_BTC_VAULT` | `btc_lend` | BTC vault contract (GOAT Network) |

---

## Wallet & security

- The wallet is generated on first run via viem's `generatePrivateKey()`
  and stored at `~/.n-payment/wallets/default.json` with mode **0600**.
- The directory is mode **0700**; `wallet show` only ever prints the
  address — the private key is never echoed.
- `pay` and `off_ramp` refuse mainnet chains while `testnetMode=true`.
- HTTP responses are wrapped as **untrusted external content** in the
  SKILL.md guard so the agent never executes instructions embedded in API
  payloads.
- All install writes are **idempotent** — re-running `npx
  n-payment-skill` upgrades the skill without duplicating config.

---

## Architecture

```
payment-skill/
├── SKILL.md              # canonical Gstack-style skill (placeholder for tools)
├── install.sh            # POSIX one-liner installer
├── Dockerfile            # MCP HTTP server image
├── package.json
├── src/
│   ├── cli.ts            # commander-based CLI (setup default, install, mcp, …)
│   ├── tools.ts          # SINGLE source of truth: 20 tool defs + types
│   ├── handlers.ts       # 20 handler implementations (n-payment SDK)
│   ├── schema.ts         # zod → JSON Schema / OpenAI fn-call
│   ├── exports.ts        # paste-ready exports (chatgpt-gpt, langchain, …)
│   ├── mcp.ts            # transport-agnostic dispatcher + stdio + HTTP
│   ├── hosts.ts          # declarative host registry + installHosts()
│   ├── skill.ts          # SKILL.md renderer (injects tools)
│   ├── wallet.ts         # ~/.n-payment/wallets/<name>.json (chmod 0600)
│   ├── config.ts         # ~/.n-payment/config.json
│   ├── faucet.ts         # CHAIN_META + Circle/Tempo faucet + doctor
│   └── index.ts
└── test/                 # 92 vitest tests (tools, schema, wallet, faucet,
                          #   skill, mcp, hosts, exports, morph, stellar)
```

---

## Troubleshooting

| Error | Likely fix |
|---|---|
| `n-payment is not installed` | `npm i n-payment` (peer dep) |
| `MAINNET_GUARD` | `n-payment-skill config set testnetMode false` |
| `GOAT_CREDS_MISSING` | `export GOAT_API_KEY=… GOAT_API_SECRET=… GOAT_MERCHANT_ID=…` |
| `MORPH_CREDS_MISSING` | `export MORPH_ACCESS_KEY=… MORPH_ACCESS_SECRET=…` (register at https://morph-rails.morph.network/x402) |
| `MORPH_AUTH` | Re-check key/secret + clock skew (timestamp must be within ±30s of server) |
| `MORPH_RATE_LIMITED` | Exceeded 10 QPS per Access Key; backoff and retry |
| `REFERENCE_KEY_NOT_FOUND` | Reference Key launches with Morph mainnet (April 2026); 404 expected on Hoodi |
| `STELLAR_OZ_KEY_MISSING` | Stellar mainnet needs `STELLAR_OZ_API_KEY`. Generate at https://channels.openzeppelin.com/gen |
| `INSUFFICIENT_FUNDS` | `n-payment-skill faucet --chain base-sepolia` |
| `RPC unreachable` | Check internet / corporate proxy; retry `n-payment-skill doctor` |
| `Circle faucet 429` | Rate-limited; visit `https://faucet.circle.com` and drip manually |
| `ESCROW_CONFIG_MISSING` | `export NPAYMENT_ESCROW_CONTRACT=0x…` |
| Cursor / Windsurf doesn't see the tools | Restart the IDE after install |
| `npm i -g` permission denied | Run with `sudo` or set a user-writable `npm prefix` |

Run `n-payment-skill doctor` any time for a colored health report.

---

## Development

```bash
git clone https://github.com/phamdat721101/payment-skill
cd n-payment-skill
npm install
npm test          # 92 tests
npm run build
node dist/cli.js --version
```

Tests live in `test/` and cover the registry, schema converters, wallet
store, config, faucet, MCP dispatcher (stdio + HTTP), host installers,
skill renderer, and exports.

---

## Contributing

Adding a new tool:

1. Add an entry to `TOOLS` in [`src/tools.ts`](./src/tools.ts).
2. Add the handler implementation to `src/handlers.ts`.
3. `npm test` — the tool count assertion will catch missing handlers.
4. Run `n-payment-skill skill render` to confirm SKILL.md updates.

Adding a new host:

1. Append a `HostDefinition` to `HOSTS` in [`src/hosts.ts`](./src/hosts.ts)
   with `id`, `name`, `scope`, `detect`, `apply`.
2. Add a smoke test in [`test/hosts.test.ts`](./test/hosts.test.ts).

PRs welcome.

---

## License

[MIT](./LICENSE)
