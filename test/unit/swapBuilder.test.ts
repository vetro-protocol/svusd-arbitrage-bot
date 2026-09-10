// buildEntrySwap: the Curve router calldata the contract executes. target/approveTarget point at the
// router, the bot's floor is the on-chain minAmountOut, and the encoded args carry amount/min/receiver.

import {decodeFunctionData, parseAbi} from "viem";
import {describe, expect, it} from "vitest";
import {CURVE_ROUTE, CURVE_ROUTER, SVUSD_ADDRESS, VUSD_ADDRESS} from "../../src/constants.js";
import {buildEntrySwap} from "../../src/swapBuilder.js";
import {RECEIVER} from "./helpers.js";

const ROUTER_ABI = parseAbi([
  "function exchange(address[11] _route, uint256[5][5] _swap_params, uint256 _amount, uint256 _min_dy, address[5] _pools, address _receiver) payable returns (uint256)",
]);

describe("buildEntrySwap", () => {
  it("targets the Curve router and stamps the floor as minAmountOut", () => {
    const swap = buildEntrySwap({amountVusd: 1_000n, minSvusdOut: 950n, receiver: RECEIVER});
    expect(swap.target).toBe(CURVE_ROUTER);
    expect(swap.approveTarget).toBe(CURVE_ROUTER);
    expect(swap.minAmountOut).toBe(950n);
  });

  it("encodes exchange() with the VUSD->sVUSD route, amount, min, and receiver", () => {
    const swap = buildEntrySwap({amountVusd: 1_000n, minSvusdOut: 950n, receiver: RECEIVER});
    const {functionName, args} = decodeFunctionData({abi: ROUTER_ABI, data: swap.swapCalldata});
    expect(functionName).toBe("exchange");
    expect(args[0]).toEqual(CURVE_ROUTE); // route: VUSD -> crvUSD -> sVUSD, zero-padded
    expect(args[0][0]).toBe(VUSD_ADDRESS);
    expect(args[0][4]).toBe(SVUSD_ADDRESS);
    expect(args[2]).toBe(1_000n); // amount
    expect(args[3]).toBe(950n); // min_dy
    expect(args[5]).toBe(RECEIVER);
  });

  it("rejects non-positive amounts", () => {
    expect(() => buildEntrySwap({amountVusd: 0n, minSvusdOut: 1n, receiver: RECEIVER})).toThrow();
    expect(() => buildEntrySwap({amountVusd: 1n, minSvusdOut: 0n, receiver: RECEIVER})).toThrow();
  });
});
