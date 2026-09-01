import {
  PublicKey,
  VersionedTransaction,
  TransactionInstruction,
  TransactionMessage,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { env } from "../config/env";
import { log } from "../utils/logger";
import { getConnection, getKeypair } from "../helius/client";
import type { ArbOpportunity, SimulationResult } from "../market/types";
import {
  buildArbitrage,
  buildVersionedTransaction,
  selectTipAccount,
} from "./builder";
import {
  estimatePriorityFee,
  feeFromCu,
  sizeOf,
} from "./builder";
import { getPricesUsd } from "../jupiter/client";

const SOL_MINT_STR = "So11111111111111111111111111111111111111112";

// ── Single execution identity ────────────────────────────────────────────────
// Always use the same keypair for simulation and transaction signing.
// In SIMULATE mode, getKeypair() generates a throwaway if PRIVATE_KEY is empty.
// This ensures the payer used in buildArbitrage(), simulation, and signing is identical.

function getSimulationPayer(): { publicKey: PublicKey; signer: import("@solana/web3.js").Keypair } {
  const signer = getKeypair();
  return { publicKey: signer.publicKey, signer };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function usdPrice(mint: string): Promise<{ price: number; decimals: number }> {
  const prices = await getPricesUsd([mint]);
  return { price: prices[mint]?.usdPrice ?? 0, decimals: prices[mint]?.decimals ?? 0 };
}

function inputUsd(opp: ArbOpportunity, price: { price: number; decimals: number }): number {
  return (Number(opp.inputAmount) / 10 ** price.decimals) * price.price;
}

function failure(
  opp: ArbOpportunity,
  logs: string[] | null,
  error: string,
  unitsConsumed: number,
  computeUnitLimit: number,
  priorityFeeMicroLamports: number,
  tipLamports: number,
  priorityFeeLamports: number,
  totalCostUsd: number,
  inputUsd: number,
  netProfitBps: number,
  txBytes = 0,
): SimulationResult {
  return {
    opportunity: opp,
    wouldSucceed: false,
    unitsConsumed,
    computeUnitLimit,
    priorityFeeMicroLamports,
    priorityFeeLamports,
    baseFeeLamports: 5_000,
    tipLamports,
    totalCostLamports: priorityFeeLamports + 5_000 + tipLamports,
    totalCostUsd,
    grossProfitUsd: opp.profitUsd,
    netProfitUsd: opp.profitUsd - totalCostUsd,
    inputUsd,
    netProfitBps,
    txBytes,
    logs,
    error,
  };
}

// ── Main simulation pipeline ─────────────────────────────────────────────────

export async function simulateOpportunity(opp: ArbOpportunity): Promise<SimulationResult> {
  const connection = getConnection();
  const payer = getSimulationPayer();

  try {
    const built = await buildArbitrage(connection, opp, payer.publicKey);
    const tipAccount = selectTipAccount(Number(opp.inputAmount % 1_000_000n));
    const sol = await usdPrice(SOL_MINT_STR);
    const profitMint = await usdPrice(opp.profitMint);
    const baseInputUsd = inputUsd(opp, profitMint);

    // ── Stage 1: Rough CU estimate ──────────────────────────────────────
    // Assembly: computeBudget → borrow → coreInstructions → repay
    const stage1Instructions: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: env.MAX_COMPUTE_UNITS }),
    ];
    if (built.borrowIx) stage1Instructions.push(built.borrowIx);
    stage1Instructions.push(...built.coreInstructions);
    if (built.repayIx) stage1Instructions.push(built.repayIx);

    const { blockhash: stage1Blockhash } = await connection.getLatestBlockhash("processed");
    const stage1Message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: stage1Blockhash,
      instructions: stage1Instructions,
    }).compileToV0Message(built.lookupTables);
    const stage1Tx = new VersionedTransaction(stage1Message);
    stage1Tx.sign([payer.signer]);

    const stage1Sim = await connection.simulateTransaction(stage1Tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "processed",
    });
    const roughCu = stage1Sim.value.unitsConsumed ?? 0;
    if (stage1Sim.value.err) {
      return failure(opp, stage1Sim.value.logs ?? null, JSON.stringify(stage1Sim.value.err), roughCu, 0, 0, 0, 0, 0, 0, 0);
    }
    if (roughCu <= 0) throw new Error("Simulation returned zero compute units");

    const computeUnitLimit = Math.ceil(roughCu * (1 + env.CU_MARGIN_BPS / 10_000));
    if (computeUnitLimit > env.MAX_COMPUTE_UNITS) {
      return failure(opp, stage1Sim.value.logs ?? null, `compute limit ${computeUnitLimit} exceeds max ${env.MAX_COMPUTE_UNITS}`, roughCu, computeUnitLimit, 0, 0, 0, 0, baseInputUsd, 0);
    }

    // ── Priority fee from actual candidate TX ───────────────────────────
    const { blockhash: candidateHash } = await connection.getLatestBlockhash("processed");
    const candidate = buildVersionedTransaction(
      payer.publicKey,
      candidateHash,
      built.lookupTables,
      built.borrowIx,
      built.coreInstructions,
      built.repayIx,
      computeUnitLimit,
      0,
      1,
      tipAccount,
    );
    candidate.sign([payer.signer]);
    const priorityFeeMicroLamports = await estimatePriorityFee(env.HELIUS_API_KEY, candidate);
    const priorityFeeLamports = feeFromCu(priorityFeeMicroLamports, computeUnitLimit);
    const baseFeeLamports = 5_000;

    // ── Tip estimation ──────────────────────────────────────────────────
    const solPriceUsd = sol.price;
    const profitLamports = opp.profitUsd / solPriceUsd * 1e9;
    const minTip = env.SENDER_MODE === "swqos" ? 5_000 : Math.max(1_000_000, env.MIN_SENDER_TIP_LAMPORTS);
    const tipFromProfit = Math.round(profitLamports * (env.MAX_TIP_PROFIT_PCT / 100));
    const tipLamports = Math.max(minTip, Math.min(env.MAX_SENDER_TIP_LAMPORTS, tipFromProfit));

    const totalCostLamports = priorityFeeLamports + baseFeeLamports + tipLamports;
    const totalCostUsd = (totalCostLamports / 1e9) * solPriceUsd;
    const grossUsd = opp.profitUsd;
    const netUsd = grossUsd - totalCostUsd;
    const netBps = baseInputUsd > 0 ? (netUsd / baseInputUsd) * 10_000 : 0;

    // ── Stage 2: Final TX simulation ────────────────────────────────────
    const { blockhash: finalHash } = await connection.getLatestBlockhash("processed");
    const finalTx = buildVersionedTransaction(
      payer.publicKey,
      finalHash,
      built.lookupTables,
      built.borrowIx,
      built.coreInstructions,
      built.repayIx,
      computeUnitLimit,
      priorityFeeMicroLamports,
      tipLamports,
      tipAccount,
    );
    if (sizeOf(finalTx) > env.MAX_TX_BYTES) {
      return failure(opp, stage1Sim.value.logs ?? null, `transaction is ${sizeOf(finalTx)} bytes (max ${env.MAX_TX_BYTES})`, roughCu, computeUnitLimit, priorityFeeMicroLamports, tipLamports, priorityFeeLamports, totalCostUsd, baseInputUsd, netBps, sizeOf(finalTx));
    }
    finalTx.sign([payer.signer]);

    const stage2Sim = await connection.simulateTransaction(finalTx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "processed",
    });
    const finalCu = stage2Sim.value.unitsConsumed ?? 0;
    if (stage2Sim.value.err) {
      return failure(opp, stage2Sim.value.logs ?? null, JSON.stringify(stage2Sim.value.err), finalCu, computeUnitLimit, priorityFeeMicroLamports, tipLamports, priorityFeeLamports, totalCostUsd, baseInputUsd, netBps, sizeOf(finalTx));
    }
    if (Math.ceil(finalCu * (1 + env.CU_MARGIN_BPS / 10_000)) > env.MAX_COMPUTE_UNITS) {
      return failure(opp, stage2Sim.value.logs ?? null, `stage-2 CU ${finalCu} exceeds configured maximum`, finalCu, computeUnitLimit, priorityFeeMicroLamports, tipLamports, priorityFeeLamports, totalCostUsd, baseInputUsd, netBps, sizeOf(finalTx));
    }

    log.info(
      {
        stage1Cu: roughCu,
        stage2Cu: finalCu,
        computeUnitLimit,
        priorityFeeLamports,
        tipLamports,
        totalCostUsd: totalCostUsd.toFixed(5),
        netUsd: netUsd.toFixed(4),
        netBps: netBps.toFixed(2),
        txBytes: sizeOf(finalTx),
      },
      "Two-stage simulation passed",
    );

    return {
      opportunity: opp,
      wouldSucceed: true,
      unitsConsumed: finalCu,
      computeUnitLimit,
      priorityFeeMicroLamports,
      priorityFeeLamports,
      baseFeeLamports,
      tipLamports,
      totalCostLamports,
      totalCostUsd,
      grossProfitUsd: grossUsd,
      netProfitUsd: netUsd,
      inputUsd: baseInputUsd,
      netProfitBps: netBps,
      txBytes: sizeOf(finalTx),
      logs: stage2Sim.value.logs ?? null,
      finalTx,
      tipAccount,
      solPriceUsd,
    };
  } catch (error) {
    return failure(opp, null, String(error), 0, 0, 0, 0, 0, 0, 0, 0);
  }
}

export function logSimulationResult(result: SimulationResult): void {
  const opp = result.opportunity;
  log.info(
    {
      path: opp.path.join(" -> "),
      grossUsd: result.grossProfitUsd.toFixed(4),
      netUsd: result.netProfitUsd.toFixed(4),
      netBps: result.netProfitBps.toFixed(2),
      costUsd: result.totalCostUsd.toFixed(5),
      CU: `${result.unitsConsumed}/${result.computeUnitLimit}`,
      bytes: result.txBytes,
      dexes: opp.dexesUsed.join(", "),
      wouldLand: result.wouldSucceed,
      ...(result.error ? { reason: result.error } : {}),
    },
    result.wouldSucceed ? "SIMULATION: would land" : "SIMULATION: would fail",
  );
}
