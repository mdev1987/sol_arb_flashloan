import { Bot } from "gramio";
import { convert } from "telegram-markdown-v2";
import { env } from "./config/env";
import { log } from "./utils/logger";

// ── Icons ────────────────────────────────────────────────────────────────────

const ICONS = {
  start: "🚀",
  scan: "🔍",
  opportunity: "💰",
  simulate: "📊",
  trade: "✅",
  error: "❌",
  warning: "⚠️",
  info: "ℹ️",
  status: "📈",
  shutdown: "🛑",
} as const;

// ── Markdown Helper ──────────────────────────────────────────────────────────

function toMd(markdown: string): string {
  return convert(markdown, "escape");
}

// ── Message Formatters ───────────────────────────────────────────────────────

function fmtStartup(mode: string, config: Record<string, unknown>): string {
  return toMd(`
${ICONS.start} *Bot Started*

${ICONS.info} *Mode:* \`${mode}\`
${ICONS.info} *Max Trade:* \`${config.maxTradeUsdc}\` USDC
${ICONS.info} *Min Profit:* \`${config.minProfitBps}\` bps
${ICONS.info} *Flash Loan:* \`${config.flashLoanProvider}\`
${ICONS.info} *Events:* \`${config.eventsEnabled ? "ON" : "OFF"}\`
`);
}

function fmtOpportunity(opp: {
  path: string[];
  dexesUsed: string[];
  grossProfitBps: number;
  grossProfitUsdc: number;
}): string {
  return toMd(`
${ICONS.opportunity} *Arbitrage Opportunity*

${ICONS.info} *Path:* \`${opp.path.join(" → ")}\`
${ICONS.info} *DEXes:* \`${opp.dexesUsed.join(", ")}\`
${ICONS.info} *Gross Profit:* \`${opp.grossProfitBps}\` bps (\`${opp.grossProfitUsdc.toFixed(4)}\` USDC)
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
  const icon = r.wouldTrade ? "✅" : "❌";
  return toMd(`
${ICONS.simulate} *Simulation Result*

${icon} *Would Trade:* \`${r.wouldTrade ? "YES" : "NO"}\`
${ICONS.info} *Gross Profit:* \`${r.grossProfitUsdc.toFixed(6)}\` USDC
${ICONS.info} *Net Profit:* \`${r.netProfitUsdc.toFixed(6)}\` USDC
${ICONS.info} *Priority Fee:* \`${r.priorityFeeUsdc.toFixed(6)}\` USDC
${ICONS.info} *Tip:* \`${r.tipUsdc.toFixed(6)}\` USDC
${ICONS.info} *Base Fee:* \`${r.baseFeeUsdc.toFixed(6)}\` USDC
${ICONS.info} *CU Used:* \`${r.cuUsed.toLocaleString()}\`
${ICONS.info} *TX Size:* \`${r.txSizeBytes}\` bytes
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
${ICONS.status} *Bot Status*

${ICONS.info} *Uptime:* \`${s.uptime}\`
${ICONS.info} *Total Scans:* \`${s.totalScans}\`
${ICONS.info} *Opportunities:* \`${s.totalOpportunities}\`
${ICONS.info} *Trades:* \`${s.totalTrades}\`
${ICONS.info} *Simulated Profit:* \`${s.simulatedProfitUsdc.toFixed(4)}\` USDC
`);
}

function fmtShutdown(reason: string): string {
  return toMd(`
${ICONS.shutdown} *Bot Stopped*

${ICONS.info} *Reason:* \`${reason}\`
`);
}

// ── Bot singleton ────────────────────────────────────────────────────────────

let bot: Bot | null = null;

export async function initTelegram(): Promise<void> {
  if (!env.BOT_TOKEN || !env.CHAT_ID) {
    log.info("Telegram disabled — no BOT_TOKEN or CHAT_ID");
    return;
  }
  try {
    bot = new Bot(env.BOT_TOKEN);
    const me = await bot.api.getMe();
    log.info({ username: me.username }, "Telegram connected");
  } catch (err) {
    log.warn({ error: String(err) }, "Telegram connection failed — notifications disabled");
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
