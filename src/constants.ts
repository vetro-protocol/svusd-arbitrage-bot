/**
 * Mainnet ground truth for the sVUSD arbitrage.
 *
 * All addresses verified on-chain (2026-08-27). See the repo README for the
 * mechanism writeup. Values here are public and committed on purpose; operators
 * only override runtime settings via .env.
 *
 * The strategy is VUSD-native (VUSD in, VUSD out): buy sVUSD below fair value on
 * Curve with VUSD, redeem it through the 7-day cooldown, and claim VUSD back. It
 * never touches the VUSD Gateway, so no stable/Gateway addresses live here.
 */

// ── Core tokens ──────────────────────────────────────────────────────────────
/** Staked Vetro USD: an ERC4626 `StakingVault` over VUSD with a 7-day cooldown. */
export const SVUSD_ADDRESS = "0x476310E34D2810f7d79C43A74E4D79405bd7a925";
/** VUSD: the vault's underlying asset, the reserve currency, and the claim payout. */
export const VUSD_ADDRESS = "0xCa83DDE9c22254f58e771bE5E157773212AcBAc3";
/** crvUSD: the asset sVUSD is paired against on a DEX (the middle hop). */
export const CRVUSD_ADDRESS = "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E";

// ── Curve pools (plain pools; quoted via get_dy(i, j, dx)) ───────────────────
/** VUSD/crvUSD: entry hop VUSD to crvUSD. coin0=VUSD, coin1=crvUSD. */
export const POOL_VUSD_CRVUSD = {
  address: "0xAFbA5800252530CE71b03Ba2BCa2Dd5aE44a7F3d",
  vusdIndex: 0,
  crvusdIndex: 1,
};
/** crvUSD/sVUSD: the ONLY venue for sVUSD. coin0=crvUSD, coin1=sVUSD. ~$43k liq. */
export const POOL_CRVUSD_SVUSD = {
  address: "0x659B7B5Dd7936BF2f2d198A87C1583049D1D91d3",
  crvusdIndex: 0,
  svusdIndex: 1,
};

// ── Token decimals ───────────────────────────────────────────────────────────
export const DECIMALS: Record<string, number> = {
  [SVUSD_ADDRESS.toLowerCase()]: 18,
  [VUSD_ADDRESS.toLowerCase()]: 18,
  [CRVUSD_ADDRESS.toLowerCase()]: 18,
};

/** VUSD (and sVUSD/crvUSD) are all 18-decimal. */
export const VUSD_DECIMALS = 18;

/** Fixed 7-day cooldown at time of writing; the bot re-reads it live each poll. */
export const COOLDOWN_DURATION_FALLBACK_S = 604800;
