# Solana Cross-DEX Arbitrage Bot (Simulation)

A Solana cross-DEX arbitrage bot with event-driven detection, two-stage simulation, and full cost modeling. Combines the best patterns from two production codebases into a single, robust simulation-first bot.

## Architecture

```
src/
├── config/
│   ├── env.ts              Zod-validated environment config
│   └── constants.ts        Token mints, tip accounts, DEX programs, venue labels
├── market/
│   └── types.ts            Shared TypeScript interfaces
├── utils/
│   ├── logger.ts           Pino JSON logger
│   ├── retry.ts            Promise-chain rate limiter + exponential backoff
│   └── bigint.ts           BigInt USDC/bps arithmetic helpers
├── helius/
│   ├── client.ts           RPC connection + wallet loader
│   ├── priority-fee.ts     Helius getPriorityFeeEstimate
│   ├── sender.ts           Helius Sender TX submission + tip logic + PnL
│   └── stream.ts           WebSocket DEX event stream + reconnect
├── jupiter/
│   ├── client.ts           API fetch with rate limiting + retry
│   ├── quote.ts            Jupiter /swap/v2/build wrapper
│   ├── build.ts            Decode Jupiter instruction data
│   └── flashloan.ts        Jupiter Lend flash-loan adapter
├── arb/
│   ├── detector.ts         Cross-DEX arbitrage detection (2-leg + 3-leg)
│   ├── safety.ts           Pre-execution safety checks
│   ├── builder.ts          Compose atomic flash-loan arb instructions
│   └── simulate.ts         Two-stage simulation with full cost model
└── index.ts                Main loop: event-driven + poll, simulation-only
```

## Features

- **Event-driven detection**: WebSocket subscription to 6 DEX programs (Raydium AMM/CLMM, Orca Whirlpool, Meteora DLMM, Phoenix, OpenBook) with fallback polling
- **Two-stage simulation**: Stage 1 (rough CU estimate) → Stage 2 (exact TX with priority fee + tip) — ensures only fully validated transactions would be submitted
- **Full cost model**: Priority fee + base fee (5000 lamports) + Sender tip all deducted from gross profit before net profitability check
- **Configurable DEX pairs**: Scan specific venue pairs or all 16 built-in cross-DEX combinations
- **Triangular arbitrage**: 3-leg detection when no DEX pairs are configured
- **Flash loans**: Optional Jupiter Lend integration (borrow → swaps → repay, fee-free)
- **8 safety checks**: Profit, BPS, impact, size, freshness, cross-DEX validation, flash-loan compatibility
- **Event coalescing + dedup**: Prevents redundant scans and duplicate processing

## Modes

| Mode | Description |
|---|---|
| `SIMULATE` | Log-only. Simulates opportunities and logs what would happen. No execution. |
| `SHADOW` | Log-only with detailed TX info. Simulates the exact TX that would be submitted. |

> **LIVE mode is not yet enabled** — all the Sender, tip, and PnL code is built but gated behind a config check. See "Enabling Live Mode" below.

## Quick Start

```bash
# Install dependencies
bun install

# Configure API keys (copy .env.example to .env and fill in)
cp .env.example .env

# Run in simulation mode
bun run start

# Or with hot-reload during development
bun run dev
```

## Configuration

All configuration is via environment variables (`.env` file). See `.env.example` for the complete list with defaults.

### Required

| Variable | Description |
|---|---|
| `HELIUS_API_KEY` | Helius RPC endpoint + priority fees + Sender |
| `JUPITER_API_KEY` | Jupiter Swap V2 API + flash loan |

### Strategy

| Variable | Default | Description |
|---|---|---|
| `MODE` | `SIMULATE` | `SIMULATE` or `SHADOW` |
| `MAX_TRADE_USDC` | `500` | Maximum trade size in USDC |
| `MIN_PROFIT_BPS` | `10` | Minimum gross profit in basis points |
| `MIN_PROFIT_USDC` | `0.5` | Minimum gross profit in USDC |
| `DEX_PAIRS` | *(empty)* | Semicolon-separated pairs: `"RAYDIUM CLMM>Whirlpool"` |

### Execution

