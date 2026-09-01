import {
  VersionedTransaction,
  TransactionInstruction,
  SystemProgram,
  PublicKey,
  Connection,
} from "@solana/web3.js";
import { getKeypair } from "./client";
import { env } from "../config/env";
import { log } from "../utils/logger";
import { SENDER_TIP_ACCOUNTS } from "../config/constants";

export type SenderMode = "max" | "swqos";

const MIN_TIP_BY_MODE: Record<SenderMode, number> = {
  max: 1_000_000,
  swqos: 5_000,
};

/**
 * Select a Sender tip account deterministically per candidate.
 */
export function selectTipAccount(seed?: number): PublicKey {
  const index = seed !== undefined
    ? Math.abs(seed) % SENDER_TIP_ACCOUNTS.length
    : Math.floor(Math.random() * SENDER_TIP_ACCOUNTS.length);
  return SENDER_TIP_ACCOUNTS[index]!;
}

/**
 * Build a tip instruction (SOL transfer to a specific Sender tip account).
 */
export function buildSenderTipIx(tipLamports: number, tipAccount?: PublicKey): TransactionInstruction {
  const payer = getKeypair().publicKey;
  const account = tipAccount ?? selectTipAccount();
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: account,
    lamports: tipLamports,
  });
}

/**
 * Send a transaction via Helius Sender for MEV-protected, fast landing.
 */
export async function sendViaSender(tx: VersionedTransaction): Promise<string> {
  const mode: SenderMode = env.SENDER_MODE;
  const url = mode === "swqos"
    ? "https://sender.helius-rpc.com/fast?swqos_only=true"
    : "https://sender.helius-rpc.com/fast";

  const raw = tx.serialize();
  const encodedTx = Buffer.from(raw).toString("base64");

  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "sendTransaction",
    params: [
      encodedTx,
      {
        encoding: "base64",
        skipPreflight: true,
        maxRetries: 0,
      },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = (await res.json()) as {
    result?: string;
    error?: { message: string };
  };

  if (json.error) {
    throw new Error(`Helius Sender error: ${json.error.message}`);
  }

  const sig = json.result;
  if (!sig) {
    throw new Error("Helius Sender returned no signature");
  }

  log.info({ sig }, "Transaction sent via Helius Sender");
  return sig;
}

/**
 * Estimate competitive Sender tip in lamports.
 * Tip = max(minimum, X% of expected profit).
 */
export function estimateSenderTip(
  _priorityFeeMicroLamports: number,
  estimatedProfitSol?: number,
): number {
  const mode: SenderMode = env.SENDER_MODE;
  const MIN_TIP_LAMPORTS = MIN_TIP_BY_MODE[mode];
  const MAX_TIP_LAMPORTS = env.MAX_SENDER_TIP_LAMPORTS;
  const TIP_PROFIT_PCT = env.MAX_TIP_PROFIT_PCT;

  let tip = MIN_TIP_LAMPORTS;

  if (estimatedProfitSol && estimatedProfitSol > 0) {
    const profitLamports = Math.round(estimatedProfitSol * 1e9);
    if (profitLamports > MIN_TIP_LAMPORTS) {
      const profitBased = Math.round(profitLamports * (TIP_PROFIT_PCT / 100));
      tip = Math.max(tip, profitBased);
    }
  }

  tip = Math.max(MIN_TIP_LAMPORTS, Math.min(tip, MAX_TIP_LAMPORTS));

  log.debug(
    {
      tipLamports: tip,
      tipSol: (tip / 1e9).toFixed(6),
      senderMode: mode,
      minTipSol: (MIN_TIP_LAMPORTS / 1e9).toFixed(6),
      profitSol: estimatedProfitSol,
      tipProfitPct: TIP_PROFIT_PCT,
    },
    "Sender tip estimated",
  );
  return tip;
}

/**
 * Confirm a transaction signature with polling.
 */
export async function confirmSignature(
  connection: Connection,
  signature: string,
  timeoutMs = 45_000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
    const value = status.value;
    if (value?.err) return false;
    if (value?.confirmationStatus === "confirmed" || value?.confirmationStatus === "finalized") return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/**
 * Get realized PnL from an on-chain transaction.
 * Calculates token delta (profit mint) + native SOL delta (fees + tip).
 */
export async function getTransactionPnlUsd(
  connection: Connection,
  signature: string,
  payer: PublicKey,
  profitMint: string,
  profitTokenPriceUsd: number,
  profitTokenDecimals: number,
  solPriceUsd: number,
): Promise<number | null> {
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx?.meta) return null;

  const owner = payer.toBase58();
  let preToken = 0n;
  let postToken = 0n;
  for (const b of tx.meta.preTokenBalances ?? []) {
    if (b.owner === owner && b.mint === profitMint) preToken += BigInt(b.uiTokenAmount.amount);
  }
  for (const b of tx.meta.postTokenBalances ?? []) {
    if (b.owner === owner && b.mint === profitMint) postToken += BigInt(b.uiTokenAmount.amount);
  }

  const tokenDelta = postToken - preToken;
  const tokenUsd = (Number(tokenDelta) / 10 ** profitTokenDecimals) * profitTokenPriceUsd;

  const accountIndex = tx.transaction.message.staticAccountKeys.findIndex((k) => k.equals(payer));
  let nativeDeltaUsd = 0;
  if (accountIndex >= 0) {
    const pre = tx.meta.preBalances[accountIndex] ?? 0;
    const post = tx.meta.postBalances[accountIndex] ?? 0;
    nativeDeltaUsd = ((post - pre) / 1e9) * solPriceUsd;
  }

  return tokenUsd + nativeDeltaUsd;
}
