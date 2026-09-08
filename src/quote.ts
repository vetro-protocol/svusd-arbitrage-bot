import type {EntryPlan, EntryRouter} from "./router.js";
import type {StakingVault} from "./stakingVault.js";

/**
 * Fresh entry quote for `vusdAmount` (base units): the sVUSD shares the best venue buys
 * (price impact included) and the VUSD those shares would lock at the current redeem rate.
 * The single source of this quote for both the monitor (decision) and the open job (the
 * floors and swap it passes to `openPosition`), so the two can never derive it differently.
 */
export interface EntryQuote {
  shares: bigint;
  locked: bigint;
  plan: EntryPlan;
}

export async function quoteEntry(
  router: EntryRouter,
  vault: StakingVault,
  vusdAmount: bigint,
): Promise<EntryQuote | null> {
  const plan = await router.bestEntry(vusdAmount);
  if (!plan || plan.sharesOut <= 0n) return null;
  const locked = await vault.previewRedeem(plan.sharesOut);
  return {shares: plan.sharesOut, locked, plan};
}
