import {
  TransactionInstruction,
  PublicKey,
} from "@solana/web3.js";
import type { JupiterBuildResponse } from "./quote";
import { log } from "../utils/logger";

export interface JupiterInstructionSet {
  computeBudgetIxs: TransactionInstruction[];
  setupIxs: TransactionInstruction[];
  otherIxs: TransactionInstruction[];
  swapIx: TransactionInstruction;
  cleanupIx: TransactionInstruction | null;
  tipIx: TransactionInstruction | null;
}

/** Decode a Jupiter instruction (base64 data + account metas) into a Solana TransactionInstruction */
export function decodeInstruction(ix: { programId: string; accounts: Array<{ pubkey: string; isWritable: boolean; isSigner: boolean }>; data: string }): TransactionInstruction {
  const programId = new PublicKey(ix.programId);
  const keys = ix.accounts.map((acc) => ({
    pubkey: new PublicKey(acc.pubkey),
    isSigner: acc.isSigner,
    isWritable: acc.isWritable,
  }));

  let data: Buffer;
  try {
    data = Buffer.from(ix.data, "base64");
  } catch {
    log.warn({ programId: ix.programId, dataLen: ix.data?.length }, "Failed to decode instruction data, using empty buffer");
    data = Buffer.alloc(0);
  }

  return new TransactionInstruction({ programId, keys, data });
}

/** Extract ALL instructions from a Jupiter /swap/v2/build response */
export function extractInstructions(build: JupiterBuildResponse): JupiterInstructionSet {
  const computeBudgetIxs = build.computeBudgetInstructions.map(decodeInstruction);
  const setupIxs = build.setupInstructions.map(decodeInstruction);
  const otherIxs = (build.otherInstructions ?? []).map(decodeInstruction);
  const swapIx = decodeInstruction(build.swapInstruction);
  const cleanupIx = build.cleanupInstruction ? decodeInstruction(build.cleanupInstruction) : null;
  const tipIx = build.tipInstruction ? decodeInstruction(build.tipInstruction) : null;

  return { computeBudgetIxs, setupIxs, otherIxs, swapIx, cleanupIx, tipIx };
}

/** Get lookup table addresses from a build response */
export function getLookupTableAddresses(build: JupiterBuildResponse): string[] {
  if (!build.addressesByLookupTableAddress) return [];
  return Object.keys(build.addressesByLookupTableAddress);
}

/** Merge lookup tables from multiple quotes (deduplicated) */
export function mergeLookupTables(...builds: JupiterBuildResponse[]): string[] {
  const all = new Set<string>();
  for (const build of builds) {
    for (const addr of getLookupTableAddresses(build)) {
      all.add(addr);
    }
  }
  return Array.from(all);
}
