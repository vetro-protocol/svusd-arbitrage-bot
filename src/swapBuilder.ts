import {type Address, encodeFunctionData, type Hex, parseAbi} from "viem";
import {CURVE_ROUTE, CURVE_ROUTE_POOLS, CURVE_ROUTER, CURVE_SWAP_PARAMS} from "./constants.js";

// The contract approves `approveTarget` and calls `target` with opaque bytes, so both
// point at the Curve router and `_receiver` is the arbitrage contract, where it measures
// the sVUSD it received.
const ROUTER_ABI = parseAbi([
  "function exchange(address[11] _route, uint256[5][5] _swap_params, uint256 _amount, uint256 _min_dy, address[5] _pools, address _receiver) payable returns (uint256)",
]);

/** Matches the contract's `SwapParams` (target, approveTarget, calldata, minOut). */
export interface EntrySwap {
  target: Address;
  approveTarget: Address;
  swapCalldata: Hex;
  minAmountOut: bigint;
}

export function buildEntrySwap(args: {
  amountVusd: bigint;
  minSvusdOut: bigint;
  receiver: Address;
}): EntrySwap {
  const {amountVusd, minSvusdOut, receiver} = args;
  if (amountVusd <= 0n || minSvusdOut <= 0n) throw new Error("buildEntrySwap: amounts must be > 0");

  const swapCalldata = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "exchange",
    args: [CURVE_ROUTE, CURVE_SWAP_PARAMS, amountVusd, minSvusdOut, CURVE_ROUTE_POOLS, receiver],
  });
  return {
    target: CURVE_ROUTER,
    approveTarget: CURVE_ROUTER,
    swapCalldata,
    minAmountOut: minSvusdOut,
  };
}
