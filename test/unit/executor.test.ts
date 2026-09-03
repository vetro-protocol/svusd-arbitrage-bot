// Executor.run: the choke point every state-changing call passes through. Order is PAUSED ->
// spend cap -> gas cap -> simulate -> (live) broadcast, and a mined revert is still a revert.

import type {Account} from "viem";
import {beforeEach, describe, expect, it, vi} from "vitest";
import type {Config} from "../../src/config.js";
import {Executor, type TxPlan} from "../../src/executor.js";
import {fakePublicClient, KEEPER, makeConfig} from "./helpers.js";

const ONE = 10n ** 18n;
const GWEI = 10n ** 9n;

function txPlan(over: Partial<TxPlan> = {}): TxPlan {
  return {
    label: "open",
    simulate: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue("0xhash"),
    spendVusd: 1_000n * ONE,
    ...over,
  };
}

/** Executor with a low (1 gwei) gas quote so the gas cap passes unless a test raises it. */
function execWith(config: Partial<Config>, account?: Account, clientOver = {}) {
  const client = fakePublicClient({
    estimateFeesPerGas: vi.fn().mockResolvedValue({maxFeePerGas: 1n * GWEI}),
    getGasPrice: vi.fn().mockResolvedValue(1n * GWEI),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({status: "success", blockNumber: 123n}),
    ...clientOver,
  });
  return {exec: new Executor(makeConfig(config), client, account), client};
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("Executor.run gates", () => {
  it("PAUSED short-circuits before any chain read", async () => {
    const {exec, client} = execWith({paused: true});
    const plan = txPlan();
    expect(await exec.run(plan)).toEqual({status: "skipped-paused"});
    expect(plan.simulate).not.toHaveBeenCalled();
    expect(client.estimateFeesPerGas).not.toHaveBeenCalled();
  });

  it("skips when spend exceeds the per-tx ceiling, without simulating or sending", async () => {
    const {exec} = execWith({maxTxSpendVusd: 500n * ONE});
    const plan = txPlan({spendVusd: 1_000n * ONE});
    expect((await exec.run(plan)).status).toBe("skipped-spend-cap");
    expect(plan.simulate).not.toHaveBeenCalled();
    expect(plan.send).not.toHaveBeenCalled();
  });

  it("ignores the spend cap for a call with no spendVusd (settle)", async () => {
    const {exec} = execWith({maxTxSpendVusd: 1n}); // tiny cap, but settle spends nothing
    const out = await exec.run(txPlan({spendVusd: undefined}));
    expect(out.status).toBe("simulated");
  });

  it("skips when the gas price is over the cap, without simulating or sending", async () => {
    const {exec} = execWith({maxGasPriceGwei: 40}, undefined, {
      estimateFeesPerGas: vi.fn().mockResolvedValue({maxFeePerGas: 50n * GWEI}),
    });
    const plan = txPlan({spendVusd: undefined});
    expect((await exec.run(plan)).status).toBe("skipped-gas-cap");
    expect(plan.simulate).not.toHaveBeenCalled();
    expect(plan.send).not.toHaveBeenCalled();
  });

  it("passes the gates at exact boundary equality (spend == cap, gwei == cap)", async () => {
    const {exec} = execWith({maxTxSpendVusd: 1_000n * ONE, maxGasPriceGwei: 1}); // gas quote is exactly 1 gwei
    const out = await exec.run(txPlan({spendVusd: 1_000n * ONE}));
    expect(out.status).toBe("simulated"); // strict >, so equal is allowed through
  });

  it("falls back to getGasPrice when the RPC omits the 1559 max fee", async () => {
    const {exec, client} = execWith({maxGasPriceGwei: 40}, undefined, {
      estimateFeesPerGas: vi.fn().mockResolvedValue({maxFeePerGas: undefined}),
      getGasPrice: vi.fn().mockResolvedValue(50n * GWEI), // legacy price is over the cap
    });
    const out = await exec.run(txPlan({spendVusd: undefined}));
    expect(client.getGasPrice).toHaveBeenCalled();
    expect(out.status).toBe("skipped-gas-cap");
  });

  it("never broadcasts a call that reverts in simulation", async () => {
    const {exec} = execWith({txMode: "live"}, {address: KEEPER} as Account);
    const plan = txPlan({
      spendVusd: undefined,
      simulate: vi.fn().mockRejectedValue(new Error("revert: InsufficientProfit\ntrace...")),
    });
    const out = await exec.run(plan);
    expect(out.status).toBe("revert");
    expect(out.detail).toBe("revert: InsufficientProfit"); // first line only
    expect(plan.send).not.toHaveBeenCalled();
  });

  it("simulates only (no broadcast) in dry-run", async () => {
    const {exec} = execWith({txMode: "dry-run"});
    const plan = txPlan({spendVusd: undefined});
    expect((await exec.run(plan)).status).toBe("simulated");
    expect(plan.send).not.toHaveBeenCalled();
  });

  it("simulates only when live but no account is configured", async () => {
    const {exec} = execWith({txMode: "live"}, undefined);
    const plan = txPlan({spendVusd: undefined});
    expect((await exec.run(plan)).status).toBe("simulated");
    expect(plan.send).not.toHaveBeenCalled();
  });

  it("broadcasts and reports sent when live with an account and the tx succeeds", async () => {
    const {exec} = execWith({txMode: "live"}, {address: KEEPER} as Account);
    const plan = txPlan({spendVusd: undefined});
    const out = await exec.run(plan);
    expect(plan.send).toHaveBeenCalled();
    expect(out).toEqual({status: "sent", hash: "0xhash"});
  });

  it("reports revert when the tx mines with a failed status", async () => {
    const {exec} = execWith({txMode: "live"}, {address: KEEPER} as Account, {
      waitForTransactionReceipt: vi.fn().mockResolvedValue({status: "reverted", blockNumber: 999n}),
    });
    const out = await exec.run(txPlan({spendVusd: undefined}));
    expect(out.status).toBe("revert");
    expect(out.hash).toBe("0xhash");
    expect(out.detail).toContain("999");
  });
});
