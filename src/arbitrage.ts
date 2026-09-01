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
  "function settlePosition(uint256 requestId, uint256 minVusdOut) returns (int256 profit)",
  "function openRequestIds() view returns (uint256[])",
  "function openRequestCount() view returns (uint256)",
  "function lockedVusdOf(uint256 requestId) view returns (uint256)",
  "function entryVusdOf(uint256 requestId) view returns (uint256)",
  "function isKeeper(address account) view returns (bool)",
  "function allowedSwapAddress(address account) view returns (bool)",
  "function minProfitBps() view returns (uint256)",
]);

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

  allowedSwapAddress(account: Address): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.address,
      abi: ARBITRAGE_ABI,
      functionName: "allowedSwapAddress",
      args: [account],
    });
  }

  /** Simulate/send pair for `openPosition(vusdAmount, buy, minProfit)`. */
  openPosition(vusdAmount: bigint, buy: EntrySwap, minProfit: bigint) {
    const args = [vusdAmount, buy, minProfit] as const;
    return {
      simulate: () =>
        this.publicClient.simulateContract({
          address: this.address,
          abi: ARBITRAGE_ABI,
          functionName: "openPosition",
          args,
          account: this.account,
        }),
      send: () => this.write("openPosition", args),
    };
  }

  /** Simulate/send pair for `settlePosition(requestId, minVusdOut)`. */
  settlePosition(requestId: bigint, minVusdOut: bigint) {
    const args = [requestId, minVusdOut] as const;
    return {
      simulate: () =>
        this.publicClient.simulateContract({
          address: this.address,
          abi: ARBITRAGE_ABI,
          functionName: "settlePosition",
          args,
          account: this.account,
        }),
      send: () => this.write("settlePosition", args),
    };
  }

  /** Simulate to build the request (revert-safe), then broadcast it. */
  private async write(functionName: string, args: readonly unknown[]): Promise<Hash> {
    if (!this.walletClient) throw new Error("Arbitrage.write: no wallet client (read-only mode)");
    const {request} = await this.publicClient.simulateContract({
      address: this.address,
      abi: ARBITRAGE_ABI,
      // biome-ignore lint/suspicious/noExplicitAny: generic pass-through over parseAbi overloads
      functionName: functionName as any,
      // biome-ignore lint/suspicious/noExplicitAny: args shape varies per function
      args: args as any,
      account: this.account,
    });
    // biome-ignore lint/suspicious/noExplicitAny: request type is the simulate union
    return this.walletClient.writeContract(request as any);
  }
}
