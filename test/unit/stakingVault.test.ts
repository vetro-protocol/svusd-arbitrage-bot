// StakingVault: the vault views the bot reads. readState maps the raw reads into VaultState, and the
// instant-redeem probe uses the zero address (never whitelisted) when no arb address is known yet.

import {type PublicClient, zeroAddress} from "viem";
import {describe, expect, it, vi} from "vitest";
import {StakingVault} from "../../src/stakingVault.js";
import {ARB} from "./helpers.js";

type ReadArgs = {functionName: string; args?: readonly unknown[]};

function vaultWith(reads: Record<string, unknown>) {
  const readContract = vi.fn((p: ReadArgs) => Promise.resolve(reads[p.functionName]));
  return {vault: new StakingVault({readContract} as unknown as PublicClient), readContract};
}

describe("StakingVault reads", () => {
  it("previewRedeem returns the vault's quote and forwards the shares arg", async () => {
    const {vault, readContract} = vaultWith({previewRedeem: 1_010n});
    expect(await vault.previewRedeem(1_000n)).toBe(1_010n);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({functionName: "previewRedeem", args: [1_000n]}),
    );
  });

  it("getClaimableRequests returns only the id array (drops the parallel assets array)", async () => {
    const {vault} = vaultWith({
      getClaimableRequests: [
        [1n, 2n, 3n],
        [10n, 20n, 30n],
      ],
    });
    expect(await vault.getClaimableRequests(ARB)).toEqual([1n, 2n, 3n]);
  });

  it("claimableAt returns the unix second as a number", async () => {
    const {vault} = vaultWith({
      getRequestDetails: {owner: ARB, assets: 5n, claimableAt: 1_700_000_000n},
    });
    expect(await vault.claimableAt(42n)).toBe(1_700_000_000);
  });
});

describe("StakingVault.readState", () => {
  const base = {
    previewRedeem: 1_020_000_000_000_000_000n, // 1.02 VUSD per share
    cooldownDuration: 604_800n,
    cooldownEnabled: true,
  };

  it("maps the reads and reports no instant redeem when maxRedeem is 0", async () => {
    const {vault, readContract} = vaultWith({...base, maxRedeem: 0n});
    const state = await vault.readState(ARB);
    expect(state.fairValueVusdPerShare).toBeCloseTo(1.02, 12);
    expect(state.cooldownSeconds).toBe(604_800);
    expect(state.cooldownEnabled).toBe(true);
    expect(state.instantWithdrawAvailable).toBe(false);
    // probed for OUR address when given
    const params = readContract.mock.calls
      .map((c) => c[0] as ReadArgs)
      .find((p) => p.functionName === "maxRedeem");
    expect(params?.args).toEqual([ARB]);
  });

  it("reports instant redeem available when maxRedeem > 0", async () => {
    const {vault} = vaultWith({...base, maxRedeem: 1n});
    expect((await vault.readState(ARB)).instantWithdrawAvailable).toBe(true);
  });

  it("probes the zero address when no arb address is known", async () => {
    const {vault, readContract} = vaultWith({...base, maxRedeem: 0n});
    await vault.readState(undefined);
    const params = readContract.mock.calls
      .map((c) => c[0] as ReadArgs)
      .find((p) => p.functionName === "maxRedeem");
    expect(params?.args).toEqual([zeroAddress]);
  });
});
