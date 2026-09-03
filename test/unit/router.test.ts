// EntryRouter best-venue selection, with the quote sources mocked.
//
// Covers the multi-venue logic: pick the venue with the most sVUSD out, fall back to native
// Curve when an aggregator is unrouted or errors, and stamp the bot's floor as the authoritative
// minAmountOut on the built swap regardless of venue.

import type {Address} from "viem";
import {describe, expect, it} from "vitest";
import type {AggregatorAdapter, AggregatorSwap} from "../../src/aggregators.js";
import {CURVE_ROUTER} from "../../src/constants.js";
import type {CurveQuoter} from "../../src/curve.js";
import {EntryRouter} from "../../src/router.js";
import {RECEIVER} from "./helpers.js";

const AGG_TARGET = "0x00000000000000000000000000000000000A66E5" as Address;

function curveMock(sharesOut: bigint | (() => never)): CurveQuoter {
  return {
    vusdToSvusd: async () => (typeof sharesOut === "function" ? sharesOut() : sharesOut),
  } as unknown as CurveQuoter;
}

function aggMock(name: string, quote: bigint | null | (() => never)): AggregatorAdapter {
  const swap: AggregatorSwap = {
    target: AGG_TARGET,
    approveTarget: AGG_TARGET,
    swapCalldata: "0xabcdef",
  };
  return {
    name,
    getQuote: async () => (typeof quote === "function" ? quote() : quote),
    buildSwap: async () => swap,
  };
}

describe("EntryRouter.bestEntry", () => {
  it("curve-only: the best entry is the curve plan and the floor is authoritative", async () => {
    const router = new EntryRouter(curveMock(1000n), [], 50);
    const plan = await router.bestEntry(500n);
    expect(plan?.venue).toBe("curve");
    expect(plan?.sharesOut).toBe(1000n);
    const swap = await plan?.build(900n, RECEIVER);
    expect(swap?.target).toBe(CURVE_ROUTER);
    expect(swap?.minAmountOut).toBe(900n);
  });

  it("an aggregator with more output wins and passes its calldata through", async () => {
    const router = new EntryRouter(curveMock(1000n), [aggMock("lifi", 1100n)], 50);
    const plan = await router.bestEntry(500n);
    expect(plan?.venue).toBe("lifi");
    expect(plan?.sharesOut).toBe(1100n);
    const swap = await plan?.build(1000n, RECEIVER);
    expect(swap?.target).toBe(AGG_TARGET);
    expect(swap?.swapCalldata).toBe("0xabcdef"); // the aggregator's calldata is carried through
    expect(swap?.minAmountOut).toBe(1000n); // router overrides the API min with the bot's floor
  });

  it("an unrouted aggregator (null quote) falls back to curve", async () => {
    const router = new EntryRouter(curveMock(1000n), [aggMock("lifi", null)], 50);
    const plan = await router.bestEntry(500n);
    expect(plan?.venue).toBe("curve");
    expect(plan?.sharesOut).toBe(1000n);
  });

  it("a throwing aggregator is dropped, curve still wins", async () => {
    const boom = aggMock("1inch", () => {
      throw new Error("api down");
    });
    const router = new EntryRouter(curveMock(1000n), [boom], 50);
    const plan = await router.bestEntry(500n);
    expect(plan?.venue).toBe("curve");
  });

  it("no venue quotes returns null", async () => {
    const router = new EntryRouter(
      curveMock(() => {
        throw new Error("no route");
      }),
      [aggMock("lifi", null)],
      50,
    );
    expect(await router.bestEntry(500n)).toBeNull();
  });
});
