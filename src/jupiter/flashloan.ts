import { TransactionInstruction, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { getConnection, getKeypair } from "../helius/client";
import { USDC_MINT, SOL_MINT } from "../config/constants";
import { log } from "../utils/logger";
import { env } from "../config/env";

export interface FlashLoanPlan {
  provider: string;
  borrowIx: TransactionInstruction;
  repayIx: TransactionInstruction;
  borrowedMint: PublicKey;
  borrowedAmount: bigint;
  feeAmount: bigint;
}

/**
 * Jupiter Lend flash-loan adapter.
 * Returns SEPARATE borrowIx and repayIx per official Jupiter docs.
 * STRICT: throws if borrowIx/repayIx are not explicitly provided.
 */
export async function getFlashLoanIx(
  mint: PublicKey,
  amount: bigint,
  signer: PublicKey,
): Promise<FlashLoanPlan | null> {
  if (env.FLASH_LOAN_PROVIDER === "none") return null;
  if (env.FLASH_LOAN_PROVIDER !== "jupiter") {
    throw new Error(`Unsupported flash loan provider: ${env.FLASH_LOAN_PROVIDER}`);
  }

  const connection = getConnection();
  const lend = await import("@jup-ag/lend/flashloan");
  const bnAmount = new BN(amount.toString());

  log.info(
    { provider: "jupiter-lend", asset: mint.toBase58(), amount: amount.toString() },
    "Requesting flash loan instructions",
  );

  const result = await lend.getFlashloanIx({
    connection,
    signer,
    asset: mint,
    amount: bnAmount,
  });

  if (!result?.borrowIx || !result?.paybackIx) {
    throw new Error(
      `Jupiter Lend did not return explicit borrowIx/paybackIx. Got keys: ${Object.keys(result ?? {}).join(", ")}.`,
    );
  }

  log.info({ fee: 0, provider: "jupiter-lend" }, "Flash loan instructions received");

  return {
    provider: "jupiter",
    borrowIx: result.borrowIx,
    repayIx: result.paybackIx,
    borrowedMint: mint,
    borrowedAmount: amount,
    feeAmount: 0n,
  };
}