| Variable | Default | Description |
|---|---|---|
| `POLL_INTERVAL_MS` | `5000` | Milliseconds between scan cycles |
| `MAX_COMPUTE_UNITS` | `1400000` | Maximum CU per transaction |
| `CU_MARGIN_BPS` | `1000` | CU safety margin (10%) |
| `PRIORITY_FEE_LEVEL` | `veryHigh` | Priority fee level (min/low/medium/high/veryHigh/unsafeMax) |
| `SENDER_MODE` | `swqos` | Sender tier: `max` (0.001 SOL min tip) or `swqos` (0.000005 SOL) |
| `FLASH_LOAN_PROVIDER` | `jupiter` | Flash loan provider: `jupiter` or `none` |
| `EVENTS_ENABLED` | `true` | Enable WebSocket event stream |

## How It Works

1. **Detection** (`detector.ts`): Scans cross-DEX pairs via Jupiter /build API. For each pair, gets quote A (USDC→SOL on venue A) and quote B (SOL→USDC on venue B). Validates routes use only expected venues.

2. **Safety** (`safety.ts`): 8 pre-execution checks — profit positivity, absolute/relative thresholds, price impact caps (200 bps), trade size limits, quote freshness (10s), cross-DEX validation, flash-loan compatibility.

3. **Building** (`builder.ts`): Gets fresh quotes, extracts swap instructions, composes flash-loan borrow → swaps → repay. Resolves address lookup tables from both quotes.

4. **Simulation** (`simulate.ts`):
   - **Stage 1**: Simulate at max CU to get rough estimate
   - Build candidate TX → estimate priority fee from Helius
   - Calculate tip (5% of expected profit, clamped to min/max)
   - Full cost model: `netProfit = grossProfit - (priorityFee + baseFee + tip)`
   - **Stage 2**: Simulate exact TX with priority fee + tip included
   - Verify CU and TX size within limits

5. **Execution**: In SIMULATE/SHADOW mode, only logs results. In LIVE mode (not compiled), would submit via Helius Sender.

## Enabling Live Mode

When you're ready to go live:

1. **`src/config/env.ts`**: Change `z.enum(["SIMULATE", "SHADOW"])` to `z.enum(["SIMULATE", "SHADOW", "LIVE"])`
2. **`src/config/env.ts`**: Make `PRIVATE_KEY` required when `MODE === "LIVE"`
3. **`src/index.ts`**: Add `case "LIVE":` in `handleOpportunity`:
   ```typescript
   if (state.mode === "LIVE") {
     const sig = await sendViaSender(sim.finalTx);
     const confirmed = await confirmTransaction(sig);
     if (confirmed) {
       state.totalTrades++;
       const realized = await getTransactionPnlUsd(...);
       if (realized) state.realizedProfit += usdcToBigInt(realized);
     }
   }
   ```

All the Sender, tip, and PnL code is already built and tested in simulation.

## Safety Guarantees

- **No live execution**: `MODE` only accepts `SIMULATE` and `SHADOW` — `LIVE` is rejected at startup
- **Auto-generated keypair**: If `PRIVATE_KEY` is empty, a throwaway keypair is generated
- **Two-stage simulation**: Must pass both stages before logging as "would trade"
- **Full cost model**: Priority fee + base fee + tip all deducted from gross profit
- **8 safety checks**: Comprehensive pre-execution validation

## Running in Background

Use the provided `oxfile.toml` with OxMgr:

```bash
# Install OxMgr
cargo install oxmgr

# Start the bot
oxmgr apply ./oxfile.toml

# Check status
oxmgr list

# View logs
oxmgr logs arb-sim

# Start both arb-sim and telegram bot
oxmgr apply ./oxfile-combined.toml
```

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript (strict mode)
- **Validation**: Zod
- **Logging**: Pino (structured JSON)
- **RPC**: Helius (mainnet)
- **DEX**: Jupiter Swap V2 (/build)
- **Flash Loans**: Jupiter Lend (optional)
- **WebSocket**: Helius DEX event stream
- **Telegram**: GramIO (MarkdownV2 notifications)

## Telegram Notifications

The bot sends formatted MarkdownV2 notifications to Telegram about opportunities, simulations, and status updates. Configure via `BOT_TOKEN` and `CHAT_ID` in `.env`.

| Event | Icon | Description |
|-------|------|-------------|
| Startup | 🚀 | Bot started with configuration |
| Opportunity | 💰 | Arbitrage opportunity found |
| Simulation | 📊 | Simulation result with costs |
| Status | 📈 | Periodic status report (every 10 scans) |
| Shutdown | 🛑 | Bot stopped |

## License

Private — internal use only.
