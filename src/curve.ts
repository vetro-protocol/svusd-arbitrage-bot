import {ethers} from "ethers";
import {POOL_CRVUSD_SVUSD, POOL_VUSD_CRVUSD} from "./constants.js";

/**
 * Curve plain-pool quoter. Uses each pool's `get_dy(i, j, dx)` so the returned
 * amounts INCLUDE price impact, essential on the thin (~$43k) sVUSD pool where
 * impact, not headline price, decides whether an arb clears.
 *
 * The arb entry is VUSD → crvUSD → sVUSD (both hops on Curve, VUSD-native).
 */
const POOL_ABI = ["function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)"];
// Some Curve NG pools use uint256 indices; we try int128 first, then uint256.
const POOL_ABI_UINT = ["function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)"];

export class CurveQuoter {
  private svusdPoolI128: ethers.Contract;
  private svusdPoolU256: ethers.Contract;
  private entryPoolI128: ethers.Contract;
  private entryPoolU256: ethers.Contract;

  constructor(provider: ethers.Provider) {
    this.svusdPoolI128 = new ethers.Contract(POOL_CRVUSD_SVUSD.address, POOL_ABI, provider);
    this.svusdPoolU256 = new ethers.Contract(POOL_CRVUSD_SVUSD.address, POOL_ABI_UINT, provider);
    this.entryPoolI128 = new ethers.Contract(POOL_VUSD_CRVUSD.address, POOL_ABI, provider);
    this.entryPoolU256 = new ethers.Contract(POOL_VUSD_CRVUSD.address, POOL_ABI_UINT, provider);
  }

  private async getDy(
    i128: ethers.Contract,
    u256: ethers.Contract,
    i: number,
    j: number,
    dx: bigint,
  ): Promise<bigint> {
    try {
      return await i128.get_dy(i, j, dx);
    } catch {
      return await u256.get_dy(i, j, dx);
    }
  }

  /** VUSD (1e18) → crvUSD (1e18), through the VUSD/crvUSD pool. */
  async vusdToCrvusd(vusdIn: bigint): Promise<bigint> {
    return this.getDy(
      this.entryPoolI128,
      this.entryPoolU256,
      POOL_VUSD_CRVUSD.vusdIndex,
      POOL_VUSD_CRVUSD.crvusdIndex,
      vusdIn,
    );
  }

  /** crvUSD (1e18) → sVUSD (1e18), through the crvUSD/sVUSD pool. */
  async crvusdToSvusd(crvusdIn: bigint): Promise<bigint> {
    return this.getDy(
      this.svusdPoolI128,
      this.svusdPoolU256,
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
