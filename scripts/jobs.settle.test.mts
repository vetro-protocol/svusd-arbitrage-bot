// Unit tests for Jobs.settle() control flow, with the contract collaborators mocked.
//
// The batch-revert fallback (settleClaimablePositions reverts -> settle each matured id on its own)
// is the one path the anvil rehearsal cannot reach: it needs a batch that reverts while individual
// ids still settle, which does not occur against a healthy fork. So it is exercised here instead.

import assert from "node:assert/strict";
import {test} from "node:test";
import type {Arbitrage} from "../src/arbitrage.js";
import type {Config} from "../src/config.js";
import type {Executor, ExecOutcome, TxPlan} from "../src/executor.js";
import {Jobs} from "../src/jobs.js";
import type {Monitor} from "../src/monitor.js";
import type {StakingVault} from "../src/stakingVault.js";

const ARB_ADDRESS = "0x000000000000000000000000000000000000dEaD" as const;
const plan = () => ({simulate: async () => {}, send: async () => "0x1" as `0x${string}`});

/** Build a Jobs wired to spies over the three collaborators settle() touches. */
function harness(opts: {
  openIds: bigint[];
  claimableIds: bigint[];
  batchOutcome: ExecOutcome;
  batchCap?: number;
}) {
  const runLabels: string[] = [];
  const settledIds: bigint[] = [];
  let batchMaxCount: bigint | undefined;

  const arb = {
    address: ARB_ADDRESS,
    openRequestIds: async () => opts.openIds,
    settleClaimablePositions: (maxCount: bigint) => {
      batchMaxCount = maxCount;
      return plan();
    },
    settlePosition: (id: bigint) => {
      settledIds.push(id);
      return plan();
    },
  } as unknown as Arbitrage;

  const vault = {
    getClaimableRequests: async () => opts.claimableIds,
  } as unknown as StakingVault;

  const executor = {
    run: async (p: TxPlan): Promise<ExecOutcome> => {
      runLabels.push(p.label);
      // The first run is the batch; per-id retries always report sent.
      return p.label.startsWith("settle #") ? {status: "sent"} : opts.batchOutcome;
    },
  } as unknown as Executor;

  const config = {settleBatchCap: opts.batchCap ?? 50} as Config;
  const jobs = new Jobs(config, {} as never, vault, arb, executor, {} as Monitor);
  return {jobs, runLabels, settledIds, getBatchMaxCount: () => batchMaxCount};
}

test("no matured ids sends no tx and returns the open count", async () => {
  const h = harness({openIds: [7n, 8n], claimableIds: [], batchOutcome: {status: "sent"}});
  const count = await h.jobs.settle();
  assert.equal(count, 2);
  assert.deepEqual(h.runLabels, []);
  assert.deepEqual(h.settledIds, []);
});

test("batch settle succeeds with no per-id fallback", async () => {
  const h = harness({openIds: [1n, 2n], claimableIds: [1n, 2n], batchOutcome: {status: "sent"}});
  const count = await h.jobs.settle();
  assert.equal(count, 2);
  assert.equal(h.getBatchMaxCount(), 50n); // passes the cap, not an unbounded sentinel
  assert.deepEqual(h.runLabels, ["settle 2 of 2 matured"]);
  assert.deepEqual(h.settledIds, []);
});

test("batch is capped: only the first `settleBatchCap` matured are settled this tick", async () => {
  const h = harness({
    openIds: [1n, 2n, 3n, 4n, 5n],
    claimableIds: [1n, 2n, 3n, 4n, 5n],
    batchOutcome: {status: "sent"},
    batchCap: 2,
  });
  await h.jobs.settle();
  assert.equal(h.getBatchMaxCount(), 2n);
  assert.deepEqual(h.runLabels, ["settle 2 of 5 matured"]);
});

test("batch revert falls back to settling each id, bounded by the cap", async () => {
  const h = harness({
    openIds: [1n, 2n, 3n, 4n, 5n],
    claimableIds: [1n, 2n, 3n, 4n, 5n],
    batchOutcome: {status: "revert", detail: "one bad id"},
    batchCap: 3,
  });
  const count = await h.jobs.settle();
  assert.equal(count, 5);
  assert.deepEqual(h.runLabels, ["settle 3 of 5 matured", "settle #1", "settle #2", "settle #3"]);
  assert.deepEqual(h.settledIds, [1n, 2n, 3n]); // the 2 beyond the cap wait for the next tick
});
