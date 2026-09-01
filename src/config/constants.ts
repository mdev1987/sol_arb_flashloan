import { PublicKey } from "@solana/web3.js";

// ── Token mints ──────────────────────────────────────────────────────────────
export const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

export const SOL_MINT_STR = SOL_MINT.toBase58();
export const USDC_MINT_STR = USDC_MINT.toBase58();

// ── Decimals ─────────────────────────────────────────────────────────────────
export const SOL_DECIMALS = 9;
export const USDC_DECIMALS = 6;

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
} as const;

export type VenueKey = keyof typeof VENUE_LABELS;

// ── Cross-DEX pairs to scan (when DEX_PAIRS env is empty) ────────────────────
export const CROSS_DEX_PAIRS: Array<[VenueKey, VenueKey]> = [
  ["raydiumClmm", "orcaWhirlpool"],
  ["orcaWhirlpool", "raydiumClmm"],
  ["raydiumCpmm", "orcaWhirlpool"],
  ["orcaWhirlpool", "raydiumCpmm"],
  ["raydiumClmm", "meteoraDlmm"],
  ["meteoraDlmm", "raydiumClmm"],
  ["raydiumCpmm", "meteoraDlmm"],
  ["meteoraDlmm", "raydiumCpmm"],
  ["orcaWhirlpool", "meteoraDlmm"],
  ["meteoraDlmm", "orcaWhirlpool"],
  ["raydiumClmm", "phoenix"],
  ["phoenix", "raydiumClmm"],
  ["orcaWhirlpool", "phoenix"],
  ["phoenix", "orcaWhirlpool"],
  ["raydiumClmm", "openbook"],
  ["openbook", "raydiumClmm"],
];

// ── Base mint / quote mint defaults for configurable detection ────────────────
export const DEFAULT_BASE_MINTS = [USDC_MINT_STR];
export const DEFAULT_QUOTE_MINTS = [SOL_MINT_STR];
export const DEFAULT_PROBE_AMOUNTS = [
  BigInt(100 * 1_000_000),   // 100 USDC
  BigInt(250 * 1_000_000),   // 250 USDC
  BigInt(500 * 1_000_000),   // 500 USDC
];
