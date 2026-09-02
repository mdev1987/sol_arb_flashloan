import { PublicKey } from "@solana/web3.js";

// ── Token mints ──────────────────────────────────────────────────────────────
export const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const USDT_MINT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
export const MSOL_MINT = new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");
export const BONK_MINT = new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
export const JUP_MINT = new PublicKey("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN");

export const SOL_MINT_STR = SOL_MINT.toBase58();
export const USDC_MINT_STR = USDC_MINT.toBase58();
export const USDT_MINT_STR = USDT_MINT.toBase58();
export const MSOL_MINT_STR = MSOL_MINT.toBase58();
export const BONK_MINT_STR = BONK_MINT.toBase58();
export const JUP_MINT_STR = JUP_MINT.toBase58();

// ── Decimals ─────────────────────────────────────────────────────────────────
export const SOL_DECIMALS = 9;
export const USDC_DECIMALS = 6;
export const USDT_DECIMALS = 6;
export const MSOL_DECIMALS = 9;
export const BONK_DECIMALS = 5;
export const JUP_DECIMALS = 6;

// ── Helius Sender tip accounts (mainnet) ─────────────────────────────────────
// Source: https://www.helius.dev/docs/sending-transactions/sender#designated-tip-accounts-mainnet-beta
export const SENDER_TIP_ACCOUNTS = [
  new PublicKey("4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE"),
  new PublicKey("D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ"),
  new PublicKey("9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta"),
  new PublicKey("5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn"),
  new PublicKey("2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD"),
  new PublicKey("2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ"),
  new PublicKey("wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF"),
  new PublicKey("3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT"),
  new PublicKey("4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey"),
  new PublicKey("4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or"),
];

// ── Helius DEX program IDs (for WebSocket event stream) ──────────────────────
export const DEX_PROGRAM_IDS: Record<string, string> = {
  RaydiumAMMv4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  RaydiumCLMM: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  OrcaWhirlpool: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  MeteoraDLMM: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  PhoenixV1: "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY",
  OpenBookV2: "opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb",
  PumpSwap: "PSwapMdSai8tjrEXcz51izXiLfcSbRhKeqkB26nWy1R",
};

// ── Exact Jupiter route labels per DEX venue ─────────────────────────────────
// Labels taken from Jupiter /swap/v2/build routePlan[].swapInfo.label
export const VENUE_LABELS = {
  raydiumClmm: ["Raydium CLMM"],
  raydiumCpmm: ["Raydium CPMM"],
  raydiumAmm: ["Raydium"],
  orcaWhirlpool: ["Whirlpool"],
  meteoraDlmm: ["Meteora DLMM"],
  phoenix: ["Phoenix"],
  openbook: ["OpenBook"],
  pumpSwap: ["PumpSwap"],
} as const;

export type VenueKey = keyof typeof VENUE_LABELS;

// ── Token pair definitions for multi-pair scanning ────────────────────────────
// Each pair is [baseMint, quoteMint, baseDecimals, quoteDecimals, baseSymbol]
export interface TokenPair {
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  baseSymbol: string;
}

export const TOKEN_PAIRS: TokenPair[] = [
  { baseMint: USDC_MINT_STR, quoteMint: SOL_MINT_STR, baseDecimals: USDC_DECIMALS, quoteDecimals: SOL_DECIMALS, baseSymbol: "USDC" },
  { baseMint: USDC_MINT_STR, quoteMint: USDT_MINT_STR, baseDecimals: USDC_DECIMALS, quoteDecimals: USDT_DECIMALS, baseSymbol: "USDC" },
  { baseMint: SOL_MINT_STR, quoteMint: MSOL_MINT_STR, baseDecimals: SOL_DECIMALS, quoteDecimals: MSOL_DECIMALS, baseSymbol: "SOL" },
  { baseMint: SOL_MINT_STR, quoteMint: BONK_MINT_STR, baseDecimals: SOL_DECIMALS, quoteDecimals: BONK_DECIMALS, baseSymbol: "SOL" },
  { baseMint: SOL_MINT_STR, quoteMint: JUP_MINT_STR, baseDecimals: SOL_DECIMALS, quoteDecimals: JUP_DECIMALS, baseSymbol: "SOL" },
];

// ── Cross-DEX pairs to scan (when DEX_PAIRS env is empty) ────────────────────
export const CROSS_DEX_PAIRS: Array<[VenueKey, VenueKey]> = [
  // CLMM <-> CLMM
  ["raydiumClmm", "orcaWhirlpool"],
  ["orcaWhirlpool", "raydiumClmm"],
  ["raydiumClmm", "meteoraDlmm"],
  ["meteoraDlmm", "raydiumClmm"],
  ["orcaWhirlpool", "meteoraDlmm"],
  ["meteoraDlmm", "orcaWhirlpool"],
  // CLMM <-> Phoenix
  ["raydiumClmm", "phoenix"],
  ["phoenix", "raydiumClmm"],
  ["orcaWhirlpool", "phoenix"],
  ["phoenix", "orcaWhirlpool"],
  ["meteoraDlmm", "phoenix"],
  ["phoenix", "meteoraDlmm"],
  // CLMM <-> PumpSwap (CPMM — different pricing model)
  ["raydiumClmm", "pumpSwap"],
  ["pumpSwap", "raydiumClmm"],
  ["orcaWhirlpool", "pumpSwap"],
  ["pumpSwap", "orcaWhirlpool"],
  ["meteoraDlmm", "pumpSwap"],
  ["pumpSwap", "meteoraDlmm"],
  // CLMM <-> Raydium AMM v4 (CPMM)
  ["raydiumClmm", "raydiumAmm"],
  ["raydiumAmm", "raydiumClmm"],
  ["orcaWhirlpool", "raydiumAmm"],
  ["raydiumAmm", "orcaWhirlpool"],
  ["meteoraDlmm", "raydiumAmm"],
  ["raydiumAmm", "meteoraDlmm"],
];

// ── Base mint / quote mint defaults for configurable detection ────────────────
export const DEFAULT_BASE_MINTS = [USDC_MINT_STR];
export const DEFAULT_QUOTE_MINTS = [SOL_MINT_STR];
export const DEFAULT_PROBE_AMOUNTS = [
  BigInt(100 * 1_000_000),   // 100 USDC
  BigInt(250 * 1_000_000),   // 250 USDC
  BigInt(500 * 1_000_000),   // 500 USDC
];
