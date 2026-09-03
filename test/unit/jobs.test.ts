// Jobs.open() and Jobs.settle() control flow, with the contract collaborators mocked.
//
// settle's batch-revert fallback (settleClaimablePositions reverts -> settle each matured id on its
// own) is the one path the anvil rehearsal cannot reach: it needs a batch that reverts while
// individual ids still settle, which does not occur against a healthy fork. So it lives here.

import type {Address, PublicClient} from "viem";
import {describe, expect, it, vi} from "vitest";
import type {Arbitrage} from "../../src/arbitrage.js";
import type {Config} from "../../src/config.js";
import type {ExecOutcome, Executor, TxPlan} from "../../src/executor.js";
import {Jobs} from "../../src/jobs.js";
import type {EvaluatedOpportunity, Monitor} from "../../src/monitor.js";
import type {EntryPlan} from "../../src/router.js";
import type {StakingVault} from "../../src/stakingVault.js";
import type {EntrySwap} from "../../src/swapBuilder.js";
import type {Opportunity} from "../../src/types.js";
import {ARB, makeConfig, RECEIVER} from "./helpers.js";

const txPlan = () => ({simulate: async () => {}, send: async () => "0x1" as `0x${string}`});
const ONE = 10n ** 18n;

// ── settle() ───────────────────────────────────────────────────────────────

function settleHarness(opts: {
  openIds: bigint[];
  claimableIds: bigint[];
  batchOutcome: ExecOutcome;
  batchCap?: number;
}) {
  const runLabels: string[] = [];
  const settledIds: bigint[] = [];
  let batchMaxCount: bigint | undefined;

  const arb = {
    address: ARB,
    openRequestIds: async () => opts.openIds,
    settleClaimablePositions: (maxCount: bigint) => {
      batchMaxCount = maxCount;
      return txPlan();
    },
    settlePosition: (id: bigint) => {
      settledIds.push(id);
      return txPlan();
    },
  } as unknown as Arbitrage;

  const vault = {getClaimableRequests: async () => opts.claimableIds} as unknown as StakingVault;

  const executor = {
    run: async (p: TxPlan): Promise<ExecOutcome> => {
      runLabels.push(p.label);
      // The first run is the batch; per-id retries always report sent.
      return p.label.startsWith("settle #") ? {status: "sent"} : opts.batchOutcome;
    },
  } as unknown as Executor;

  const config = makeConfig({settleBatchCap: opts.batchCap ?? 50});
  const jobs = new Jobs(config, {} as PublicClient, vault, arb, executor, {} as Monitor);
  return {jobs, runLabels, settledIds, getBatchMaxCount: () => batchMaxCount};
}

describe("Jobs.settle", () => {
  it("no matured ids sends no tx and returns the open count", async () => {
    const h = settleHarness({openIds: [7n, 8n], claimableIds: [], batchOutcome: {status: "sent"}});
    expect(await h.jobs.settle()).toBe(2);
    expect(h.runLabels).toEqual([]);
    expect(h.settledIds).toEqual([]);
  });

  it("batch settle succeeds with no per-id fallback", async () => {
    const h = settleHarness({
      openIds: [1n, 2n],
      claimableIds: [1n, 2n],
      batchOutcome: {status: "sent"},
    });
    expect(await h.jobs.settle()).toBe(2);
    expect(h.getBatchMaxCount()).toBe(50n); // passes the cap, not an unbounded sentinel
    expect(h.runLabels).toEqual(["settle 2 of 2 matured"]);
    expect(h.settledIds).toEqual([]);
  });

  it("caps the batch: only the first settleBatchCap matured are settled this tick", async () => {
    const h = settleHarness({
      openIds: [1n, 2n, 3n, 4n, 5n],
      claimableIds: [1n, 2n, 3n, 4n, 5n],
      batchOutcome: {status: "sent"},
      batchCap: 2,
    });
    await h.jobs.settle();
    expect(h.getBatchMaxCount()).toBe(2n);
    expect(h.runLabels).toEqual(["settle 2 of 5 matured"]);
  });

  it("batch revert falls back to settling each id, bounded by the cap", async () => {
    const h = settleHarness({
      openIds: [1n, 2n, 3n, 4n, 5n],
      claimableIds: [1n, 2n, 3n, 4n, 5n],
      batchOutcome: {status: "revert", detail: "one bad id"},
      batchCap: 3,
    });
    expect(await h.jobs.settle()).toBe(5);
    expect(h.runLabels).toEqual(["settle 3 of 5 matured", "settle #1", "settle #2", "settle #3"]);
    expect(h.settledIds).toEqual([1n, 2n, 3n]); // the 2 beyond the cap wait for the next tick
  });
});

// ── open() ───────────────────────────────────────────────────────────────────

function opp(over: Partial<Opportunity> = {}): Opportunity {
  return {
    vusdAmount: 1_000n * ONE,
    sharesOut: 995n * ONE,
    dexBuyPrice: 1,
    vusdLocked: 1_010n * ONE,
    grossProfitVusd: 10n * ONE,
    grossSpreadBps: 100,
    netProfitVusd: 9n * ONE,
    netProfitAfterBufferVusd: 8n * ONE,
    contractFloorVusd: 1_000n * ONE,
    profitable: true,
    ...over,
  };
}

