import {type Address, type PublicClient, parseAbi, zeroAddress} from "viem";
import {SVUSD_ADDRESS} from "./constants.js";
import type {VaultState} from "./types.js";

/**
 * Reader for the sVUSD `StakingVault` (ERC4626 + request/claim cooldown).
 *
 * Only the views the bot needs. The write path (requestRedeem / claimWithdraw)
 * lives in the arbitrage contract, not here; this module never signs.
 */
const VAULT_ABI = parseAbi([
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function cooldownDuration() view returns (uint256)",
  "function cooldownEnabled() view returns (bool)",
  // maxRedeem returns 0 unless the owner can instant-withdraw (whitelisted or
  // cooldown disabled); we use it to detect whether the arb is atomic-eligible.
  "function maxRedeem(address owner) view returns (uint256)",
  "function getRequestDetails(uint256 requestId) view returns ((address owner, uint256 assets, uint256 claimableAt))",
  // Vault-side maturity filter: the ids owned by `account` whose cooldown has elapsed. Lets the
  // settle job skip a per-id claimableAt read per open position.
  "function getClaimableRequests(address account) view returns (uint256[] requestIds, uint256[] assets)",
]);

const ONE_SHARE = 10n ** 18n;

export class StakingVault {
  constructor(private client: PublicClient) {}

  /** VUSD (1e18) claimable for `shares` sVUSD, at the current (locked-on-request) rate. */
  previewRedeem(shares: bigint): Promise<bigint> {
    return this.client.readContract({
      address: SVUSD_ADDRESS,
      abi: VAULT_ABI,
      functionName: "previewRedeem",
      args: [shares],
    });
  }

  /** Request ids owned by `account` whose cooldown has elapsed, filtered by the vault itself. */
  async getClaimableRequests(account: Address): Promise<readonly bigint[]> {
    const [requestIds] = await this.client.readContract({
      address: SVUSD_ADDRESS,
      abi: VAULT_ABI,
      functionName: "getClaimableRequests",
      args: [account],
    });
    return requestIds;
  }

  /** Unix second at which `requestId` becomes claimable (0 if unknown). */
  async claimableAt(requestId: bigint): Promise<number> {
    const details = await this.client.readContract({
      address: SVUSD_ADDRESS,
      abi: VAULT_ABI,
      functionName: "getRequestDetails",
      args: [requestId],
    });
    return Number(details.claimableAt);
  }

  /**
   * Read live vault state. `arbAddress` is the (future) arbitrage contract; when
   * undefined we probe with the zero address, which is never whitelisted, so
   * instantWithdrawAvailable reflects only the global cooldownEnabled flag.
   */
  async readState(arbAddress?: Address): Promise<VaultState> {
    const probe = arbAddress ?? zeroAddress;
    const [assetsPerShare, cooldownSeconds, cooldownEnabled, maxRedeem] = await Promise.all([
      this.previewRedeem(ONE_SHARE),
      this.client.readContract({
        address: SVUSD_ADDRESS,
        abi: VAULT_ABI,
        functionName: "cooldownDuration",
      }),
      this.client.readContract({
        address: SVUSD_ADDRESS,
        abi: VAULT_ABI,
        functionName: "cooldownEnabled",
      }),
      this.client.readContract({
        address: SVUSD_ADDRESS,
        abi: VAULT_ABI,
        functionName: "maxRedeem",
        args: [probe],
      }),
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
