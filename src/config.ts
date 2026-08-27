import {z} from "zod";

export interface Config {
  rpcUrl: string;
  /** Whether a keeper key is present (live) or not (dry-run). */
  live: boolean;
  privateKey?: string;
  arbitrageAddress?: string;

  /** Minimum NET profit (after gas + buffer) to flag/execute, in VUSD. */
  minProfitVusd: number;
  /**
   * On-chain profit floor mirror, in bps of VUSD spent. Matches the contract's
   * `minProfitBps` so the monitor never flags an open the contract would reject.
   */
  minProfitBps: number;
  /** Off-chain gas-cost assumption for a full open+claim round trip, in VUSD. */
  estimatedGasCostVusd: number;
  /**
   * Prudence buffer (bps of size) held back on top of gas. The arb spread is
   * VUSD-native and fixed at open, so VUSD depeg does not erode it; this is a
   * margin for quote drift and the 7-day VUSD hold, not a depeg hedge.
   */
  bufferBps: number;
  maxGasPriceGwei: number;

  /** VUSD notionals the monitor simulates each poll (ascending). */
  probeSizesVusd: number[];
  pollIntervalMs: number;
}

const DEFAULT_SIZES = [1000, 5000, 10000, 25000];

/** Treat an empty or whitespace-only env value as unset, so defaults apply. */
const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

/** A numeric env var with a default; empty and unset both fall back to `def`. */
const numberEnv = (def: number, integer = false) =>
  z.preprocess(
    emptyToUndefined,
    (integer ? z.coerce.number().int() : z.coerce.number()).default(def),
  );

function parseSizes(raw: string | undefined): number[] {
  if (!raw) return DEFAULT_SIZES;
  const nums = raw
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return (nums.length ? nums : DEFAULT_SIZES).sort((a, b) => a - b);
}

const EnvSchema = z
  .object({
    ETHEREUM_RPC_URL: z.string().min(1, "required"),
    PRIVATE_KEY: z.preprocess(emptyToUndefined, z.string().trim().optional()),
    ARBITRAGE_ADDRESS: z.preprocess(emptyToUndefined, z.string().trim().optional()),
    MIN_PROFIT_VUSD: numberEnv(25),
    MIN_PROFIT_BPS: numberEnv(0, true),
    ESTIMATED_GAS_COST_VUSD: numberEnv(15),
    BUFFER_BPS: numberEnv(30, true),
    MAX_GAS_PRICE_GWEI: numberEnv(40, true),
    PROBE_SIZES_VUSD: z.preprocess(emptyToUndefined, z.string().optional()),
    POLL_INTERVAL_MS: numberEnv(15000, true),
  })
  .refine((env) => !env.PRIVATE_KEY || env.ARBITRAGE_ADDRESS, {
    message: "PRIVATE_KEY is set (live mode) but ARBITRAGE_ADDRESS is missing",
    path: ["ARBITRAGE_ADDRESS"],
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
    live: Boolean(env.PRIVATE_KEY),
    privateKey: env.PRIVATE_KEY,
    arbitrageAddress: env.ARBITRAGE_ADDRESS,
    minProfitVusd: env.MIN_PROFIT_VUSD,
    minProfitBps: env.MIN_PROFIT_BPS,
    estimatedGasCostVusd: env.ESTIMATED_GAS_COST_VUSD,
    bufferBps: env.BUFFER_BPS,
    maxGasPriceGwei: env.MAX_GAS_PRICE_GWEI,
    probeSizesVusd: parseSizes(env.PROBE_SIZES_VUSD),
    pollIntervalMs: env.POLL_INTERVAL_MS,
  };
}
