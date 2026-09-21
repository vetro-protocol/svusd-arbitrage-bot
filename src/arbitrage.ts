import {
  type Account,
  type Address,
  type Hash,
  type PublicClient,
  parseAbi,
  type WalletClient,
} from "viem";
import type {EntrySwap} from "./swapBuilder.js";

/**
 * Thin wrapper over the `SVusdArbitrage` custody contract. Reads position state
 * the bot re-derives each tick (there is no local store), and exposes the two
 * keeper writes as simulate/send thunks for the executor to gate. Cancel/sweep
 * are owner-only and never touched here.
 */
const ARBITRAGE_ABI = parseAbi([
  "function openPosition(uint256 vusdAmount, (address target, address approveTarget, bytes swapCalldata, uint256 minAmountOut) buy, uint256 minProfit) returns (uint256 requestId, uint256 lockedVusd)",
  "function settlePosition(uint256 requestId) returns (int256 profit)",
  "function settleClaimablePositions(uint256 maxCount) returns (uint256 settled, int256 totalProfit)",
  "function openRequestIds() view returns (uint256[])",
  "function openRequestCount() view returns (uint256)",
  "function lockedVusdOf(uint256 requestId) view returns (uint256)",
  "function entryVusdOf(uint256 requestId) view returns (uint256)",
  "function isKeeper(address account) view returns (bool)",
  "function minProfitBps() view returns (uint256)",
]);

/**
 * Headroom added over the node's gas estimate. The entry swap's cost tracks Curve pool
 * imbalance, and an imbalanced pool is the only state this bot ever opens in, so an estimate
 * taken a block earlier can undershoot the execution that actually lands.
 */
const GAS_LIMIT_MARGIN_BPS = 2_500n;

export class Arbitrage {
  constructor(
    readonly address: Address,
    private publicClient: PublicClient,
    private walletClient?: WalletClient,
    private account?: Account,
  ) {}

  openRequestIds(): Promise<readonly bigint[]> {
    return this.publicClient.readContract({
      address: this.address,
      abi: ARBITRAGE_ABI,
      functionName: "openRequestIds",
    });
  }

  lockedVusdOf(requestId: bigint): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.address,
      abi: ARBITRAGE_ABI,
      functionName: "lockedVusdOf",
      args: [requestId],
    });
  }

  isKeeper(account: Address): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.address,
      abi: ARBITRAGE_ABI,
      functionName: "isKeeper",
      args: [account],
    });
  }

  /** The live on-chain profit floor (bps of VUSD spent). The bot's gate mirrors this. */
  minProfitBps(): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.address,
      abi: ARBITRAGE_ABI,
      functionName: "minProfitBps",
    });
  }

  /** Simulate/send pair for `openPosition(vusdAmount, buy, minProfit)`. */
  openPosition(vusdAmount: bigint, buy: EntrySwap, minProfit: bigint) {
    return this.plan("openPosition", [vusdAmount, buy, minProfit]);
  }

  /** Simulate/send pair for `settlePosition(requestId)`; the contract floors the payout to the locked amount. */
  settlePosition(requestId: bigint) {
    return this.plan("settlePosition", [requestId]);
  }

  /** Simulate/send pair for `settleClaimablePositions(maxCount)`; the job passes the batch cap so a large matured set drains over successive ticks. */
  settleClaimablePositions(maxCount: bigint) {
    return this.plan("settleClaimablePositions", [maxCount]);
  }

  /**
   * A simulate/send pair over one shared gas limit, resolved once and reused. Both legs must
   * carry the SAME limit: a simulation run without one proves only that the call does not
   * revert, never that it fits the gas the broadcast will supply.
   */
  private plan(functionName: string, args: readonly unknown[]) {
    let limit: Promise<bigint | undefined> | undefined;
    const gas = () => {
      limit ??= this.gasLimit(functionName, args);
      return limit;
    };
    return {
      simulate: async () =>
        this.publicClient.simulateContract({
          address: this.address,
          abi: ARBITRAGE_ABI,
          // biome-ignore lint/suspicious/noExplicitAny: generic pass-through over parseAbi overloads
          functionName: functionName as any,
          // biome-ignore lint/suspicious/noExplicitAny: args shape varies per function
          args: args as any,
          account: this.account,
          gas: await gas(),
        }),
      send: async () => this.write(functionName, args, await gas()),
    };
  }

  /**
   * The node estimate plus margin, or undefined when this instance cannot broadcast: a limit
   * only constrains a call that is actually sent, and read-only mode must fail on the missing
   * wallet rather than on a wasted estimate.
   */
  private async gasLimit(
    functionName: string,
    args: readonly unknown[],
  ): Promise<bigint | undefined> {
    if (!this.account || !this.walletClient) return undefined;
    const estimate = await this.publicClient.estimateContractGas({
      address: this.address,
      abi: ARBITRAGE_ABI,
      // biome-ignore lint/suspicious/noExplicitAny: generic pass-through over parseAbi overloads
      functionName: functionName as any,
      // biome-ignore lint/suspicious/noExplicitAny: args shape varies per function
      args: args as any,
      account: this.account,
    });
    return (estimate * (10_000n + GAS_LIMIT_MARGIN_BPS)) / 10_000n;
  }

  /** Simulate to build the request (revert-safe), then broadcast it at that same gas limit. */
  private async write(
    functionName: string,
    args: readonly unknown[],
    gas: bigint | undefined,
  ): Promise<Hash> {
    if (!this.walletClient) throw new Error("Arbitrage.write: no wallet client (read-only mode)");
    const {request} = await this.publicClient.simulateContract({
      address: this.address,
      abi: ARBITRAGE_ABI,
      // biome-ignore lint/suspicious/noExplicitAny: generic pass-through over parseAbi overloads
      functionName: functionName as any,
      // biome-ignore lint/suspicious/noExplicitAny: args shape varies per function
      args: args as any,
      account: this.account,
      gas,
    });
    // biome-ignore lint/suspicious/noExplicitAny: request type is the simulate union
    return this.walletClient.writeContract(request as any);
  }
}
