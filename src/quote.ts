import type {CurveQuoter} from "./curve.js";
import type {StakingVault} from "./stakingVault.js";

/**
 * Fresh on-chain entry quote for `sizeUnits` VUSD: the sVUSD shares the Curve buy yields
 * (price impact included) and the VUSD those shares would lock at the current redeem rate.
 * The single source of this quote for both the monitor (decision) and the open job (the
 * floors it passes to `openPosition`), so the two can never derive it differently.
 */
export interface EntryQuote {
  shares: bigint;
  locked: bigint;
}

export async function quoteEntry(
  curve: CurveQuoter,
  vault: StakingVault,
  sizeUnits: bigint,
): Promise<EntryQuote> {
  const shares = await curve.vusdToSvusd(sizeUnits);
  const locked = shares > 0n ? await vault.previewRedeem(shares) : 0n;
  return {shares, locked};
}
