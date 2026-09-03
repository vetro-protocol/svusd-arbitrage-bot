// loadConfig: zod parsing/validation. Money keeps full 18-dp precision via parseEther, bps knobs
// are bounded, probe sizes are cleaned+sorted, and live mode requires a key + address.

import {parseEther} from "viem";
import {afterEach, describe, expect, it, vi} from "vitest";
import {loadConfig} from "../../src/config.js";

// Every knob loadConfig reads; neutralized to "" so ambient shell env can't skew a defaults test.
const KNOBS = [
  "PRIVATE_KEY",
  "ARBITRAGE_ADDRESS",
  "MIN_PROFIT_BPS",
  "ESTIMATED_GAS_COST_VUSD",
  "BUFFER_BPS",
  "MAX_GAS_PRICE_GWEI",
  "PROBE_SIZES_VUSD",
  "POLL_INTERVAL_MS",
  "SETTLE_BATCH_CAP",
  "PORT",
  "HEALTH_STALE_MS",
  "TX_MODE",
  "PAUSED",
  "MAX_TX_SPEND_VUSD",
  "ENTRY_SLIPPAGE_BPS",
  "ENABLE_AGGREGATORS",
  "ONEINCH_API_KEY",
  "LIFI_API_KEY",
];

const KEY = `0x${"11".repeat(32)}`;
const ARB = "0x000000000000000000000000000000000000dEaD";

function loadWith(env: Record<string, string>) {
  vi.unstubAllEnvs();
  for (const k of KNOBS) vi.stubEnv(k, "");
  vi.stubEnv("ETHEREUM_RPC_URL", "http://localhost:8545");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return loadConfig();
}

afterEach(() => vi.unstubAllEnvs());

describe("loadConfig defaults", () => {
  it("applies safe dry-run defaults with only the RPC set", () => {
    const c = loadWith({});
    expect(c.txMode).toBe("dry-run");
    expect(c.paused).toBe(false);
    expect(c.minProfitBps).toBe(0);
    expect(c.bufferBps).toBe(30);
    expect(c.maxGasPriceGwei).toBe(40);
    expect(c.entrySlippageBps).toBe(50);
    expect(c.settleBatchCap).toBe(20);
    expect(c.port).toBe(10_000);
    expect(c.maxTxSpendVusd).toBe(parseEther("10000"));
    expect(c.estimatedGasCostVusd).toBe(parseEther("15"));
    expect(c.probeAmounts).toEqual([
      parseEther("1000"),
      parseEther("5000"),
      parseEther("10000"),
      parseEther("25000"),
    ]);
    expect(c.enableAggregators).toBe(false);
  });
});

describe("loadConfig money precision", () => {
  it("parses decimals through parseEther, keeping sub-wei-safe precision", () => {
    expect(loadWith({MAX_TX_SPEND_VUSD: "0.000000000000000001"}).maxTxSpendVusd).toBe(1n);
    expect(loadWith({MAX_TX_SPEND_VUSD: "12345.678"}).maxTxSpendVusd).toBe(parseEther("12345.678"));
  });

  it("rejects a non-decimal money value", () => {
    expect(() => loadWith({MAX_TX_SPEND_VUSD: "1e18"})).toThrow();
  });
});

describe("loadConfig bounded knobs", () => {
  it("caps entry slippage at 20% (2000 bps)", () => {
    expect(loadWith({ENTRY_SLIPPAGE_BPS: "2000"}).entrySlippageBps).toBe(2000);
    expect(() => loadWith({ENTRY_SLIPPAGE_BPS: "2001"})).toThrow();
  });

  it("caps bps knobs at 10000", () => {
    expect(() => loadWith({BUFFER_BPS: "10001"})).toThrow();
  });

  it("requires a positive integer settle batch cap", () => {
    expect(loadWith({SETTLE_BATCH_CAP: "5"}).settleBatchCap).toBe(5);
    expect(() => loadWith({SETTLE_BATCH_CAP: "0"})).toThrow();
    expect(() => loadWith({SETTLE_BATCH_CAP: "abc"})).toThrow();
  });
});

describe("loadConfig probe sizes", () => {
  it("drops junk and sorts ascending, straight to wei", () => {
    const c = loadWith({PROBE_SIZES_VUSD: "5000, 1000, junk, 2000"});
    expect(c.probeAmounts).toEqual([parseEther("1000"), parseEther("2000"), parseEther("5000")]);
  });
});

describe("loadConfig live-mode refinements", () => {
  it("rejects a private key without an arbitrage address", () => {
    expect(() => loadWith({PRIVATE_KEY: KEY})).toThrow();
  });

  it("rejects TX_MODE=live without both key and address", () => {
    expect(() => loadWith({TX_MODE: "live"})).toThrow();
  });

  it("rejects a malformed private key", () => {
    expect(() => loadWith({PRIVATE_KEY: "0xnothex", ARBITRAGE_ADDRESS: ARB})).toThrow();
  });

  it("accepts a valid live configuration", () => {
    const c = loadWith({TX_MODE: "live", PRIVATE_KEY: KEY, ARBITRAGE_ADDRESS: ARB});
    expect(c.txMode).toBe("live");
    expect(c.privateKey).toBe(KEY);
    expect(c.arbitrageAddress).toBe(ARB);
  });
});

describe("loadConfig PAUSED kill switch", () => {
  it("arms only on true/1; anything else leaves the bot running", () => {
    expect(loadWith({PAUSED: "true"}).paused).toBe(true);
    expect(loadWith({PAUSED: "1"}).paused).toBe(true);
    expect(loadWith({PAUSED: "false"}).paused).toBe(false);
    expect(loadWith({PAUSED: "0"}).paused).toBe(false);
    expect(loadWith({PAUSED: "yes"}).paused).toBe(false);
    expect(loadWith({}).paused).toBe(false); // unset defaults to running
  });
});
