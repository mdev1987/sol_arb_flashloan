import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  HELIUS_API_KEY: z.string().min(1),
  JUPITER_API_KEY: z.string().min(1),
  PRIVATE_KEY: z.string().default(""),

  MODE: z.enum(["SIMULATE", "SHADOW"]).default("SIMULATE"),
  MAX_TRADE_USDC: z.coerce.number().positive().default(500),
  MIN_PROFIT_BPS: z.coerce.number().nonnegative().default(10),
  MIN_PROFIT_USDC: z.coerce.number().nonnegative().default(0.5),
  MAX_SLIPPAGE_BPS: z.coerce.number().positive().default(100),
  JUPITER_QUOTE_MODE: z.literal("fast").default("fast"),
  JUPITER_RTSE: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  POLL_INTERVAL_MS: z.coerce.number().positive().default(5000),
  MAX_TX_BYTES: z.coerce.number().min(900).max(1232).default(1232),
  MAX_COMPUTE_UNITS: z.coerce.number().positive().default(1_400_000),
  CU_MARGIN_BPS: z.coerce.number().nonnegative().default(1000),
  MIN_SOL_RESERVE: z.coerce.number().nonnegative().default(0.05),
  SENDER_MODE: z.enum(["max", "swqos"]).default("swqos"),
  MIN_SENDER_TIP_LAMPORTS: z.coerce.number().nonnegative().default(5_000),
  MAX_SENDER_TIP_LAMPORTS: z.coerce.number().positive().default(100_000_000),
  MAX_TIP_PROFIT_PCT: z.coerce.number().positive().max(100).default(5),
  PRIORITY_FEE_LEVEL: z
    .enum(["min", "low", "medium", "high", "veryHigh", "unsafeMax"])
    .default("veryHigh"),
  FLASH_LOAN_PROVIDER: z.enum(["none", "jupiter"]).default("jupiter"),
  EVENTS_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  WATCH_DEX_PROGRAMS: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  WATCH_ACCOUNTS: z.string().default(""),
  JUPITER_RATE_LIMIT_RPS: z.coerce.number().positive().default(3),
  DEX_PAIRS: z.string().default(""),
  BOT_TOKEN: z.string().default(""),
  CHAT_ID: z.string().default(""),
  MAX_PAIRS_PER_SCAN: z.coerce.number().positive().default(4),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | undefined;

export function getEnv(): Env {
  if (!_env) {
    _env = envSchema.parse(process.env);
  }
  return _env;
}

export const env = getEnv();
