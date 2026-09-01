import { Bot } from "gramio";
import { convert } from "telegram-markdown-v2";
import { env } from "./config/env";
import { log } from "./utils/logger";

// ── Icons ────────────────────────────────────────────────────────────────────

const ICONS = {
  start: "\u{1F680}",
  scan: "\u{1F50D}",
  opportunity: "\u{1F4B0}",
  simulate: "\u{1F9EE}",
  trade: "\u{2705}",
  error: "\u{274C}",
  warning: "\u{26A0}\u{FE0F}",
  info: "\u{2139}\u{FE0F}",
  status: "\u{1F4CA}",
  shutdown: "\u{1F6D1}",
  divider: "\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}",
} as const;

// ── Markdown Helper ──────────────────────────────────────────────────────────

function toMd(markdown: string): string {
  return convert(markdown, "escape");
}

// ── Message Formatters ───────────────────────────────────────────────────────

function fmtStartup(mode: string, config: Record<string, unknown>): string {
  return toMd(`
${ICONS.start} *Sol Arb Bot \u{2014} Online*

${ICONS.divider}

${ICONS.info} *Mode:* \`${mode}\`
${ICONS.info} *Max Trade:* \`${config.maxTradeUsdc}\` USDC
${ICONS.info} *Min Profit:* \`${config.minProfitBps}\` bps
${ICONS.info} *Flash Loan:* \`${config.flashLoanProvider}\`
${ICONS.info} *Event Stream:* \`${config.eventsEnabled ? "Active" : "Disabled"}\`

${ICONS.divider}
`);
}

function fmtOpportunity(opp: {
  path: string[];
  dexesUsed: string[];
  grossProfitBps: number;
  grossProfitUsdc: number;
}): string {
  return toMd(`
${ICONS.opportunity} *Arb Opportunity Detected*

${ICONS.divider}

${ICONS.info} *Route:* \`${opp.path.join(" \u{2192} ")}\`
${ICONS.info} *Venues:* \`${opp.dexesUsed.join(" | ")}\`
${ICONS.info} *Gross:* \`${opp.grossProfitBps}\` bps \u{2022} \`${opp.grossProfitUsdc.toFixed(4)}\` USDC

${ICONS.divider}
`);
}

function fmtSimulation(r: {
  wouldTrade: boolean;
  grossProfitUsdc: number;
  netProfitUsdc: number;
  priorityFeeUsdc: number;
  tipUsdc: number;
  baseFeeUsdc: number;
  cuUsed: number;
  txSizeBytes: number;
}): string {
  const status = r.wouldTrade ? "\u{2705} Profitable" : "\u{274C} Not Profitable";
  const totalFees = r.priorityFeeUsdc + r.tipUsdc + r.baseFeeUsdc;

  return toMd(`
${ICONS.simulate} *Simulation Report*

${ICONS.divider}

${ICONS.info} *Status:* ${status}
${ICONS.info} *Gross:* \`${r.grossProfitUsdc.toFixed(6)}\` USDC
${ICONS.info} *Net:* \`${r.netProfitUsdc.toFixed(6)}\` USDC
${ICONS.info} *Total Fees:* \`${totalFees.toFixed(6)}\` USDC

${ICONS.divider}

\u{1F4B3} *Fee Breakdown*
\u{2022} Priority: \`${r.priorityFeeUsdc.toFixed(6)}\` USDC
\u{2022} Tip: \`${r.tipUsdc.toFixed(6)}\` USDC
\u{2022} Base: \`${r.baseFeeUsdc.toFixed(6)}\` USDC

\u{2699}\u{FE0F} *Compute*
\u{2022} CU: \`${r.cuUsed.toLocaleString()}\`
\u{2022} Size: \`${r.txSizeBytes}\` bytes

${ICONS.divider}
`);
}

function fmtStatus(s: {
  uptime: string;
  totalScans: number;
  totalOpportunities: number;
  totalTrades: number;
  simulatedProfitUsdc: number;
}): string {
  return toMd(`
${ICONS.status} *Status Report*

${ICONS.divider}

${ICONS.info} *Uptime:* \`${s.uptime}\`
${ICONS.info} *Scans:* \`${s.totalScans}\`
${ICONS.info} *Opportunities:* \`${s.totalOpportunities}\`
${ICONS.info} *Simulated Trades:* \`${s.totalTrades}\`
${ICONS.info} *Simulated PnL:* \`${s.simulatedProfitUsdc.toFixed(4)}\` USDC

${ICONS.divider}
`);
}

function fmtShutdown(reason: string): string {
  return toMd(`
${ICONS.shutdown} *Bot Stopped*

${ICONS.divider}

${ICONS.info} *Reason:* \`${reason}\`

${ICONS.divider}
`);
}

// ── Bot singleton ────────────────────────────────────────────────────────────

let bot: Bot | null = null;

export async function initTelegram(): Promise<void> {
  if (!env.BOT_TOKEN || !env.CHAT_ID) {
    log.info("Telegram disabled \u{2014} no BOT_TOKEN or CHAT_ID");
    return;
  }
  try {
    bot = new Bot(env.BOT_TOKEN);
    const me = await bot.api.getMe();
    log.info({ username: me.username }, "Telegram connected");
  } catch (err) {
    log.warn({ error: String(err) }, "Telegram connection failed \u{2014} notifications disabled");
    bot = null;
  }
}

async function send(text: string): Promise<void> {
  if (!bot || !env.CHAT_ID) return;
  try {
    await bot.api.sendMessage({
      chat_id: env.CHAT_ID,
      text,
      parse_mode: "MarkdownV2",
    });
  } catch (err) {
    log.debug({ error: String(err) }, "Telegram send failed");
  }
}

export async function tgStartup(config: Record<string, unknown>): Promise<void> {
  await send(fmtStartup(env.MODE, config));
}

export async function tgOpportunity(opp: {
  path: string[];
  dexesUsed: string[];
  grossProfitBps: number;
  grossProfitUsdc: number;
}): Promise<void> {
  await send(fmtOpportunity(opp));
}

export async function tgSimulation(r: {
  wouldTrade: boolean;
  grossProfitUsdc: number;
  netProfitUsdc: number;
  priorityFeeUsdc: number;
  tipUsdc: number;
  baseFeeUsdc: number;
  cuUsed: number;
  txSizeBytes: number;
}): Promise<void> {
  await send(fmtSimulation(r));
}

export async function tgStatus(s: {
  uptime: string;
  totalScans: number;
  totalOpportunities: number;
  totalTrades: number;
  simulatedProfitUsdc: number;
}): Promise<void> {
  await send(fmtStatus(s));
}

export async function tgShutdown(reason: string): Promise<void> {
  await send(fmtShutdown(reason));
}

export async function stopTelegram(): Promise<void> {
  if (bot) {
    await bot.stop();
    bot = null;
  }
}
