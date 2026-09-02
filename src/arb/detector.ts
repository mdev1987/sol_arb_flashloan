import { env } from "../config/env";
import { SOL_MINT_STR, USDC_MINT_STR, CROSS_DEX_PAIRS, VENUE_LABELS, TOKEN_PAIRS } from "../config/constants";
import type { TokenPair } from "../config/constants";
import { log } from "../utils/logger";
import type { ArbOpportunity, ArbLeg } from "../market/types";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import {
  getBuild,
  routeUsesOnly,
  routeDexes,
  getPricesUsd,
} from "../jupiter/client";

// ── Helpers ──────────────────────────────────────────────────────────────────

function bps(input: bigint, output: bigint): number {
  if (input === 0n) return 0;
  return Number(((output - input) * 10_000n) / input);
}

async function usdValue(mint: string, amount: bigint): Promise<number> {
  if (mint === USDC_MINT_STR) return Number(amount) / 1e6;
  const prices = await getPricesUsd([mint]);
  const p = prices[mint]?.usdPrice;
  if (!p || !Number.isFinite(p)) return 0;
  const decimals = prices[mint]?.decimals ?? 0;
  return (Number(amount) / 10 ** decimals) * p;
}

function parseUserDexPairs(): Array<[string[], string[]]> {
  const raw = env.DEX_PAIRS;
  if (!raw) return [];
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const [a, b] = pair.split(">").map((x) => x.trim());
      if (!a || !b) throw new Error(`Invalid DEX_PAIRS entry: ${pair}`);
      return [[a], [b]] as [string[], string[]];
    });
}

function pairCandidates(): Array<[string[] | undefined, string[] | undefined]> {
  const userPairs = parseUserDexPairs();
  if (userPairs.length > 0) return userPairs;
  return CROSS_DEX_PAIRS.map(([a, b]) => [
    [...VENUE_LABELS[a]],
    [...VENUE_LABELS[b]],
  ]);
}

// ── Leg fetching ─────────────────────────────────────────────────────────────

async function getLeg(
  inputMint: string,
  outputMint: string,
  amount: bigint,
  taker: string,
  dexes?: string[],
): Promise<ArbLeg | null> {
  const isSolOutput = outputMint === SOL_MINT_STR;
  const destinationTokenAccount = isSolOutput
    ? getAssociatedTokenAddressSync(new PublicKey(SOL_MINT_STR), new PublicKey(taker)).toBase58()
    : undefined;

  const build = await getBuild({
    inputMint,
    outputMint,
    amount,
    taker,
    slippageBps: "rtse",
    dexes,
    maxAccounts: 64,
    wrapAndUnwrapSol: false,
    destinationTokenAccount,
  });
  if (!build) return null;
  if (BigInt(build.inAmount) !== amount) {
    log.warn({ expected: amount.toString(), actual: build.inAmount }, "Jupiter returned unexpected inAmount");
    return null;
  }
  return {
    build,
    inputMint,
    outputMint,
    inputAmount: amount,
    outputAmount: BigInt(build.outAmount),
    routeDexes: routeDexes(build),
    constrainedDex: dexes,
  };
}

function validateCrossDex(legs: ArbLeg[]): boolean {
  if (legs.length < 2) return false;
  // Each leg's DEX set must be disjoint from every other leg's DEX set.
  // This enforces true cross-DEX arbitrage: leg1 uses DEX A only, leg2 uses DEX B only, A ∩ B = ∅.
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const setA = new Set(legs[i]!.routeDexes.map((d) => d.toLowerCase()));
      for (const d of legs[j]!.routeDexes) {
        if (setA.has(d.toLowerCase())) return false;
      }
    }
  }
  return true;
}

export async function makeOpportunity(legs: ArbLeg[]): Promise<ArbOpportunity | null> {
  if (legs.length < 2) return null;
  const first = legs[0]!;
  const last = legs[legs.length - 1]!;
  if (last.outputMint !== first.inputMint) return null;
  if (last.outputAmount <= first.inputAmount) return null;
  if (!validateCrossDex(legs)) return null;

  const profitAmount = last.outputAmount - first.inputAmount;
  const profitBps = bps(first.inputAmount, last.outputAmount);
  const profitUsd = await usdValue(first.inputMint, profitAmount);
  const dexesUsed = [...new Set(legs.flatMap((x) => x.routeDexes))];

  return {
    path: [first.inputMint, ...legs.map((x) => x.outputMint)],
    legs,
    inputAmount: first.inputAmount,
    outputAmount: last.outputAmount,
    profitAmount,
    profitMint: first.inputMint,
    profitBps,
    profitUsd,
    dexesUsed,
    detectedAt: Date.now(),
    flashLoanAssetSupported: first.inputMint === SOL_MINT_STR || first.inputMint === USDC_MINT_STR,
    venueA: legs[0]?.constrainedDex,
    venueB: legs[1]?.constrainedDex,
    quoteA: legs[0]?.build,
    quoteB: legs[1]?.build,
  };
}

// ── Round-trip detection ─────────────────────────────────────────────────────

