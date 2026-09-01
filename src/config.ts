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
    MIN_PROFIT_BPS: numberEnv(0, true),
    ESTIMATED_GAS_COST_VUSD: numberEnv(15),
    BUFFER_BPS: numberEnv(30, true),
    MAX_GAS_PRICE_GWEI: numberEnv(40, true),
    PROBE_SIZES_VUSD: z.preprocess(emptyToUndefined, z.string().optional()),
    POLL_INTERVAL_MS: numberEnv(15000, true),
    TX_MODE: z.preprocess(emptyToUndefined, z.enum(["dry-run", "live"]).default("dry-run")),
    PAUSED: z
      .preprocess(emptyToUndefined, z.string().default("false"))
      .transform((v) => v.toLowerCase() === "true" || v === "1"),
    MAX_TX_SPEND_VUSD: numberEnv(10000),
    ENTRY_SLIPPAGE_BPS: numberEnv(50, true),
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
    maxTxSpendVusd: parseEther(env.MAX_TX_SPEND_VUSD.toString()),
    entrySlippageBps: env.ENTRY_SLIPPAGE_BPS,
    minProfitBps: env.MIN_PROFIT_BPS,
    estimatedGasCostVusd: parseEther(env.ESTIMATED_GAS_COST_VUSD.toString()),
    bufferBps: env.BUFFER_BPS,
    maxGasPriceGwei: env.MAX_GAS_PRICE_GWEI,
    probeAmounts: parseSizes(env.PROBE_SIZES_VUSD).map((n) => parseEther(n.toString())),
    pollIntervalMs: env.POLL_INTERVAL_MS,
  };
}