function openHarness(opts: {
  reserves: bigint;
  opps: Opportunity[];
  fresh: EvaluatedOpportunity | null;
  config?: Partial<Config>;
}) {
  const built: {minShares?: bigint; receiver?: Address} = {};
  const opened: {vusdAmount?: bigint; buy?: EntrySwap; minProfit?: bigint} = {};
  const runs: TxPlan[] = [];

  const plan: EntryPlan = {
    venue: "curve",
    sharesOut: opts.fresh?.sharesOut ?? 0n,
    build: async (minShares, receiver) => {
      built.minShares = minShares;
      built.receiver = receiver;
      return {
        target: RECEIVER,
        approveTarget: RECEIVER,
        swapCalldata: "0x",
        minAmountOut: minShares,
      };
    },
  };
  const fresh = opts.fresh ? ({...opts.fresh, plan} as EvaluatedOpportunity) : null;

  const client = {
    readContract: vi.fn().mockResolvedValue(opts.reserves),
  } as unknown as PublicClient;
  const arb = {
    address: ARB,
    openPosition: (vusdAmount: bigint, buy: EntrySwap, minProfit: bigint) => {
      opened.vusdAmount = vusdAmount;
      opened.buy = buy;
      opened.minProfit = minProfit;
      return txPlan();
    },
  } as unknown as Arbitrage;
  const monitor = {evaluate: vi.fn().mockResolvedValue(fresh)} as unknown as Monitor;
  const executor = {
    run: async (p: TxPlan): Promise<ExecOutcome> => {
      runs.push(p);
      return {status: "simulated"};
    },
  } as unknown as Executor;

  const config = makeConfig(opts.config);
  const jobs = new Jobs(config, client, {} as StakingVault, arb, executor, monitor);
  return {jobs, monitor, built, opened, runs};
}

describe("Jobs.open", () => {
  it("opens the best affordable profitable candidate, re-quotes, and runs the executor", async () => {
    const h = openHarness({
      reserves: 5_000n * ONE,
      opps: [opp()],
      fresh: opp() as EvaluatedOpportunity,
    });
    await h.jobs.open([opp()], 30);

    // tolerance = 10000 - 50 slippage = 9950
    expect(h.built.minShares).toBe((995n * ONE * 9950n) / 10_000n);
    expect(h.built.receiver).toBe(ARB);
    expect(h.opened.vusdAmount).toBe(1_000n * ONE);
    expect(h.opened.minProfit).toBe((10n * ONE * 9950n) / 10_000n);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].label).toContain("via curve");
    expect(h.runs[0].spendVusd).toBe(1_000n * ONE);
  });

  it("does nothing when no candidate is profitable", async () => {
    const h = openHarness({
      reserves: 5_000n * ONE,
      opps: [opp({profitable: false})],
      fresh: opp() as EvaluatedOpportunity,
    });
    await h.jobs.open([opp({profitable: false})], 30);
    expect(h.runs).toHaveLength(0);
    expect(h.monitor.evaluate).not.toHaveBeenCalled();
  });

  it("skips a candidate above the min(reserves, spend-cap) affordability cap", async () => {
    // Reserves 500 < the 1000 probe, so nothing is affordable even though the spend cap is 10k.
    const h = openHarness({
      reserves: 500n * ONE,
      opps: [opp()],
      fresh: opp() as EvaluatedOpportunity,
    });
    await h.jobs.open([opp()], 30);
    expect(h.runs).toHaveLength(0);
  });

  it("bails when the fresh re-quote is no longer profitable (the edge vanished)", async () => {
    const h = openHarness({
      reserves: 5_000n * ONE,
      opps: [opp()],
      fresh: opp({profitable: false}) as EvaluatedOpportunity,
    });
    await h.jobs.open([opp()], 30);
    expect(h.monitor.evaluate).toHaveBeenCalledOnce();
    expect(h.runs).toHaveLength(0);
  });

  it("bails when the discounted profit floor is break-even (<= 0)", async () => {
    const h = openHarness({
      reserves: 5_000n * ONE,
      opps: [opp()],
      fresh: opp({vusdLocked: 1_000n * ONE}) as EvaluatedOpportunity, // locked == amount -> minProfit 0
    });
    await h.jobs.open([opp()], 30);
    expect(h.runs).toHaveLength(0);
  });

  it("clamps affordability to the spend cap when it is below reserves", async () => {
    // reserves 5000 but the per-tx spend cap is 500, so the 1000 probe is unaffordable
    const h = openHarness({
      reserves: 5_000n * ONE,
      opps: [opp()],
      fresh: opp() as EvaluatedOpportunity,
      config: {maxTxSpendVusd: 500n * ONE},
    });
    await h.jobs.open([opp()], 30);
    expect(h.runs).toHaveLength(0);
    expect(h.monitor.evaluate).not.toHaveBeenCalled();
  });

  it("picks the first affordable-and-profitable candidate, skipping an unaffordable earlier one", async () => {
    const tooBig = opp({vusdAmount: 9_000n * ONE});
    const affordable = opp({vusdAmount: 1_000n * ONE});
    const h = openHarness({
      reserves: 5_000n * ONE,
      opps: [tooBig, affordable],
      fresh: affordable as EvaluatedOpportunity,
    });
    await h.jobs.open([tooBig, affordable], 30);
    expect(h.monitor.evaluate).toHaveBeenCalledWith(1_000n * ONE, 30); // re-quoted the affordable one
    expect(h.opened.vusdAmount).toBe(1_000n * ONE);
  });
});