async function checkRoundTrip(
  baseMint: string,
  quoteMint: string,
  amount: bigint,
  taker: string,
): Promise<ArbOpportunity | null> {
  if (baseMint === quoteMint) return null;
  for (const [dexA, dexB] of pairCandidates()) {
    const leg1 = await getLeg(baseMint, quoteMint, amount, taker, dexA);
    if (!leg1) continue;
    if (dexA && !routeUsesOnly(leg1.build, dexA)) continue;
    const leg2 = await getLeg(quoteMint, baseMint, leg1.outputAmount, taker, dexB);
    if (!leg2) continue;
    if (dexB && !routeUsesOnly(leg2.build, dexB)) continue;
    const opp = await makeOpportunity([leg1, leg2]);
    if (opp) return opp;
  }
  return null;
}

// ── Main scan ────────────────────────────────────────────────────────────────

let scanOffset = 0;
let tokenPairOffset = 0;

async function scanPair(
  dexA: string[],
  dexB: string[],
  amount: bigint,
  taker: string,
  tokenPair?: TokenPair,
): Promise<ArbOpportunity | null> {
  const baseMint = tokenPair?.baseMint ?? USDC_MINT_STR;
  const quoteMint = tokenPair?.quoteMint ?? SOL_MINT_STR;
  const baseSymbol = tokenPair?.baseSymbol ?? "USDC";
  const quoteSymbol = tokenPair?.baseSymbol === "SOL" ? "mSOL/BONK/JUP" : "SOL";

  try {
    const leg1 = await getLeg(baseMint, quoteMint, amount, taker, dexA);
    if (!leg1) {
      log.debug({ dexA, baseSymbol, quoteSymbol }, "Leg1: no route");
      return null;
    }
    if (!routeUsesOnly(leg1.build, dexA)) {
      log.debug({ dexA, route: routeDexes(leg1.build) }, "Leg1: route violates DEX constraint");
      return null;
    }
    const leg2 = await getLeg(quoteMint, baseMint, leg1.outputAmount, taker, dexB);
    if (!leg2) {
      log.debug({ dexB, baseSymbol, quoteSymbol }, "Leg2: no route");
      return null;
    }
    if (!routeUsesOnly(leg2.build, dexB)) {
      log.debug({ dexB, route: routeDexes(leg2.build) }, "Leg2: route violates DEX constraint");
      return null;
    }
    const opp = await makeOpportunity([leg1, leg2]);
    if (opp) {
      log.info(
        {
          path: opp.path.map((p) => p.slice(0, 8)).join("->"),
          profitBps: opp.profitBps,
          profitUsd: opp.profitUsd.toFixed(6),
          dexA: dexA.join(","),
          dexB: dexB.join(","),
          baseSymbol,
        },
        "Candidate found",
      );
    }
    return opp;
  } catch {
    return null;
  }
}

export async function scanOnce(taker: string): Promise<ArbOpportunity[]> {
  const found: ArbOpportunity[] = [];
  const scanStart = Date.now();
  const pairLabel = env.DEX_PAIRS ? "user" : "builtin";

  // Build full DEX pair list
  const allPairs: Array<[string[], string[]]> = [];
  if (env.DEX_PAIRS) {
    const parsed = parseUserDexPairs();
    allPairs.push(...parsed);
  } else {
    for (const [venueAKey, venueBKey] of CROSS_DEX_PAIRS) {
      allPairs.push([[...VENUE_LABELS[venueAKey]], [...VENUE_LABELS[venueBKey]]]);
    }
  }

  // Rotate through DEX pairs: each scan starts from a different offset
  const totalPairs = allPairs.length;
  const pairsToScan = Math.min(env.MAX_PAIRS_PER_SCAN, totalPairs);
  const selectedPairs: Array<[string[], string[]]> = [];
  for (let i = 0; i < pairsToScan; i++) {
    selectedPairs.push(allPairs[(scanOffset + i) % totalPairs]!);
  }
  scanOffset = (scanOffset + pairsToScan) % totalPairs;

  // Rotate through token pairs for variety
  const tokenPair = TOKEN_PAIRS[tokenPairOffset % TOKEN_PAIRS.length]!;
  tokenPairOffset = (tokenPairOffset + 1) % TOKEN_PAIRS.length;
  const tradeAmount = BigInt(Math.round(env.MAX_TRADE_USDC * 10 ** tokenPair.baseDecimals));

  // Scan pairs concurrently
  const results = await Promise.allSettled(
    selectedPairs.map(([dexA, dexB]) => scanPair(dexA, dexB, tradeAmount, taker, tokenPair)),
  );

  let noRouteCount = 0;
  let belowThresholdCount = 0;
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      const opp = r.value;
      if (opp.profitBps >= env.MIN_PROFIT_BPS && opp.profitUsd >= env.MIN_PROFIT_USDC) {
        found.push(opp);
      } else {
        belowThresholdCount++;
        log.debug(
          { profitBps: opp.profitBps, profitUsd: opp.profitUsd.toFixed(6), minBps: env.MIN_PROFIT_BPS, minUsd: env.MIN_PROFIT_USDC },
          "Candidate below threshold",
        );
      }
    } else {
      noRouteCount++;
    }
  }

  found.sort((a, b) => b.profitUsd - a.profitUsd);
  log.info(
    {
      pair: `${tokenPair.baseSymbol}/${tokenPair.baseSymbol === "USDC" ? "SOL" : "?"}`,
      dexPairs: pairsToScan,
      totalPairs,
      offset: scanOffset,
      tokenPair: `${tokenPair.baseSymbol}`,
      durationMs: Date.now() - scanStart,
      candidates: found.length,
      noRoute: noRouteCount,
      belowThreshold: belowThresholdCount,
    },
    "Scan complete",
  );
  return found;
}
