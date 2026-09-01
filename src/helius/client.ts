import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { env } from "../config/env";
import { log } from "../utils/logger";

let _connection: Connection | null = null;
let _keypair: Keypair | null = null;

/** Primary RPC connection to Helius */
export function getConnection(): Connection {
  if (!_connection) {
    const url = `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
    _connection = new Connection(url, {
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 30_000,
    });
    log.info("Helius RPC connection created");
  }
  return _connection;
}

/**
 * Load wallet keypair from env PRIVATE_KEY (base58).
 * If PRIVATE_KEY is empty, generates a throwaway keypair for simulation.
 */
export function getKeypair(): Keypair {
  if (!_keypair) {
    if (env.PRIVATE_KEY) {
      _keypair = Keypair.fromSecretKey(Buffer.from(bs58.decode(env.PRIVATE_KEY)));
      log.info({ pubkey: _keypair.publicKey.toBase58() }, "Wallet loaded from PRIVATE_KEY");
    } else {
      _keypair = Keypair.generate();
      log.info({ pubkey: _keypair.publicKey.toBase58() }, "Generated throwaway keypair for simulation");
    }
  }
  return _keypair;
}

/**
 * Confirm a transaction signature.
 * Checks for BOTH confirmation status AND execution errors.
 */
export async function confirmTransaction(
  sig: string,
  timeoutMs = 60_000,
): Promise<boolean> {
  const connection = getConnection();
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const status = await connection.getSignatureStatus(sig);
    const value = status?.value;

    if (value) {
      if (value.err) {
        log.error({ sig, err: value.err }, "Transaction execution failed");
        return false;
      }

      if (
        value.confirmationStatus === "confirmed" ||
        value.confirmationStatus === "finalized"
      ) {
        log.info({ sig, status: value.confirmationStatus }, "Transaction confirmed");
        return true;
      }
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  log.warn({ sig }, "Transaction confirmation timed out");
  return false;
}
