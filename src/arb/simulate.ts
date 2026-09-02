import {
  PublicKey,
  VersionedTransaction,
  TransactionInstruction,
  TransactionMessage,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { env } from "../config/env";
import { log } from "../utils/logger";
import { getConnection, getKeypair } from "../helius/client";
import type { ArbOpportunity, ArbLeg, SimulationResult } from "../market/types";
import {
  buildArbitrage,
  buildVersionedTransaction,
  selectTipAccount,
  tipForProfit,
} from "./builder";
import {
  estimatePriorityFee,
  feeFromCu,
  sizeOf,
} from "./builder";
import { getBuild, routeDexes, routeUsesOnly, getPricesUsd } from "../jupiter/client";
import { SOL_MINT_STR } from "../config/constants";
import { makeOpportunity } from "./detector";

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

// ── Fresh builds pipeline ────────────────────────────────────────────────────
// Re-fetches Jupiter /build for each leg using original parameters.
// Validates every fresh build against the original constraint before accepting.
// Ensures simulation is based on the freshest possible quotes, not stale
// builds from detection (which can be seconds old).

async function refetchLegs(legs: ArbLeg[], taker: string): Promise<ArbLeg[]> {
  const refreshed: ArbLeg[] = [];
  let currentAmount = legs[0]!.inputAmount;

  for (const orig of legs) {
    const isSolOutput = orig.outputMint === SOL_MINT_STR;
    const destinationTokenAccount = isSolOutput
      ? getAssociatedTokenAddressSync(new PublicKey(SOL_MINT_STR), new PublicKey(taker)).toBase58()
      : undefined;

    const build = await getBuild({
      inputMint: orig.inputMint,
      outputMint: orig.outputMint,
      amount: currentAmount,
      taker,
      slippageBps: "rtse",
      dexes: orig.constrainedDex,
      maxAccounts: 64,
      wrapAndUnwrapSol: false,
      destinationTokenAccount,
    });

    if (!build) {
      log.debug({ inputMint: orig.inputMint.slice(0, 8), outputMint: orig.outputMint.slice(0, 8) }, "Fresh build returned null — skipping");
      return [];
    }

    // Validate build matches requested parameters
    if (BigInt(build.inAmount) !== currentAmount) {
      log.warn({ expected: currentAmount.toString(), actual: build.inAmount }, "Fresh build inAmount mismatch — skipping");
      return [];
    }
    if (build.inputMint !== orig.inputMint) {
      log.warn({ expected: orig.inputMint, actual: build.inputMint }, "Fresh build inputMint mismatch — skipping");
      return [];
    }
    if (build.outputMint !== orig.outputMint) {
      log.warn({ expected: orig.outputMint, actual: build.outputMint }, "Fresh build outputMint mismatch — skipping");
      return [];
    }

    // Revalidate route constraint — the fresh build must use only the constrained DEXes
    if (orig.constrainedDex && !routeUsesOnly(build, orig.constrainedDex)) {
      log.warn({ dexes: orig.constrainedDex, route: routeDexes(build) }, "Fresh build route violates DEX constraint — skipping");
      return [];
    }

    refreshed.push({
      build,
      inputMint: orig.inputMint,
      outputMint: orig.outputMint,
      inputAmount: currentAmount,
      outputAmount: BigInt(build.outAmount),
      routeDexes: routeDexes(build),
      constrainedDex: orig.constrainedDex,
    });

    currentAmount = BigInt(build.outAmount);
  }

  return refreshed;
}

// ── Main simulation pipeline ─────────────────────────────────────────────────

export async function simulateOpportunity(opp: ArbOpportunity): Promise<SimulationResult> {
  const connection = getConnection();
  const payer = getSimulationPayer();
  const pipelineStart = Date.now();

  try {
    // Reject stale opportunities — if detection is too old, the opportunity
    // has likely already been arbitraged by faster bots.
    if (Date.now() - opp.detectedAt > env.MAX_OPPORTUNITY_AGE_MS) {
      return failure(opp, null, `opportunity stale: ${Date.now() - opp.detectedAt}ms old (max ${env.MAX_OPPORTUNITY_AGE_MS}ms)`, 0, 0, 0, 0, 0, 0, 0, 0);
    }

    // Re-fetch fresh builds for each leg before simulation.
    // This ensures we simulate against current market state, not stale detection quotes.
    const freshLegs = await refetchLegs(opp.legs, payer.publicKey.toBase58());
    const freshQuotedAt = Date.now();
    if (freshLegs.length !== opp.legs.length) {
      return failure(opp, null, "fresh build refetch failed", 0, 0, 0, 0, 0, 0, 0, 0);
    }

    // Rebuild the COMPLETE opportunity from fresh legs.
    // This ensures profitAmount, profitBps, profitUsd, dexesUsed, path, etc.
    // are all derived from the same fresh quote set — not stale detection data.
    const simOpp = await makeOpportunity(freshLegs);
    if (!simOpp) {
      return failure(opp, null, "fresh opportunity reconstruction failed", 0, 0, 0, 0, 0, 0, 0, 0);
    }

    // Re-validate profitability thresholds against fresh data
    if (simOpp.profitAmount <= 0n) {
      return failure(simOpp, null, "fresh quotes show no profit", 0, 0, 0, 0, 0, 0, 0, 0);
    }
    if (simOpp.profitBps < env.MIN_PROFIT_BPS) {
      return failure(simOpp, null, `fresh profit ${simOpp.profitBps} bps below min ${env.MIN_PROFIT_BPS}`, 0, 0, 0, 0, 0, 0, 0, 0);
    }
    if (simOpp.profitUsd < env.MIN_PROFIT_USDC) {
      return failure(simOpp, null, `fresh profit $${simOpp.profitUsd.toFixed(4)} below min $${env.MIN_PROFIT_USDC}`, 0, 0, 0, 0, 0, 0, 0, 0);
    }

    const built = await buildArbitrage(connection, simOpp, payer.publicKey);
    const tipAccount = selectTipAccount(Number(simOpp.inputAmount % 1_000_000n));
    const sol = await usdPrice(SOL_MINT_STR);
    const profitMint = await usdPrice(simOpp.profitMint);

    // Validate prices — a failed price fetch can produce 0, leading to
    // division-by-zero in tip calc and zero cost USD (artificially high net profit).
    if (!Number.isFinite(sol.price) || sol.price <= 0) {
      return failure(simOpp, null, `invalid SOL/USD price: ${sol.price}`, 0, 0, 0, 0, 0, 0, 0, 0);
    }
    if (!Number.isFinite(profitMint.price) || profitMint.price <= 0) {
      return failure(simOpp, null, `invalid profitMint/USD price: ${profitMint.price}`, 0, 0, 0, 0, 0, 0, 0, 0);
    }

    const baseInputUsd = inputUsd(simOpp, profitMint);

    // Flash-loan fee in USD (Jupiter Lend currently charges zero fees, but this
    // ensures the cost model is correct if fees are added in the future).
    const flashLoanFeeUsd = built.flashLoan
      ? (Number(built.flashLoan.feeAmount) / 10 ** profitMint.decimals) * profitMint.price
      : 0;

    // ── Stage 1: CU estimate without tip ────────────────────────────────
    // Purpose: measure execution cost of the core arbitrage logic.
    // This is NOT the final transaction — it omits the tip instruction.
    // Assembly: computeBudget → borrow → coreInstructions → repay
    // The CU margin applied here serves as a precomputed safety limit for Stage 2.
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
      return failure(simOpp, stage1Sim.value.logs ?? null, JSON.stringify(stage1Sim.value.err), roughCu, 0, 0, 0, 0, 0, 0, 0);
    }
    if (roughCu <= 0) throw new Error("Simulation returned zero compute units");

    const computeUnitLimit = Math.ceil(roughCu * (1 + env.CU_MARGIN_BPS / 10_000));
    if (computeUnitLimit > env.MAX_COMPUTE_UNITS) {
      return failure(simOpp, stage1Sim.value.logs ?? null, `compute limit ${computeUnitLimit} exceeds max ${env.MAX_COMPUTE_UNITS}`, roughCu, computeUnitLimit, 0, 0, 0, 0, baseInputUsd, 0);
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
    const tipLamports = tipForProfit(simOpp.profitUsd, solPriceUsd);

    const totalCostLamports = priorityFeeLamports + baseFeeLamports + tipLamports;
    const totalCostUsd = (totalCostLamports / 1e9) * solPriceUsd + flashLoanFeeUsd;
    const grossUsd = simOpp.profitUsd;
    const netUsd = grossUsd - totalCostUsd;
    const netBps = baseInputUsd > 0 ? (netUsd / baseInputUsd) * 10_000 : 0;

    // ── Stage 2: Final TX simulation ────────────────────────────────────
    // Builds the complete transaction including tip, then simulates it.
    // The CU limit from Stage 1 is used as the precomputed safety limit.
    // If Stage 2 CU exceeds Stage 1 CU + margin, the trade is rejected.
    // The submitted transaction uses this same CU limit (no re-optimization).
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
      return failure(simOpp, stage1Sim.value.logs ?? null, `transaction is ${sizeOf(finalTx)} bytes (max ${env.MAX_TX_BYTES})`, roughCu, computeUnitLimit, priorityFeeMicroLamports, tipLamports, priorityFeeLamports, totalCostUsd, baseInputUsd, netBps, sizeOf(finalTx));
    }
    finalTx.sign([payer.signer]);

    const stage2Sim = await connection.simulateTransaction(finalTx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "processed",
    });
    const finalCu = stage2Sim.value.unitsConsumed ?? 0;
    if (stage2Sim.value.err) {
      return failure(simOpp, stage2Sim.value.logs ?? null, JSON.stringify(stage2Sim.value.err), finalCu, computeUnitLimit, priorityFeeMicroLamports, tipLamports, priorityFeeLamports, totalCostUsd, baseInputUsd, netBps, sizeOf(finalTx));
    }
    if (Math.ceil(finalCu * (1 + env.CU_MARGIN_BPS / 10_000)) > env.MAX_COMPUTE_UNITS) {
      return failure(simOpp, stage2Sim.value.logs ?? null, `stage-2 CU ${finalCu} exceeds configured maximum`, finalCu, computeUnitLimit, priorityFeeMicroLamports, tipLamports, priorityFeeLamports, totalCostUsd, baseInputUsd, netBps, sizeOf(finalTx));
    }

    const simulatedAt = Date.now();

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
        pipelineMs: simulatedAt - pipelineStart,
      },
      "Two-stage simulation passed",
    );

    return {
      opportunity: simOpp,
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
      profitMintPriceUsd: profitMint.price,
      profitMintDecimals: profitMint.decimals,
      freshQuotedAt,
      simulatedAt,
      pipelineDurationMs: simulatedAt - pipelineStart,
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
      pipelineMs: result.pipelineDurationMs,
      ...(result.error ? { reason: result.error } : {}),
    },
    result.wouldSucceed ? "SIMULATION: would land" : "SIMULATION: would fail",
  );
}
