import { VersionedTransaction, TransactionMessage, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { env } from "./config/env";
import { log } from "./utils/logger";
import { bigIntToUsdc, usdcToBigInt } from "./utils/bigint";
import { getConnection, getKeypair } from "./helius/client";
import { SOL_MINT } from "./config/constants";
import { HeliusDexStream } from "./helius/stream";
import { scanOnce } from "./arb/detector";
import { assertSafeToTrade } from "./arb/safety";
import { simulateOpportunity, logSimulationResult } from "./arb/simulate";
import { initTelegram, tgStartup, tgOpportunity, tgSimulation, tgStatus, tgShutdown, stopTelegram } from "./telegram";
import type { ArbOpportunity, BotState, SimulationResult } from "./market/types";

// ── Bot state ────────────────────────────────────────────────────────────────

const state: BotState = {
  mode: env.MODE,
  running: true,
  startTime: Date.now(),
  totalScans: 0,
  totalOpportunities: 0,
  totalTrades: 0,
  expectedProfit: 0n,
  simulatedProfit: 0n,
  realizedProfit: 0n,
  lastScanTime: 0,
};

// ── Graceful shutdown ────────────────────────────────────────────────────────

process.on("SIGINT", () => {
  log.info("Received SIGINT, shutting down...");
  state.running = false;
});

process.on("SIGTERM", () => {
  log.info("Received SIGTERM, shutting down...");
  state.running = false;
});

// ── Event coalescing ─────────────────────────────────────────────────────────

let scanInFlight = false;
let pendingScan = false;
let eventTimer: ReturnType<typeof setTimeout> | null = null;
let lastEventScan = 0;
const seen = new Map<string, number>();

function dedupeKey(opp: ArbOpportunity): string {
  return `${opp.path.join(":")}:${opp.inputAmount.toString()}:${opp.dexesUsed.join(",")}`;
}

function shouldHandle(opp: ArbOpportunity): boolean {
  const key = dedupeKey(opp);
  const lastSeen = seen.get(key);
  if (lastSeen && Date.now() - lastSeen < 5000) return false;
  seen.set(key, Date.now());
  return true;
}

function scheduleEventScan(): void {
  if (!state.running) return;
  const now = Date.now();
  if (now - lastEventScan < env.POLL_INTERVAL_MS) return;
  if (eventTimer) return;

  eventTimer = setTimeout(() => {
    eventTimer = null;
    lastEventScan = Date.now();
    void runScan("event");
  }, env.POLL_INTERVAL_MS);
}

// ── Scan + simulate pipeline ─────────────────────────────────────────────────

async function handleOpportunity(opp: ArbOpportunity): Promise<void> {
  if (!shouldHandle(opp)) return;

  state.totalOpportunities++;

  log.info(
    {
      path: opp.path.join(" -> "),
      inputUsdc: bigIntToUsdc(opp.inputAmount).toFixed(2),
      grossUsd: opp.profitUsd.toFixed(4),
      grossBps: opp.profitBps,
      dexes: opp.dexesUsed.join(", "),
      legs: opp.legs.length,
    },
    "Opportunity detected — simulating",
  );

  // Telegram: opportunity found
  void tgOpportunity({
    path: opp.path,
    dexesUsed: opp.dexesUsed,
    grossProfitBps: opp.profitBps,
    grossProfitUsdc: opp.profitUsd,
  });

  // Safety checks
  if (!assertSafeToTrade(opp)) return;

  // Two-stage simulation with full cost model
  const sim = await simulateOpportunity(opp);
  logSimulationResult(sim);

  // Telegram: simulation result
  if (sim.wouldSucceed && sim.finalTx) {
    const solUsd = sim.solPriceUsd ?? 0;
    void tgSimulation({
      wouldTrade: true,
      grossProfitUsdc: sim.grossProfitUsd,
      netProfitUsdc: sim.netProfitUsd,
      priorityFeeUsdc: (sim.priorityFeeLamports / 1e9) * solUsd,
      tipUsdc: (sim.tipLamports / 1e9) * solUsd,
      baseFeeUsdc: (sim.baseFeeLamports / 1e9) * solUsd,
      cuUsed: sim.unitsConsumed,
      txSizeBytes: sim.txBytes,
    });
  }

  if (!sim.wouldSucceed || !sim.finalTx) return;

  // Profit thresholds
  if (sim.netProfitUsd <= 0) {
    log.info({ netUsd: sim.netProfitUsd.toFixed(4) }, "Not profitable after costs — skipping");
    return;
  }
  if (sim.netProfitUsd < env.MIN_PROFIT_USDC) {
    log.info(
      { netUsd: sim.netProfitUsd.toFixed(4), minUsd: env.MIN_PROFIT_USDC },
      "Below minimum profit threshold — skipping",
    );
    return;
  }
  if (sim.netProfitBps < env.MIN_PROFIT_BPS) {
    log.info(
      { netBps: sim.netProfitBps.toFixed(2), minBps: env.MIN_PROFIT_BPS },
      "Below minimum BPS threshold — skipping",
    );
    return;
  }

  state.totalTrades++;
  state.simulatedProfit += usdcToBigInt(sim.netProfitUsd);
  state.expectedProfit += usdcToBigInt(sim.netProfitUsd);

  // Mode dispatch
  if (state.mode === "SIMULATE") {
    log.info(
      {
        netUsd: sim.netProfitUsd.toFixed(4),
        netBps: sim.netProfitBps.toFixed(2),
        CU: sim.unitsConsumed,
        tipSol: (sim.tipLamports / 1e9).toFixed(6),
        priorityFeeLamports: sim.priorityFeeLamports,
      },
      "SIMULATE: would trade (not executed)",
    );
  }

  if (state.mode === "SHADOW") {
    log.info(
      {
        netUsd: sim.netProfitUsd.toFixed(4),
        netBps: sim.netProfitBps.toFixed(2),
        CU: sim.unitsConsumed,
        tipSol: (sim.tipLamports / 1e9).toFixed(6),
        txBytes: sim.txBytes,
      },
      "SHADOW: would submit via Helius Sender (not executed)",
    );
  }

  // LIVE mode — not compiled in for safety
  // When ready to enable live trading:
  // 1. Change env MODE enum to include "LIVE"
  // 2. Add LIVE case here: sendViaSender(sim.finalTx) → confirmTransaction → getTransactionPnlUsd
}

async function runScan(reason: string): Promise<void> {
  if (scanInFlight) {
    pendingScan = true;
    return;
  }

  scanInFlight = true;
  try {
    state.totalScans++;
    state.lastScanTime = Date.now();

    const taker = getKeypair().publicKey.toBase58();
    const opportunities = await scanOnce(taker);

    if (opportunities.length > 0) {
      log.info({ count: opportunities.length, reason }, "Scan found opportunities");
      for (const opp of opportunities) {
        await handleOpportunity(opp);
      }
    } else {
      log.debug({ scan: state.totalScans, reason }, "Scan: no opportunities");
    }
  } catch (error) {
    state.lastError = String(error);
    log.error({ error: state.lastError, scan: state.totalScans, reason }, "Scan error");
  } finally {
    scanInFlight = false;
    if (pendingScan) {
      pendingScan = false;
      void runScan("coalesced");
    }
  }
}

// ── Status logging ───────────────────────────────────────────────────────────

function logStatus(): void {
  const uptime = ((Date.now() - state.startTime) / 1000 / 60).toFixed(1);
  log.info(
    {
      uptime: uptime + "m",
      scans: state.totalScans,
      opportunities: state.totalOpportunities,
      trades: state.totalTrades,
      expectedUsdc: bigIntToUsdc(state.expectedProfit).toFixed(4),
      simulatedUsdc: bigIntToUsdc(state.simulatedProfit).toFixed(4),
      realizedUsdc: bigIntToUsdc(state.realizedProfit).toFixed(4),
      mode: state.mode,
    },
    "Bot status",
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log.info("═══════════════════════════════════════════════════════════════");
  log.info("  Solana Arbitrage Bot — Simulation Mode");
  log.info("═══════════════════════════════════════════════════════════════");
  log.info(
    {
      mode: state.mode,
      senderMode: env.SENDER_MODE,
      maxCu: env.MAX_COMPUTE_UNITS,
      flashLoan: env.FLASH_LOAN_PROVIDER,
      events: env.EVENTS_ENABLED,
      dexPairs: env.DEX_PAIRS || "(all built-in pairs)",
    },
    "Bot configuration",
  );

  // ── Telegram ─────────────────────────────────────────────────────────
  await initTelegram();
  void tgStartup({
    maxTradeUsdc: env.MAX_TRADE_USDC,
    minProfitBps: env.MIN_PROFIT_BPS,
    flashLoanProvider: env.FLASH_LOAN_PROVIDER,
    eventsEnabled: env.EVENTS_ENABLED,
  });

  // ── Test connection ───────────────────────────────────────────────────
  const connection = getConnection();
  const keypair = getKeypair();

  const slot = await connection.getSlot();
  const solBalance = await connection.getBalance(keypair.publicKey);

  log.info(
    {
      slot,
      wallet: keypair.publicKey.toBase58(),
      balanceSol: (solBalance / 1e9).toFixed(4),
    },
    "Connected to Solana",
  );

  // ── SOL reserve check ─────────────────────────────────────────────────
  const minReserveLamports = Math.round(env.MIN_SOL_RESERVE * 1e9);
  if (solBalance < minReserveLamports) {
    if (env.MODE === "SIMULATE") {
      log.warn(
        {
          balanceSol: (solBalance / 1e9).toFixed(4),
          minReserveSol: env.MIN_SOL_RESERVE,
        },
        "Wallet SOL below operational reserve — simulation will continue but trades would fail.",
      );
    } else {
      log.fatal(
        {
          balanceSol: (solBalance / 1e9).toFixed(4),
          minReserveSol: env.MIN_SOL_RESERVE,
        },
        "Wallet SOL below operational reserve — cannot cover base fee + priority fee + tip. Fund wallet.",
      );
      process.exit(1);
    }
  }

  // ── Initialize WSOL ATA once at startup ───────────────────────────────
  const wsolAta = getAssociatedTokenAddressSync(SOL_MINT, keypair.publicKey);
  try {
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      keypair.publicKey, wsolAta, keypair.publicKey, SOL_MINT,
    );
    const { blockhash } = await connection.getLatestBlockhash("processed");
    const ataMsg = new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ataIx],
    }).compileToV0Message();
    const ataTx = new VersionedTransaction(ataMsg);
    ataTx.sign([keypair]);
    const sig = await connection.sendRawTransaction(ataTx.serialize(), { skipPreflight: true });
    await connection.confirmTransaction(sig, "confirmed");
    log.info({ ata: wsolAta.toBase58() }, "WSOL ATA initialized");
  } catch (err) {
    log.debug({ error: String(err).slice(0, 80) }, "WSOL ATA init skipped (may already exist)");
  }

  // ── WebSocket event stream ────────────────────────────────────────────
  let stream: HeliusDexStream | null = null;
  if (env.EVENTS_ENABLED) {
    stream = new HeliusDexStream(() => scheduleEventScan());
    stream.connect();
  }

  // ── Main loop ─────────────────────────────────────────────────────────
  log.info({ pollIntervalMs: env.POLL_INTERVAL_MS }, "Starting main loop");

  let scanCount = 0;
  let statusCounter = 0;

  while (state.running) {
    scanCount++;
    void runScan("poll");
    statusCounter++;

    if (statusCounter % 10 === 0) {
      logStatus();
      void tgStatus({
        uptime: ((Date.now() - state.startTime) / 1000 / 60).toFixed(1) + "m",
        totalScans: state.totalScans,
        totalOpportunities: state.totalOpportunities,
        totalTrades: state.totalTrades,
        simulatedProfitUsdc: bigIntToUsdc(state.simulatedProfit),
      });
    }

    await new Promise((r) => setTimeout(r, env.POLL_INTERVAL_MS));
  }

  // ── Shutdown ──────────────────────────────────────────────────────────
  stream?.close();
  if (eventTimer) clearTimeout(eventTimer);
  logStatus();
  void tgShutdown("SIGINT/SIGTERM");
  await stopTelegram();
  log.info("Bot stopped");
}

main().catch((error) => {
  log.fatal({ error: String(error) }, "Fatal error");
  process.exit(1);
});
