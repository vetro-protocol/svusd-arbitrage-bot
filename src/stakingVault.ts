import {ethers} from "ethers";
import {SVUSD_ADDRESS} from "./constants.js";
import type {VaultState} from "./types.js";

/**
 * Reader for the sVUSD `StakingVault` (ERC4626 + request/claim cooldown).
 *
 * Only the views the bot needs. The write path (requestRedeem / claimWithdraw)
 * lives in the arbitrage contract, not here; this module never signs.
 */
const VAULT_ABI = [
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function cooldownDuration() view returns (uint256)",
  "function cooldownEnabled() view returns (bool)",
  // maxRedeem returns 0 unless the owner can instant-withdraw (whitelisted or
  // cooldown disabled); we use it to detect whether the arb is atomic-eligible.
  "function maxRedeem(address owner) view returns (uint256)",
];

const ONE_SHARE = 10n ** 18n;

export class StakingVault {
  private vault: ethers.Contract;

  constructor(provider: ethers.Provider) {
    this.vault = new ethers.Contract(SVUSD_ADDRESS, VAULT_ABI, provider);
  }

  /** VUSD (1e18) claimable for `shares` sVUSD, at the current (locked-on-request) rate. */
  async previewRedeem(shares: bigint): Promise<bigint> {
    return this.vault.previewRedeem(shares);
  }

  /**
   * Read live vault state. `arbAddress` is the (future) arbitrage contract; when
   * undefined we probe with the zero address, which is never whitelisted, so
   * instantWithdrawAvailable reflects only the global cooldownEnabled flag.
   */
  async readState(arbAddress?: string): Promise<VaultState> {
    const probe = arbAddress ?? ethers.ZeroAddress;
    const [assetsPerShare, cooldownSeconds, cooldownEnabled, maxRedeem] = await Promise.all([
      this.vault.previewRedeem(ONE_SHARE) as Promise<bigint>,
      this.vault.cooldownDuration() as Promise<bigint>,
      this.vault.cooldownEnabled() as Promise<boolean>,
      this.vault.maxRedeem(probe) as Promise<bigint>,
    ]);

    return {
      fairValueVusdPerShare: Number(assetsPerShare) / 1e18,
      cooldownSeconds: Number(cooldownSeconds),
      cooldownEnabled,
      // Instant (atomic) redeem is possible when maxRedeem > 0 for our address.
      instantWithdrawAvailable: maxRedeem > 0n,
    };
  }
}
