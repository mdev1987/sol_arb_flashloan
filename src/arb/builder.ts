import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import { env } from "../config/env";
import { SENDER_TIP_ACCOUNTS } from "../config/constants";
import { log } from "../utils/logger";
import type { ArbOpportunity } from "../market/types";
import {
  instructionsFromBuild,
  type BuildResponse,
} from "../jupiter/client";
import { getFlashLoanIx, type FlashLoanPlan } from "../jupiter/flashloan";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BuiltArbitrage {
  borrowIx: TransactionInstruction | null;
  coreInstructions: TransactionInstruction[];
  repayIx: TransactionInstruction | null;
  lookupTables: AddressLookupTableAccount[];
  flashLoan: FlashLoanPlan | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function selectTipAccount(seed: number): PublicKey {
  const index = Math.abs(seed) % SENDER_TIP_ACCOUNTS.length;
  return SENDER_TIP_ACCOUNTS[index]!;
}

export function buildTipInstruction(payer: PublicKey, tipLamports: number, tipAccount: PublicKey): TransactionInstruction {
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: tipAccount,
    lamports: tipLamports,
  });
}

function tipForProfit(profitUsd: number, solPriceUsd: number): number {
  const min = env.SENDER_MODE === "swqos" ? 5_000 : Math.max(1_000_000, env.MIN_SENDER_TIP_LAMPORTS);
  if (!Number.isFinite(profitUsd) || profitUsd <= 0 || !Number.isFinite(solPriceUsd) || solPriceUsd <= 0) {
    return min;
  }
  const profitLamports = (profitUsd / solPriceUsd) * 1e9;
  const tip = Math.round(profitLamports * (env.MAX_TIP_PROFIT_PCT / 100));
  return Math.max(min, Math.min(env.MAX_SENDER_TIP_LAMPORTS, tip));
}

function sizeOf(tx: VersionedTransaction): number {
  return tx.serialize().length;
}

function feeFromCu(priorityFeeMicroLamports: number, computeUnitLimit: number): number {
  return Math.ceil((priorityFeeMicroLamports * computeUnitLimit) / 1_000_000);
}

async function resolveLookupTables(connection: Connection, builds: BuildResponse[]): Promise<AddressLookupTableAccount[]> {
  const addresses = new Set<string>();
  for (const build of builds) {
    for (const addr of Object.keys(build.addressesByLookupTableAddress ?? {})) addresses.add(addr);
  }
  const tables: AddressLookupTableAccount[] = [];
  for (const address of addresses) {
    try {
      const result = await connection.getAddressLookupTable(new PublicKey(address));
      if (result.value) tables.push(result.value);
    } catch (error) {
      log.warn({ address, error: String(error).slice(0, 80) }, "ALT fetch failed");
    }
  }
  return tables;
}

// ── Build arbitrage instructions ─────────────────────────────────────────────

export async function buildArbitrage(
  connection: Connection,
  opportunity: ArbOpportunity,
  payer: PublicKey,
): Promise<BuiltArbitrage> {
  const coreInstructions: TransactionInstruction[] = [];

  // ── Invariant checks ──────────────────────────────────────────────────
  const first = opportunity.legs[0];
  const last = opportunity.legs.at(-1);
  if (!first || !last) throw new Error("Arbitrage requires at least one leg");
  if (first.inputMint !== opportunity.profitMint) {
    throw new Error(`profitMint mismatch: expected ${first.inputMint}, got ${opportunity.profitMint}`);
  }
  if (first.inputAmount !== opportunity.inputAmount) {
    throw new Error(`inputAmount mismatch: expected ${first.inputAmount}, got ${opportunity.inputAmount}`);
  }
  if (last.outputMint !== first.inputMint) {
    throw new Error(`round-trip violation: last leg outputs ${last.outputMint}, expected ${first.inputMint}`);
  }
  if (last.outputAmount <= first.inputAmount) {
    throw new Error(`not profitable: output ${last.outputAmount} <= input ${first.inputAmount}`);
  }

  // Flash loan (optional)
  let flashLoan: FlashLoanPlan | null = null;
  if (env.FLASH_LOAN_PROVIDER !== "none") {
    flashLoan = await getFlashLoanIx(
      new PublicKey(opportunity.profitMint),
      opportunity.inputAmount,
      payer,
    );
  }

  // coreInstructions = ONLY custom logic (no borrowIx, no repayIx)
  // Final assembly: computeBudget → borrow → coreInstructions → tip → repay

  // Add swap instructions from each leg
  for (let i = 0; i < opportunity.legs.length; i++) {
    const leg = opportunity.legs[i]!;
    const includeCleanup = i === opportunity.legs.length - 1;
    const ixs = instructionsFromBuild(leg.build, includeCleanup);
    coreInstructions.push(...ixs);
  }

  const builds = opportunity.legs.map((leg) => leg.build);
  const lookupTables = await resolveLookupTables(connection, builds);

  return {
    borrowIx: flashLoan?.borrowIx ?? null,
    coreInstructions,
    repayIx: flashLoan?.repayIx ?? null,
    lookupTables,
    flashLoan,
  };
}

// ── Build versioned transaction ──────────────────────────────────────────────

export function buildVersionedTransaction(
  payer: PublicKey,
  blockhash: string,
  lookupTables: AddressLookupTableAccount[],
  borrowIx: TransactionInstruction | null,
  coreInstructions: TransactionInstruction[],
  repayIx: TransactionInstruction | null,
  computeUnitLimit: number,
  priorityFeeMicroLamports: number,
  tipLamports: number,
  tipAccount: PublicKey,
): VersionedTransaction {
  const limit = Math.min(env.MAX_COMPUTE_UNITS, Math.max(1, Math.ceil(computeUnitLimit)));
  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: limit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.max(0, Math.floor(priorityFeeMicroLamports)) }),
  ];
  if (borrowIx) instructions.push(borrowIx);
  instructions.push(...coreInstructions);
  instructions.push(buildTipInstruction(payer, tipLamports, tipAccount));
  if (repayIx) instructions.push(repayIx);

  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions })
    .compileToV0Message(lookupTables);
  return new VersionedTransaction(message);
}

// ── Priority fee estimation ──────────────────────────────────────────────────

export async function estimatePriorityFee(apiKey: string, candidateTx: VersionedTransaction): Promise<number> {
  const { getPriorityFee } = await import("../helius/priority-fee");
  return getPriorityFee(apiKey, candidateTx);
}

export { tipForProfit, sizeOf, feeFromCu };
