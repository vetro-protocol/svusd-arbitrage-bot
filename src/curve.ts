import {type PublicClient, parseAbi} from "viem";
import {POOL_CRVUSD_SVUSD, POOL_VUSD_CRVUSD} from "./constants.js";

/**
 * Curve plain-pool quoter. Uses each pool's `get_dy(i, j, dx)` so the returned
 * amounts INCLUDE price impact, essential on the thin (~$43k) sVUSD pool where
 * impact, not headline price, decides whether an arb clears.
 *
 * The arb entry is VUSD → crvUSD → sVUSD (both hops on Curve, VUSD-native).
 */
const POOL_ABI = parseAbi([
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
]);
// Some Curve NG pools use uint256 indices; we try int128 first, then uint256.
const POOL_ABI_UINT = parseAbi([
  "function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)",
]);

export class CurveQuoter {
  constructor(private client: PublicClient) {}

  private async getDy(address: `0x${string}`, i: number, j: number, dx: bigint): Promise<bigint> {
    const args = [BigInt(i), BigInt(j), dx] as const;
    try {
      return await this.client.readContract({address, abi: POOL_ABI, functionName: "get_dy", args});
    } catch {
      return await this.client.readContract({
        address,
        abi: POOL_ABI_UINT,
        functionName: "get_dy",
        args,
      });
    }
  }

  /** VUSD (1e18) → crvUSD (1e18), through the VUSD/crvUSD pool. */
  async vusdToCrvusd(vusdIn: bigint): Promise<bigint> {
    return this.getDy(
      POOL_VUSD_CRVUSD.address,
      POOL_VUSD_CRVUSD.vusdIndex,
      POOL_VUSD_CRVUSD.crvusdIndex,
      vusdIn,
    );
  }

  /** crvUSD (1e18) → sVUSD (1e18), through the crvUSD/sVUSD pool. */
  async crvusdToSvusd(crvusdIn: bigint): Promise<bigint> {
    return this.getDy(
      POOL_CRVUSD_SVUSD.address,
      POOL_CRVUSD_SVUSD.crvusdIndex,
      POOL_CRVUSD_SVUSD.svusdIndex,
      crvusdIn,
    );
  }

  /** Full entry leg: VUSD → crvUSD → sVUSD. Returns sVUSD shares out (1e18), impact included. */
  async vusdToSvusd(vusdIn: bigint): Promise<bigint> {
    const crvusd = await this.vusdToCrvusd(vusdIn);
    return this.crvusdToSvusd(crvusd);
  }
}
