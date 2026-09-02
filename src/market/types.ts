import type { JupiterBuildResponse } from "../jupiter/quote";
import type { VersionedTransaction } from "@solana/web3.js";

// ── Detection types ──────────────────────────────────────────────────────────

/** Single leg of an arbitrage path */
export interface ArbLeg {
  build: JupiterBuildResponse;
  inputMint: string;
  outputMint: string;
  inputAmount: bigint;
  outputAmount: bigint;
  routeDexes: string[];
  constrainedDex?: string[];
}

/** Arbitrage opportunity detected (GROSS — no fees estimated) */
export interface ArbOpportunity {
  /** Token path: [inputMint, ...intermediateMints, inputMint] */
  path: string[];
  /** Individual swap legs */
  legs: ArbLeg[];
  inputAmount: bigint;
  outputAmount: bigint;
  /** Gross profit before any fees, priority, or tip */
  profitAmount: bigint;
  /** Which token the profit is denominated in */
  profitMint: string;
  /** Gross profit in basis points */
  profitBps: number;
  /** Estimated gross profit in USD */
  profitUsd: number;
  /** Unique DEX labels used across all legs */
  dexesUsed: string[];
  detectedAt: number;
  /** Whether the flash-loan provider supports this asset */
  flashLoanAssetSupported: boolean;
  /** Legacy venue fields for safety checks */
  venueA?: string[];
  venueB?: string[];
  /** Full quote responses for transaction building */
  quoteA?: JupiterBuildResponse;
  quoteB?: JupiterBuildResponse;
}

// ── Simulation types ─────────────────────────────────────────────────────────

export interface SimulationResult {
  opportunity: ArbOpportunity;
  wouldSucceed: boolean;
  unitsConsumed: number;
  computeUnitLimit: number;
  priorityFeeMicroLamports: number;
  priorityFeeLamports: number;
  baseFeeLamports: number;
  tipLamports: number;
  totalCostLamports: number;
  totalCostUsd: number;
  grossProfitUsd: number;
  netProfitUsd: number;
  inputUsd: number;
  netProfitBps: number;
  txBytes: number;
  logs: string[] | null;
  error?: string;
  finalTx?: VersionedTransaction;
  tipAccount?: import("@solana/web3.js").PublicKey;
  solPriceUsd?: number;
  /** Pipeline lifecycle timestamps */
  freshQuotedAt?: number;
  simulatedAt?: number;
  /** Total wall-clock time from detection to simulation completion */
  pipelineDurationMs?: number;
}

// ── Bot types ────────────────────────────────────────────────────────────────

export type BotMode = "SIMULATE" | "SHADOW" | "LIVE";

export interface BotState {
  mode: BotMode;
  running: boolean;
  startTime: number;
  totalScans: number;
  totalOpportunities: number;
  totalTrades: number;
  expectedProfit: bigint;
  simulatedProfit: bigint;
  realizedProfit: bigint;
  lastScanTime: number;
  lastError?: string;
}
