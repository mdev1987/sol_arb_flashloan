import type { ArbOpportunity } from "../market/types";
import { bigIntToUsdc } from "../utils/bigint";
import { env } from "../config/env";
import { log } from "../utils/logger";

/**
 * Pre-execution safety checks.
 * Validates gross opportunity quality before entering the execution pipeline.
 * Does NOT estimate fees — that happens in the simulation pipeline.
 */
export function assertSafeToTrade(opp: ArbOpportunity): boolean {
  // ── Check 1: Gross profit must be positive ────────────────────────────────
  if (opp.profitAmount <= 0n) {
    log.warn({ grossProfit: bigIntToUsdc(opp.profitAmount) }, "Safety rejected: negative gross profit");
    return false;
  }

  // ── Check 2: Minimum ABSOLUTE gross profit ────────────────────────────────
  const minProfitAbsUsdc = BigInt(Math.round(env.MIN_PROFIT_USDC * 1_000_000));
  if (opp.profitAmount < minProfitAbsUsdc) {
    log.warn(
      { grossProfit: bigIntToUsdc(opp.profitAmount), minRequired: env.MIN_PROFIT_USDC.toFixed(2) },
      "Safety rejected: below minimum absolute gross profit",
    );
    return false;
  }

  // ── Check 3: Minimum RELATIVE gross profit (e.g. ≥ 10 bps) ───────────────
  if (opp.profitBps < env.MIN_PROFIT_BPS) {
    log.warn(
      { grossProfitBps: opp.profitBps, minRequired: env.MIN_PROFIT_BPS },
      "Safety rejected: below minimum relative gross profit",
    );
    return false;
  }

  // ── Check 4: Price impact must be acceptable (in bps) ───────────────────
  // Check all legs for excessive price impact
  for (const leg of opp.legs) {
    const impactBps = Math.round(Number(leg.build.priceImpactPct) * 10_000);
    if (impactBps > 200) {
      log.warn({ impactBps, dexes: leg.routeDexes }, "Safety rejected: excessive price impact");
      return false;
    }
  }

  // ── Check 5: Trade size must be within limits ────────────────────────────
  const maxTradeUsdc = BigInt(Math.round(env.MAX_TRADE_USDC * 1_000_000));
  if (opp.inputAmount > maxTradeUsdc) {
    log.warn(
      { input: bigIntToUsdc(opp.inputAmount), max: bigIntToUsdc(maxTradeUsdc) },
      "Safety rejected: exceeds max trade size",
    );
    return false;
  }

  // ── Check 6: Quote freshness (within last 10 seconds) ──────────────────
  const quoteAgeMs = Date.now() - opp.detectedAt;
  if (quoteAgeMs > 10000) {
    log.warn({ ageMs: quoteAgeMs }, "Safety rejected: stale quotes");
    return false;
  }

  // ── Check 7: Must be cross-DEX (at least 2 distinct DEXes) ──────────────
  if (opp.dexesUsed.length < 2) {
    log.warn({ dexes: opp.dexesUsed }, "Safety rejected: not cross-DEX");
    return false;
  }

  // ── Check 8: Flash-loan compatible ──────────────────────────────────────
  if (!opp.flashLoanAssetSupported) {
    log.warn({ profitMint: opp.profitMint }, "Safety rejected: flash-loan asset not supported");
    return false;
  }

  log.info(
    {
      grossProfitUsdc: bigIntToUsdc(opp.profitAmount).toFixed(4),
      grossProfitBps: opp.profitBps,
      dexes: opp.dexesUsed.join(", "),
      legs: opp.legs.length,
    },
    "All safety checks passed",
  );

  return true;
}
