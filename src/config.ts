import {parseEther} from "viem";
import {z} from "zod";

export interface Config {
  rpcUrl: string;
  /**
   * Broadcast gate. "dry-run" (default) simulates every send and never
   * broadcasts; "live" broadcasts, and is only reachable with a key + address.
   */
  txMode: "dry-run" | "live";
  /** Kill switch: when true the executor simulates but refuses to broadcast. */
  paused: boolean;
  privateKey?: string;
  arbitrageAddress?: string;
  /** Hard ceiling on VUSD spent per open (base units), enforced before any send. */
  maxTxSpendVusd: bigint;
  /** Slippage tolerance applied to the entry quote to set the swap's minAmountOut, in bps. */
  entrySlippageBps: number;

  /**
   * Fallback profit floor (bps of VUSD spent) used ONLY when no ARBITRAGE_ADDRESS is wired.
   * With a contract configured the bot reads its live `minProfitBps` each tick instead, so
   * the gate never drifts from the deployed floor.
   */
  minProfitBps: number;
  /** Off-chain gas-cost assumption for a full open+claim round trip (VUSD, base units). */
  estimatedGasCostVusd: bigint;
  /**
   * Prudence buffer (bps of size) held back on top of gas. The arb spread is
   * VUSD-native and fixed at open, so VUSD depeg does not erode it; this is a
   * margin for quote drift and the 7-day VUSD hold, not a depeg hedge.
   */
  bufferBps: number;
  maxGasPriceGwei: number;

  /** VUSD notionals the monitor simulates each poll (base units, ascending). */
  probeAmounts: bigint[];
  pollIntervalMs: number;

  /** Max matured requests settled per tick, so the batch stays gas-bounded as positions pile up. */
  settleBatchCap: number;

  /** Port the /status health server binds. Render injects PORT; defaults to 10000 locally. */
  port: number;
  /** Idle window before /status reports 503; must exceed the slowest tick (a live tx mining). */
  healthStaleMs: number;
}

const DEFAULT_SIZES = ["1000", "5000", "10000", "25000"];

/** A decimal VUSD amount (human units); parsed to wei with parseEther, never through Number. */
const DECIMAL = /^\d+(\.\d+)?$/;
/** 32-byte hex, with or without the 0x prefix. */
const PRIVATE_KEY_HEX = /^(0x)?[0-9a-fA-F]{64}$/;

/** Treat an empty or whitespace-only env value as unset, so defaults apply. */
const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

/** An integer env var with a default; empty and unset both fall back to `def`. */
const intEnv = (def: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().default(def));

/** A bps env var, bounded to [0, max]; keeps slippage/floor knobs from being set to nonsense. */
const bpsEnv = (def: number, max = 10_000) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(max).default(def));

/** A money env kept as a decimal string, so parseEther retains full 18-dp precision and never
 *  sees the scientific notation Number.toString() emits for very small or large values. */
const moneyEnv = (def: string) =>
  z.preprocess(
    emptyToUndefined,
    z.string().regex(DECIMAL, "must be a decimal VUSD amount").default(def),
  );

/** Parse the comma-separated probe sizes (decimal VUSD) straight to wei; drop junk, sort ascending. */
function parseProbeAmounts(raw: string | undefined): bigint[] {
  const tokens = (raw ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => DECIMAL.test(x));
  const list = (tokens.length ? tokens : DEFAULT_SIZES).map((x) => parseEther(x));
  return list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const EnvSchema = z
  .object({
    ETHEREUM_RPC_URL: z.string().min(1, "required"),
    PRIVATE_KEY: z.preprocess(
      emptyToUndefined,
      z.string().trim().regex(PRIVATE_KEY_HEX, "must be a 32-byte hex key").optional(),
    ),
    ARBITRAGE_ADDRESS: z.preprocess(emptyToUndefined, z.string().trim().optional()),
    MIN_PROFIT_BPS: bpsEnv(0),
    ESTIMATED_GAS_COST_VUSD: moneyEnv("15"),
    BUFFER_BPS: bpsEnv(30),
    MAX_GAS_PRICE_GWEI: intEnv(40),
    PROBE_SIZES_VUSD: z.preprocess(emptyToUndefined, z.string().optional()),
    POLL_INTERVAL_MS: intEnv(15_000),
    SETTLE_BATCH_CAP: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().default(20),
    ),
    PORT: intEnv(10000),
    HEALTH_STALE_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
    TX_MODE: z.preprocess(emptyToUndefined, z.enum(["dry-run", "live"]).default("dry-run")),
    PAUSED: z
      .preprocess(emptyToUndefined, z.string().default("false"))
      .transform((v) => v.toLowerCase() === "true" || v === "1"),
    MAX_TX_SPEND_VUSD: moneyEnv("10000"),
    // Entry slippage tolerance, capped at 20% so a fat-finger can't silently gut sandwich protection.
    ENTRY_SLIPPAGE_BPS: bpsEnv(50, 2000),
  })
  .refine((env) => !env.PRIVATE_KEY || env.ARBITRAGE_ADDRESS, {
    message: "PRIVATE_KEY is set but ARBITRAGE_ADDRESS is missing",
    path: ["ARBITRAGE_ADDRESS"],
  })
  .refine((env) => env.TX_MODE !== "live" || (env.PRIVATE_KEY && env.ARBITRAGE_ADDRESS), {
    message: "TX_MODE=live requires both PRIVATE_KEY and ARBITRAGE_ADDRESS",
    path: ["TX_MODE"],
  });

export function loadConfig(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(config)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const env = parsed.data;

  return {
    rpcUrl: env.ETHEREUM_RPC_URL,
    txMode: env.TX_MODE,
    paused: env.PAUSED,
    privateKey: env.PRIVATE_KEY,
    arbitrageAddress: env.ARBITRAGE_ADDRESS,
    maxTxSpendVusd: parseEther(env.MAX_TX_SPEND_VUSD),
    entrySlippageBps: env.ENTRY_SLIPPAGE_BPS,
    minProfitBps: env.MIN_PROFIT_BPS,
    estimatedGasCostVusd: parseEther(env.ESTIMATED_GAS_COST_VUSD),
    bufferBps: env.BUFFER_BPS,
    maxGasPriceGwei: env.MAX_GAS_PRICE_GWEI,
    probeAmounts: parseProbeAmounts(env.PROBE_SIZES_VUSD),
    pollIntervalMs: env.POLL_INTERVAL_MS,
    settleBatchCap: env.SETTLE_BATCH_CAP,
    port: env.PORT,
    healthStaleMs: env.HEALTH_STALE_MS ?? Math.max(env.POLL_INTERVAL_MS * 5, 120_000),
  };
}
