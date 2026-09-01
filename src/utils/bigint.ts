// ── Basis-point arithmetic (bigint-safe) ──────────────────────────────────────

const BPS_DENOMINATOR = 10_000n;

/** Multiply a bigint value by a basis-point fraction: value × bps / 10000 */
export function applyBps(value: bigint, bps: bigint): bigint {
  return (value * bps) / BPS_DENOMINATOR;
}

/** Divide to get basis points: part × 10000 / whole */
export function toBps(part: bigint, whole: bigint): bigint {
  if (whole === 0n) return 0n;
  return (part * BPS_DENOMINATOR) / whole;
}

/** USDC (6 decimals) → bigint units */
export function usdcToBigInt(usdc: number): bigint {
  return BigInt(Math.round(usdc * 1_000_000));
}

/** BigInt units → USDC (6 decimals) */
export function bigIntToUsdc(units: bigint): number {
  return Number(units) / 1_000_000;
}
