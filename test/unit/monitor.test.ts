// Monitor.evaluate: the profit gate and buffer/floor math, in base units so it stays bit-exact
// with the contract. Quotes are mocked (router.bestEntry + vault.previewRedeem).

import {describe, expect, it, vi} from "vitest";
import type {Config} from "../../src/config.js";
import {type EvaluatedOpportunity, Monitor} from "../../src/monitor.js";
import type {EntryPlan, EntryRouter} from "../../src/router.js";
import type {StakingVault} from "../../src/stakingVault.js";
import {makeConfig} from "./helpers.js";

const ONE = 10n ** 18n;

function planWith(sharesOut: bigint): EntryPlan {
  return {venue: "curve", sharesOut, build: async () => ({}) as never};
}

/** Monitor whose quote returns `sharesOut` shares locking `locked` VUSD (or no route when plan is null). */
function monitorWith(sharesOut: bigint | null, locked: bigint, config?: Partial<Config>): Monitor {
  const router = {
    bestEntry: vi.fn().mockResolvedValue(sharesOut === null ? null : planWith(sharesOut)),
  } as unknown as EntryRouter;
  const vault = {previewRedeem: vi.fn().mockResolvedValue(locked)} as unknown as StakingVault;
  return new Monitor(makeConfig(config), router, vault);
}

describe("Monitor.evaluate", () => {
  it("returns null when no venue quotes the size", async () => {
    expect(await monitorWith(null, 0n).evaluate(1_000n * ONE, 30)).toBeNull();
  });

  it("returns null when the redeem locks nothing", async () => {
    expect(await monitorWith(995n * ONE, 0n).evaluate(1_000n * ONE, 30)).toBeNull();
  });

  it("computes gross/net/buffer/floor in base units for a profitable size", async () => {
    // spend 1000, lock 1020, gas 1, bufferBps 30 (=3), minProfitBps 30 (floor 1003)
    const m = monitorWith(995n * ONE, 1_020n * ONE, {estimatedGasCostVusd: 1n * ONE});
    const o = (await m.evaluate(1_000n * ONE, 30)) as EvaluatedOpportunity;
    expect(o.grossProfitVusd).toBe(20n * ONE);
    expect(o.netProfitVusd).toBe(19n * ONE);
    expect(o.netProfitAfterBufferVusd).toBe(16n * ONE); // 19 - buffer(3)
    expect(o.contractFloorVusd).toBe(1_003n * ONE); // 1000 + ceilDiv(1000*30, 1e4)
    expect(o.profitable).toBe(true);
    expect(o.plan.venue).toBe("curve");
  });

  it("is not profitable when the buffered net is negative even though the floor is met", async () => {
    // lock 1003 == floor(1003) so the floor is met; gross 3 - gas 1 - buffer 3 = -1 < 0
    const m = monitorWith(995n * ONE, 1_003n * ONE, {estimatedGasCostVusd: 1n * ONE});
    const o = (await m.evaluate(1_000n * ONE, 30)) as EvaluatedOpportunity;
    expect(o.netProfitAfterBufferVusd).toBe(-1n * ONE);
    expect(o.profitable).toBe(false);
  });

  it("is not profitable when the locked payout is below the contract floor", async () => {
    // minProfitBps 1000 -> floor 1100; lock 1020 < 1100 despite a positive buffered net
    const m = monitorWith(995n * ONE, 1_020n * ONE, {estimatedGasCostVusd: 1n * ONE});
    const o = (await m.evaluate(1_000n * ONE, 1_000)) as EvaluatedOpportunity;
    expect(o.contractFloorVusd).toBe(1_100n * ONE);
    expect(o.profitable).toBe(false);
  });

  it("rounds the bps floor up (ceilDiv), matching the contract", async () => {
    // 3333 * 7 bps = 2.3331 -> ceil to 3 wei of margin
    const m = monitorWith(1n, 10n ** 30n, {estimatedGasCostVusd: 0n});
    const o = (await m.evaluate(3_333n, 7)) as EvaluatedOpportunity;
    expect(o.contractFloorVusd).toBe(3_333n + 3n); // ceilDiv(3333*7, 1e4) = ceil(2.3331) = 3
  });

  it("accepts locked exactly AT the floor (>= boundary is the sole decider)", async () => {
    // lock 1003 == floor(1003); buffer 0 and gas 0 leave a clearly positive net, so only the
    // floor comparison decides. A source `>` instead of `>=` would flip this to false.
    const m = monitorWith(995n * ONE, 1_003n * ONE, {estimatedGasCostVusd: 0n, bufferBps: 0});
    const o = (await m.evaluate(1_000n * ONE, 30)) as EvaluatedOpportunity;
    expect(o.vusdLocked).toBe(o.contractFloorVusd);
    expect(o.netProfitAfterBufferVusd).toBeGreaterThan(0n);
    expect(o.profitable).toBe(true);
  });

  it("reports a genuine below-cost quote as an unprofitable loss", async () => {
    // lock 990 < spend 1000: negative gross, and below any positive floor
    const m = monitorWith(995n * ONE, 990n * ONE, {estimatedGasCostVusd: 0n});
    const o = (await m.evaluate(1_000n * ONE, 30)) as EvaluatedOpportunity;
    expect(o.grossProfitVusd).toBe(-10n * ONE);
    expect(o.profitable).toBe(false);
  });
});

describe("Monitor.scan", () => {
  it("drops null probes and sorts by buffered net descending", async () => {
    const m = monitorWith(1n, 1n, {probeAmounts: [1n, 2n, 3n]});
    vi.spyOn(m, "evaluate").mockImplementation(async (vusdAmount) => {
      if (vusdAmount === 2n) return null; // this probe has no route
      return {vusdAmount, netProfitAfterBufferVusd: vusdAmount * ONE} as EvaluatedOpportunity;
    });
    const out = await m.scan(30);
    expect(out.map((o) => o.vusdAmount)).toEqual([3n, 1n]); // 2n dropped, 3 before 1
  });

  it("catches a throwing probe and still returns the others", async () => {
    const m = monitorWith(1n, 1n, {probeAmounts: [1n, 2n]});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(m, "evaluate").mockImplementation(async (vusdAmount) => {
      if (vusdAmount === 1n) throw new Error("quote failed");
      return {vusdAmount, netProfitAfterBufferVusd: ONE} as EvaluatedOpportunity;
    });
    const out = await m.scan(30);
    expect(out.map((o) => o.vusdAmount)).toEqual([2n]);
  });
});
