import type {Address, PublicClient} from "viem";
import {vi} from "vitest";
import type {Config} from "../../src/config.js";

// Explicit valid 20-byte addresses (kept simple so intent reads at the call site).
export const ARB = "0x000000000000000000000000000000000000dEaD" as Address;
export const KEEPER = "0x0000000000000000000000000000000000000001" as Address;
export const BENEFICIARY = "0x0000000000000000000000000000000000000002" as Address;
export const RECEIVER = "0x000000000000000000000000000000000000bEEF" as Address;

const ONE = 10n ** 18n;

/** A complete, valid Config in safe dry-run defaults; override only what a test cares about. */
export function makeConfig(over: Partial<Config> = {}): Config {
  return {
    rpcUrl: "http://localhost:8545",
    txMode: "dry-run",
    paused: false,
    privateKey: undefined,
    arbitrageAddress: undefined,
    maxTxSpendVusd: 10_000n * ONE,
    entrySlippageBps: 50,
    minProfitBps: 0,
    estimatedGasCostVusd: 15n * ONE,
    bufferBps: 30,
    maxGasPriceGwei: 40,
    probeAmounts: [1_000n * ONE],
    pollIntervalMs: 15_000,
    settleBatchCap: 20,
    enableAggregators: false,
    oneinchApiKey: undefined,
    lifiApiKey: undefined,
    port: 10_000,
    healthStaleMs: 120_000,
    ...over,
  };
}

/**
 * A viem PublicClient stubbed to only the methods the code under test calls. Each is a
 * `vi.fn()` the test configures with `mockResolvedValue` / `mockRejectedValue`; unlisted
 * methods stay undefined so an unexpected call fails loudly rather than silently passing.
 */
export function fakePublicClient(
  over: Partial<Record<keyof PublicClient, unknown>> = {},
): PublicClient {
  return {
    readContract: vi.fn(),
    simulateContract: vi.fn(),
    estimateFeesPerGas: vi.fn(),
    getGasPrice: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    writeContract: vi.fn(),
    ...over,
  } as unknown as PublicClient;
}
