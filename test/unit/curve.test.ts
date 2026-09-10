// CurveQuoter: get_dy(i,j,dx) so quotes include price impact. It tries the int128-index ABI first
// and falls back to the uint256-index ABI (NG pools), and chains VUSD -> crvUSD -> sVUSD.

import type {PublicClient} from "viem";
import {describe, expect, it, vi} from "vitest";
import {POOL_CRVUSD_SVUSD, POOL_VUSD_CRVUSD} from "../../src/constants.js";
import {CurveQuoter} from "../../src/curve.js";

function quoterWith(readContract: ReturnType<typeof vi.fn>) {
  return new CurveQuoter({readContract} as unknown as PublicClient);
}

describe("CurveQuoter", () => {
  it("chains both hops: VUSD -> crvUSD -> sVUSD", async () => {
    const readContract = vi.fn().mockResolvedValueOnce(500n).mockResolvedValueOnce(480n);
    const out = await quoterWith(readContract).vusdToSvusd(1_000n);
    expect(out).toBe(480n);
    expect(readContract).toHaveBeenCalledTimes(2);
    expect(readContract.mock.calls[0][0]).toMatchObject({
      address: POOL_VUSD_CRVUSD.address,
      functionName: "get_dy",
      args: [0n, 1n, 1_000n],
    });
    expect(readContract.mock.calls[1][0]).toMatchObject({
      address: POOL_CRVUSD_SVUSD.address,
      functionName: "get_dy",
      args: [0n, 1n, 500n],
    });
  });

  it("falls back to the uint256-index ABI when the int128 call reverts", async () => {
    const readContract = vi
      .fn()
      .mockRejectedValueOnce(new Error("no int128 get_dy"))
      .mockResolvedValueOnce(777n);
    const out = await quoterWith(readContract).vusdToCrvusd(1_000n);
    expect(out).toBe(777n);
    expect(readContract).toHaveBeenCalledTimes(2); // int128 attempt, then uint256 fallback
    // The retry must use a DIFFERENT (uint256) ABI, not re-issue the same int128 call.
    const abi0 = (readContract.mock.calls[0][0] as {abi: unknown}).abi;
    const abi1 = (readContract.mock.calls[1][0] as {abi: unknown}).abi;
    expect(abi1).not.toBe(abi0);
  });

  it("propagates when both index ABIs revert", async () => {
    const readContract = vi.fn().mockRejectedValue(new Error("dead pool"));
    await expect(quoterWith(readContract).crvusdToSvusd(1_000n)).rejects.toThrow("dead pool");
  });
});
