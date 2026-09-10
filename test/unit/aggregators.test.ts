// Aggregator adapters (1inch, LiFi): quote parsing and swap-calldata extraction over a mocked fetch.
// getQuote swallows failures to null (so a down aggregator just drops out); buildSwap is strict, and
// LiFi must surface a real approvalAddress rather than approving the tx target.

import type {Address} from "viem";
import {afterEach, describe, expect, it, vi} from "vitest";
import {LiFiAdapter, OneInchAdapter, type SwapBuildParams} from "../../src/aggregators.js";

const SRC = "0x000000000000000000000000000000000000005c" as Address;
const DST = "0x00000000000000000000000000000000000000d5" as Address;
const RECEIVER = "0x000000000000000000000000000000000000bEEF" as Address;
const TARGET = "0x00000000000000000000000000000000000A66E5" as Address;
const APPROVE = "0x000000000000000000000000000000000000A99a" as Address;

const quoteParams = {srcToken: SRC, destToken: DST, amount: 1_000n, chainId: 1};
const buildParams: SwapBuildParams = {...quoteParams, receiver: RECEIVER, slippageBps: 50};

function mockFetch(resp: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resp));
}
function mockFetchReject(err: Error) {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(err));
}
const res = (ok: boolean, data: unknown, status = ok ? 200 : 500) => ({
  ok,
  status,
  json: async () => data,
});

afterEach(() => vi.unstubAllGlobals());

describe("OneInchAdapter", () => {
  const inch = new OneInchAdapter("key");

  it("getQuote parses dstAmount to a bigint", async () => {
    mockFetch(res(true, {dstAmount: "12345"}));
    expect(await inch.getQuote(quoteParams)).toBe(12345n);
  });

  it("getQuote returns null on a non-ok response", async () => {
    mockFetch(res(false, {}, 429));
    expect(await inch.getQuote(quoteParams)).toBeNull();
  });

  it("getQuote returns null when the request throws", async () => {
    mockFetchReject(new Error("network"));
    expect(await inch.getQuote(quoteParams)).toBeNull();
  });

  it("buildSwap extracts the tx target and calldata (approve == target)", async () => {
    mockFetch(res(true, {tx: {to: TARGET, data: "0xdeadbeef"}}));
    expect(await inch.buildSwap(buildParams)).toEqual({
      target: TARGET,
      approveTarget: TARGET,
      swapCalldata: "0xdeadbeef",
    });
  });

  it("buildSwap throws when the tx is missing", async () => {
    mockFetch(res(true, {}));
    await expect(inch.buildSwap(buildParams)).rejects.toThrow("missing tx");
  });

  it("buildSwap throws on a non-ok response", async () => {
    mockFetch(res(false, {}, 500));
    await expect(inch.buildSwap(buildParams)).rejects.toThrow("failed");
  });
});

describe("LiFiAdapter", () => {
  const lifi = new LiFiAdapter();

  it("getQuote parses estimate.toAmount to a bigint", async () => {
    mockFetch(res(true, {estimate: {toAmount: "999"}}));
    expect(await lifi.getQuote(quoteParams)).toBe(999n);
  });

  it("getQuote returns null on a non-ok response", async () => {
    mockFetch(res(false, {}, 502));
    expect(await lifi.getQuote(quoteParams)).toBeNull();
  });

  it("getQuote returns null when the request throws", async () => {
    mockFetchReject(new Error("network"));
    expect(await lifi.getQuote(quoteParams)).toBeNull();
  });

  it("buildSwap uses approvalAddress as the spender, distinct from the tx target", async () => {
    mockFetch(
      res(true, {
        estimate: {toAmount: "1", approvalAddress: APPROVE},
        transactionRequest: {to: TARGET, data: "0xabcd"},
      }),
    );
    expect(await lifi.buildSwap(buildParams)).toEqual({
      target: TARGET,
      approveTarget: APPROVE,
      swapCalldata: "0xabcd",
    });
  });

  it("buildSwap refuses to approve when approvalAddress is absent", async () => {
    mockFetch(
      res(true, {estimate: {toAmount: "1"}, transactionRequest: {to: TARGET, data: "0xabcd"}}),
    );
    await expect(lifi.buildSwap(buildParams)).rejects.toThrow("approvalAddress");
  });

  it("buildSwap throws when the transactionRequest is missing", async () => {
    mockFetch(res(true, {estimate: {toAmount: "1", approvalAddress: APPROVE}}));
    await expect(lifi.buildSwap(buildParams)).rejects.toThrow("transactionRequest");
  });
});
