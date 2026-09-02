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
import { sendViaSender, confirmSignature, getTransactionPnlUsd } from "./helius/sender";
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

// Event debounce: trigger scan immediately but coalesce rapid events within this window.
// This replaces the old POLL_INTERVAL_MS delay which added ~5s latency to event-driven scans.
const EVENT_DEBOUNCE_MS = 200;

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
  // Debounce rapid events: if an event arrived within the debounce window, skip.
  if (now - lastEventScan < EVENT_DEBOUNCE_MS) return;
  if (eventTimer) return;

  eventTimer = setTimeout(() => {
    eventTimer = null;
    lastEventScan = Date.now();
    void runScan("event");
  }, EVENT_DEBOUNCE_MS);
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

  // Mode dispatch
  if (state.mode === "SIMULATE") {
    state.simulatedProfit += usdcToBigInt(sim.netProfitUsd);

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
    state.simulatedProfit += usdcToBigInt(sim.netProfitUsd);

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

  // LIVE mode — execute via Helius Sender with safeguards
  if (state.mode === "LIVE") {
    // Pre-send safeguard: fresh balance check (with retry for transient RPC errors)
    const connection = getConnection();
    const keypair = getKeypair();
    let balance = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        balance = await connection.getBalance(keypair.publicKey);
        break;
      } catch (balErr) {
        if (attempt === 3) {
          log.warn({ error: String(balErr).slice(0, 100) }, "LIVE: balance check failed after retries — skipping");
          return;
        }
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    const minReserveLamports = Math.round(env.MIN_SOL_RESERVE * 1e9);
    if (balance < minReserveLamports + sim.totalCostLamports) {
      log.warn(
        {
          balanceSol: (balance / 1e9).toFixed(4),
          requiredSol: ((minReserveLamports + sim.totalCostLamports) / 1e9).toFixed(4),
        },
        "LIVE: insufficient balance for base fee + tip — skipping",
      );
      return;
    }

    // Pre-send safeguard: reject if pipeline took too long (opportunity may be stale)
    const maxPipelineMs = 5_000;
    if (sim.pipelineDurationMs && sim.pipelineDurationMs > maxPipelineMs) {
      log.warn(
        { pipelineMs: sim.pipelineDurationMs, maxMs: maxPipelineMs },
        "LIVE: pipeline too slow — opportunity likely stale, skipping",
      );
      return;
    }

    // Pre-send safeguard: fresh quote age at submission
    // The fresh quote should be very recent — if more than 1.5s elapsed since
    // the fresh quote, market may have moved and the simulation is no longer valid.
    const maxFreshAgeMs = 1_500;
    if (sim.freshQuotedAt && Date.now() - sim.freshQuotedAt > maxFreshAgeMs) {
      log.warn(
        { freshAgeMs: Date.now() - sim.freshQuotedAt, maxMs: maxFreshAgeMs },
        "LIVE: fresh quote too old at submission — skipping",
      );
      return;
    }

    try {
      const sendStart = Date.now();
      const sig = await sendViaSender(sim.finalTx);
      const sendMs = Date.now() - sendStart;

      log.info({ sig, sendMs, pipelineMs: sim.pipelineDurationMs }, "LIVE: transaction sent via Helius Sender");

      // Confirm with timeout
      const confirmed = await confirmSignature(connection, sig, 45_000);
      const confirmMs = Date.now() - sendStart;

      if (!confirmed) {
        log.warn({ sig, confirmMs }, "LIVE: transaction failed or timed out");
        return;
      }

      // Reconcile actual PnL using correct profit token price and decimals
      const realizedPnlUsd = await getTransactionPnlUsd(
        connection,
        sig,
        keypair.publicKey,
        sim.opportunity.profitMint,
        sim.profitMintPriceUsd ?? 0,
        sim.profitMintDecimals ?? 6,
        sim.solPriceUsd ?? 0,
      );

      // Only count as a real trade AFTER confirmation
      state.totalTrades++;
      state.realizedProfit += usdcToBigInt(realizedPnlUsd ?? 0);
      state.expectedProfit += usdcToBigInt(sim.netProfitUsd);

      log.info(
        {
          sig,
          sendMs,
          confirmMs,
          pipelineMs: sim.pipelineDurationMs,
          netEstUsd: sim.netProfitUsd.toFixed(4),
          realizedUsd: realizedPnlUsd?.toFixed(4) ?? "unknown",
        },
        "LIVE: trade completed",
      );
    } catch (error) {
      log.error({ error: String(error).slice(0, 200) }, "LIVE: execution failed");
    }
  }
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
  log.info(`  Solana Arbitrage Bot — ${state.mode} Mode`);
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

  // ── Test connection (with retry for transient RPC errors) ─────────────
  const connection = getConnection();
  const keypair = getKeypair();

  let slot = 0;
  let solBalance = 0;
  const MAX_RPC_RETRIES = 5;
  for (let attempt = 1; attempt <= MAX_RPC_RETRIES; attempt++) {
    try {
      slot = await connection.getSlot();
      solBalance = await connection.getBalance(keypair.publicKey);
      break;
    } catch (rpcError) {
      const isLast = attempt === MAX_RPC_RETRIES;
      const delayMs = Math.min(2000 * attempt, 30_000);
      log.warn(
        { attempt, maxRetries: MAX_RPC_RETRIES, delayMs, error: String(rpcError).slice(0, 120) },
        isLast ? "RPC connection failed — all retries exhausted" : "RPC connection failed — retrying",
      );
      if (isLast) {
        log.fatal("Cannot connect to Solana RPC after all retries — aborting");
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

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
    if (state.mode === "SIMULATE") {
      log.warn(
        {
          balanceSol: (solBalance / 1e9).toFixed(4),
          minReserveSol: env.MIN_SOL_RESERVE,
        },
        "Wallet SOL below operational reserve — simulation will continue but trades would fail.",
      );
    } else {
      // SHADOW and LIVE require sufficient SOL for fees
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

  // ── Jupiter connectivity test ────────────────────────────────────────
  try {
    const { getBuild } = await import("./jupiter/client");
    const testBuild = await getBuild({
      inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
      outputMint: "So11111111111111111111111111111111111111112", // wSOL
      amount: 1_000_000n, // 1 USDC
      taker: keypair.publicKey.toBase58(),
      slippageBps: 50,
    });
    if (testBuild) {
      log.info({ outAmount: testBuild.outAmount, route: testBuild.routePlan.map((s) => s.swapInfo.label).join(" -> ") }, "Jupiter API connectivity OK");
    } else {
      log.warn("Jupiter /build returned no route — API key or network issue? Scans will fail.");
    }
  } catch (jupErr) {
    log.warn({ error: String(jupErr).slice(0, 150) }, "Jupiter connectivity test failed — scans may not work");
  }

  // ── Initialize WSOL ATA once at startup ───────────────────────────────
  const wsolAta = getAssociatedTokenAddressSync(SOL_MINT, keypair.publicKey);
  const existingAta = await connection.getAccountInfo(wsolAta);
  if (!existingAta) {
    if (state.mode === "SIMULATE") {
      log.warn(
        { ata: wsolAta.toBase58() },
        "WSOL ATA missing — simulation will continue without creating it",
      );
    } else {
      // SHADOW and LIVE need the ATA for actual trading
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
        log.info({ ata: wsolAta.toBase58() }, "WSOL ATA created");
      } catch (err) {
        log.fatal({ error: String(err).slice(0, 120) }, "WSOL ATA creation failed — aborting startup");
        process.exit(1);
      }
    }
  } else {
    log.debug({ ata: wsolAta.toBase58() }, "WSOL ATA already exists");
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

  // Heartbeat: write to bot.log every 30s even if scans are idle (keeps oxfile health check happy)
  const heartbeat = setInterval(() => {
    log.debug({ uptime: ((Date.now() - state.startTime) / 1000 / 60).toFixed(1) + "m" }, "heartbeat");
  }, 30_000);

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
  clearInterval(heartbeat);
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
