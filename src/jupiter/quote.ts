import { env } from "../config/env";
import { log } from "../utils/logger";
import { getKeypair } from "../helius/client";
import {
  getBuild,
  priceImpactToBps,
  routeUsesOnly,
  type BuildResponse,
} from "./client";

export type JupiterBuildResponse = BuildResponse;

/** Convert decimal ratio priceImpactPct to basis points */
export { priceImpactToBps };

/**
 * Get a Jupiter quote via /swap/v2/build with RTSE support and optional DEX constraints.
 * Wraps getBuild with Keypair-aware defaults.
 */
export async function getQuote(
  inputMintStr: string,
  outputMintStr: string,
  amount: bigint,
  options?: {
    slippageBps?: number | "rtse";
    dexes?: string[];
    excludeDexes?: string[];
    noRetry?: boolean;
    wrapAndUnwrapSol?: boolean;
    destinationTokenAccount?: string;
    maxAccounts?: number;
  },
): Promise<JupiterBuildResponse> {
  const taker = getKeypair().publicKey.toBase58();

  const slippage: number | "rtse" = env.JUPITER_RTSE
    ? "rtse"
    : (options?.slippageBps ?? env.MAX_SLIPPAGE_BPS);

  const build = await getBuild({
    inputMint: inputMintStr,
    outputMint: outputMintStr,
    amount,
    taker,
    slippageBps: slippage,
    dexes: options?.dexes,
    excludeDexes: options?.excludeDexes,
    wrapAndUnwrapSol: options?.wrapAndUnwrapSol,
    destinationTokenAccount: options?.destinationTokenAccount,
    maxAccounts: options?.maxAccounts,
  });

  if (!build) {
    throw new Error("Jupiter /build returned null");
  }

  const impactBps = priceImpactToBps(build.priceImpactPct);

  log.debug(
    {
      input: inputMintStr.slice(0, 8),
      output: outputMintStr.slice(0, 8),
      inAmount: build.inAmount,
      outAmount: build.outAmount,
      impactBps,
      routeSteps: build.routePlan.length,
      dexes: options?.dexes ?? "any",
    },
    "Jupiter quote received",
  );

  return build;
}

/** Verify that a route plan uses ONLY expected venue labels (case-insensitive) */
export function routeUsesOnlyVenue(
  routePlan: BuildResponse["routePlan"],
  venueLabels: readonly string[] | string[],
): boolean {
  const venueSet = new Set(venueLabels.map((l) => l.toLowerCase()));
  for (const step of routePlan) {
    const label = step.swapInfo.label.toLowerCase();
    if (!venueSet.has(label)) {
      return false;
    }
  }
  return true;
}
