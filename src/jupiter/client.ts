import {
  AddressLookupTableAccount,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { env } from "../config/env";
import { log } from "../utils/logger";
import { RateLimiter } from "../utils/retry";

const BASE_URL = "https://api.jup.ag";

// Separate rate limiters: Build API is latency-sensitive, Price API is cheap reads
const buildLimiter = new RateLimiter(env.JUPITER_RATE_LIMIT_RPS);
const priceLimiter = new RateLimiter(Math.min(env.JUPITER_RATE_LIMIT_RPS, 2));

// ── Types ────────────────────────────────────────────────────────────────────

export interface ApiInstruction {
  programId: string;
  accounts: Array<{ pubkey: string; isWritable: boolean; isSigner: boolean }>;
  data: string;
}

export interface RoutePlanStep {
  swapInfo: {
    ammKey: string;
    label: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
  };
  percent: number;
  bps: number;
}

export interface BuildResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: RoutePlanStep[];
  computeBudgetInstructions: ApiInstruction[];
  setupInstructions: ApiInstruction[];
  swapInstruction: ApiInstruction;
  cleanupInstruction: ApiInstruction | null;
  otherInstructions: ApiInstruction[];
  tipInstruction: ApiInstruction | null;
  addressesByLookupTableAddress: Record<string, string[]> | null;
  blockhashWithMetadata: { blockhash: number[]; lastValidBlockHeight: number };
}

export interface BuildParams {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  taker: string;
  slippageBps?: number | "rtse";
  dexes?: string[];
  excludeDexes?: string[];
  wrapAndUnwrapSol?: boolean;
  destinationTokenAccount?: string;
  maxAccounts?: number;
}

function headers(): Record<string, string> {
  const out: Record<string, string> = { "content-type": "application/json" };
  if (env.JUPITER_API_KEY) out["x-api-key"] = env.JUPITER_API_KEY;
  return out;
}

/** Convert a Jupiter API instruction to a Solana TransactionInstruction */
export function toInstruction(ix: ApiInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isWritable: a.isWritable,
      isSigner: a.isSigner,
    })),
    data: Buffer.from(ix.data, "base64"),
  });
}

/**
 * Extract instructions from a BuildResponse in correct order (setup → swap → cleanup → other).
 *
 * Preserves Jupiter's semantic grouping per leg. When composing multiple legs,
 * each leg's instruction set is appended independently — this is safe because
 * otherInstructions are scoped to their own leg's route program interactions.
 */
export function instructionsFromBuild(build: BuildResponse, includeCleanup = true): TransactionInstruction[] {
  return [
    ...build.setupInstructions.map(toInstruction),
    toInstruction(build.swapInstruction),
    ...(includeCleanup && build.cleanupInstruction ? [toInstruction(build.cleanupInstruction)] : []),
    ...build.otherInstructions.map(toInstruction),
  ];
}

/** Get route labels from a build response */
export function routeLabels(build: BuildResponse): string[] {
  return build.routePlan.map((step) => step.swapInfo.label);
}

/** Get unique DEX labels from a build response */
export function routeDexes(build: BuildResponse): string[] {
  return [...new Set(routeLabels(build))];
}

/** Verify route uses ONLY expected DEX labels */
export function routeUsesOnly(build: BuildResponse, expected: string[]): boolean {
  const allowed = new Set(expected.map((x) => x.toLowerCase()));
  if (build.routePlan.length === 0) return false;
  return build.routePlan.every((x) => allowed.has(x.swapInfo.label.toLowerCase()));
}

/** Check that route uses at least 2 distinct DEXes */
export function routeUsesAtLeastTwoDistinctDexes(build: BuildResponse): boolean {
  return new Set(routeDexes(build).map((x) => x.toLowerCase())).size >= 2;
}

/** Fetch a Jupiter /swap/v2/build quote with rate limiting and retry */
export async function getBuild(params: BuildParams): Promise<BuildResponse | null> {
  return buildLimiter.schedule(async () => {
    const url = new URL(`${BASE_URL}/swap/v2/build`);
    url.searchParams.set("inputMint", params.inputMint);
    url.searchParams.set("outputMint", params.outputMint);
    url.searchParams.set("amount", params.amount.toString());
    url.searchParams.set("taker", params.taker);
    url.searchParams.set("slippageBps", String(params.slippageBps ?? "rtse"));
    url.searchParams.set("mode", env.JUPITER_QUOTE_MODE);
    if (params.dexes?.length) url.searchParams.set("dexes", params.dexes.join(","));
    if (params.excludeDexes?.length) url.searchParams.set("excludeDexes", params.excludeDexes.join(","));
    if (params.wrapAndUnwrapSol === false) url.searchParams.set("wrapAndUnwrapSol", "false");
    if (params.destinationTokenAccount) url.searchParams.set("destinationTokenAccount", params.destinationTokenAccount);
    if (params.maxAccounts) url.searchParams.set("maxAccounts", String(params.maxAccounts));

    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, { headers: headers() });
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get("retry-after")) || 2;
          if (attempt < MAX_RETRIES) {
            log.warn({ retryAfter, attempt: attempt + 1 }, "Jupiter 429 rate limited — retrying");
            await new Promise((r) => setTimeout(r, retryAfter * 1000));
            continue;
          }
        }
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          log.warn(
            { status: res.status, body: body.slice(0, 300), inputMint: params.inputMint, outputMint: params.outputMint, amount: params.amount.toString(), dexes: params.dexes, mode: env.JUPITER_QUOTE_MODE },
            "Jupiter /build error",
          );
          return null;
        }
        return (await res.json()) as BuildResponse;
      } catch (error) {
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        log.warn({ error: String(error).slice(0, 100) }, "Jupiter /build fetch failed");
        return null;
      }
    }
    return null;
  });
}

/** Convert decimal ratio priceImpactPct to basis points */
export function priceImpactToBps(priceImpactPct: string): number {
  return Math.round(Number(priceImpactPct) * 10_000);
}

export interface PriceV3Entry {
  usdPrice: number;
  blockId: number;
  decimals: number;
}

/** Fetch token prices from Jupiter Price API v3 */
export async function getPricesUsd(mints: string[]): Promise<Record<string, PriceV3Entry>> {
  if (mints.length === 0) return {};
  return priceLimiter.schedule(async () => {
    const url = new URL(`${BASE_URL}/price/v3`);
    url.searchParams.set("ids", mints.join(","));
    try {
      const res = await fetch(url, { headers: headers() });
      if (!res.ok) return {};
      return (await res.json()) as Record<string, PriceV3Entry>;
    } catch {
      return {};
    }
  });
}
