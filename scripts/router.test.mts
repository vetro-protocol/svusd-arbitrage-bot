// Unit tests for EntryRouter best-venue selection, with the quote sources mocked.
//
// Covers the new multi-venue logic: pick the venue with the most sVUSD out, fall back to
// native Curve when an aggregator is unrouted or errors, and stamp the bot's floor as the
// authoritative minAmountOut on the built swap regardless of venue.

import assert from "node:assert/strict";
import {test} from "node:test";
import type {Address} from "viem";
import type {AggregatorAdapter, AggregatorSwap} from "../src/aggregators.js";
import {CURVE_ROUTER} from "../src/constants.js";
import type {CurveQuoter} from "../src/curve.js";
import {EntryRouter} from "../src/router.js";

const RECEIVER = "0x000000000000000000000000000000000000bEEF" as Address;
const AGG_TARGET = "0x00000000000000000000000000000000000A66Re" as Address;

function curveMock(sharesOut: bigint | (() => never)): CurveQuoter {
  return {
    vusdToSvusd: async () => {
      if (typeof sharesOut === "function") return sharesOut();
      return sharesOut;
    },
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

test("curve-only: best entry is the curve plan", async () => {
  const router = new EntryRouter(curveMock(1000n), [], 50);
  const plan = await router.bestEntry(500n);
  assert.equal(plan?.venue, "curve");
  assert.equal(plan?.sharesOut, 1000n);
  const swap = await plan?.build(900n, RECEIVER);
  assert.equal(swap?.target, CURVE_ROUTER);
  assert.equal(swap?.minAmountOut, 900n); // floor is authoritative
});

test("aggregator with more output wins and passes its calldata through", async () => {
  const router = new EntryRouter(curveMock(1000n), [aggMock("lifi", 1100n)], 50);
  const plan = await router.bestEntry(500n);
  assert.equal(plan?.venue, "lifi");
  assert.equal(plan?.sharesOut, 1100n);
  const swap = await plan?.build(1000n, RECEIVER);
  assert.equal(swap?.target, AGG_TARGET);
  assert.equal(swap?.minAmountOut, 1000n); // router overrides API min with the bot's floor
});

test("unrouted aggregator (null) falls back to curve", async () => {
  const router = new EntryRouter(curveMock(1000n), [aggMock("lifi", null)], 50);
  const plan = await router.bestEntry(500n);
  assert.equal(plan?.venue, "curve");
  assert.equal(plan?.sharesOut, 1000n);
});

test("a throwing aggregator is dropped, curve still wins", async () => {
  const boom = aggMock("1inch", () => {
    throw new Error("api down");
  });
  const router = new EntryRouter(curveMock(1000n), [boom], 50);
  const plan = await router.bestEntry(500n);
  assert.equal(plan?.venue, "curve");
});

test("no venue quotes returns null", async () => {
  const router = new EntryRouter(
    curveMock(() => {
      throw new Error("no route");
    }),
    [aggMock("lifi", null)],
    50,
  );
  assert.equal(await router.bestEntry(500n), null);
});
