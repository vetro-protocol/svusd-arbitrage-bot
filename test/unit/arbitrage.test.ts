// Arbitrage: the thin wrapper over the custody contract. Reads pass through to readContract; the two
// keeper writes are simulate/send thunks, and send refuses to run without a wallet (read-only mode).

import type {Account, PublicClient, WalletClient} from "viem";
import {describe, expect, it, vi} from "vitest";
import {Arbitrage} from "../../src/arbitrage.js";
import type {EntrySwap} from "../../src/swapBuilder.js";
import {ARB, KEEPER, RECEIVER} from "./helpers.js";

const BUY: EntrySwap = {
  target: RECEIVER,
  approveTarget: RECEIVER,
  swapCalldata: "0x",
  minAmountOut: 1n,
};

function arbWith(opts: {readValue?: unknown; simulateReturn?: unknown; hasWallet?: boolean} = {}) {
  const readContract = vi.fn().mockResolvedValue(opts.readValue);
  const simulateContract = vi
    .fn()
    .mockResolvedValue(opts.simulateReturn ?? {request: {tag: "req"}});
  const writeContract = vi.fn().mockResolvedValue("0xhash");
  const publicClient = {readContract, simulateContract} as unknown as PublicClient;
  const walletClient = opts.hasWallet ? ({writeContract} as unknown as WalletClient) : undefined;
  const arb = new Arbitrage(ARB, publicClient, walletClient, {address: KEEPER} as Account);
  return {arb, readContract, simulateContract, writeContract};
}

describe("Arbitrage reads", () => {
  it("openRequestIds passes through", async () => {
    const {arb, readContract} = arbWith({readValue: [1n, 2n]});
    expect(await arb.openRequestIds()).toEqual([1n, 2n]);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({functionName: "openRequestIds"}),
    );
  });

  it("lockedVusdOf and isKeeper forward their args", async () => {
    const locked = arbWith({readValue: 100n});
    expect(await locked.arb.lockedVusdOf(5n)).toBe(100n);
    expect(locked.readContract).toHaveBeenCalledWith(
      expect.objectContaining({functionName: "lockedVusdOf", args: [5n]}),
    );

    const keeper = arbWith({readValue: true});
    expect(await keeper.arb.isKeeper(KEEPER)).toBe(true);
    expect(keeper.readContract).toHaveBeenCalledWith(
      expect.objectContaining({functionName: "isKeeper", args: [KEEPER]}),
    );
  });

  it("minProfitBps passes through", async () => {
    const {arb, readContract} = arbWith({readValue: 30n});
    expect(await arb.minProfitBps()).toBe(30n);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({functionName: "minProfitBps"}),
    );
  });
});

describe("Arbitrage writes", () => {
  it("openPosition().simulate forwards fn, args, and account", async () => {
    const {arb, simulateContract} = arbWith();
    await arb.openPosition(1_000n, BUY, 5n).simulate();
    expect(simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "openPosition",
        args: [1_000n, BUY, 5n],
        account: {address: KEEPER},
      }),
    );
  });

  it("send simulates to build the request, then writes it", async () => {
    const {arb, writeContract} = arbWith({
      hasWallet: true,
      simulateReturn: {request: {tag: "built"}},
    });
    expect(await arb.settlePosition(9n).send()).toBe("0xhash");
    expect(writeContract).toHaveBeenCalledWith({tag: "built"});
  });

  it("send refuses without a wallet client (read-only mode)", async () => {
    const {arb} = arbWith({hasWallet: false});
    await expect(arb.settleClaimablePositions(20n).send()).rejects.toThrow("no wallet client");
  });
});
