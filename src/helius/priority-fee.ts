import { VersionedTransaction } from "@solana/web3.js";
import { env } from "../config/env";
import { log } from "../utils/logger";

/**
 * Estimate priority fee via Helius getPriorityFeeEstimate.
 * Returns microlamports per compute unit.
 *
 * Uses the serialized transaction method (Helius-recommended) when a candidate
 * TX is provided, falling back to account-key estimation otherwise.
 */
export async function getPriorityFee(
  apiKey: string,
  candidateTx?: VersionedTransaction,
): Promise<number> {
  const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

  let params: Record<string, unknown>;

  if (candidateTx) {
    const serialized = candidateTx.serialize();
    const base64Tx = Buffer.from(serialized).toString("base64");
    params = {
      transaction: base64Tx,
      options: {
        priorityLevel: env.PRIORITY_FEE_LEVEL,
        transactionEncoding: "Base64",
      },
    };
  } else {
    params = {
      accountKeys: ["11111111111111111111111111111112"],
      options: {
        priorityLevel: env.PRIORITY_FEE_LEVEL,
      },
    };
  }

  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getPriorityFeeEstimate",
    params: [params],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = (await res.json()) as {
    result?: { priorityFeeEstimate?: number; priorityFeeLevels?: Record<string, number> };
    error?: { message: string };
  };

  if (json.error) {
    throw new Error(`Priority fee API error: ${json.error.message}`);
  }

  const estimate = json.result?.priorityFeeEstimate;
  if (typeof estimate !== "number" || estimate <= 0) {
    throw new Error(`Invalid priority fee estimate: ${JSON.stringify(json.result)}`);
  }

  log.debug(
    { estimate, level: env.PRIORITY_FEE_LEVEL, method: candidateTx ? "transaction" : "accountKeys" },
    "Priority fee estimated",
  );
  return estimate;
}
