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

import type {Address} from "viem";
import {zeroAddress} from "viem";

/** Ethereum mainnet; the bot is mainnet-only, but the aggregator APIs are chain-scoped. */
export const CHAIN_ID = 1;

// ── Core tokens ──────────────────────────────────────────────────────────────
/** Staked Vetro USD: an ERC4626 `StakingVault` over VUSD with a 7-day cooldown. */
export const SVUSD_ADDRESS: Address = "0x476310E34D2810f7d79C43A74E4D79405bd7a925";
/** VUSD: the vault's underlying asset, the reserve currency, and the claim payout. */
export const VUSD_ADDRESS: Address = "0xCa83DDE9c22254f58e771bE5E157773212AcBAc3";
/** crvUSD: the asset sVUSD is paired against on a DEX (the middle hop). */
export const CRVUSD_ADDRESS: Address = "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E";

// ── Curve pools (plain pools; quoted via get_dy(i, j, dx)) ───────────────────
/** VUSD/crvUSD: entry hop VUSD to crvUSD. coin0=VUSD, coin1=crvUSD. */
export const POOL_VUSD_CRVUSD = {
  address: "0xAFbA5800252530CE71b03Ba2BCa2Dd5aE44a7F3d" as Address,
  vusdIndex: 0,
  crvusdIndex: 1,
};
/** crvUSD/sVUSD: the ONLY venue for sVUSD. coin0=crvUSD, coin1=sVUSD. ~$43k liq. */
export const POOL_CRVUSD_SVUSD = {
  address: "0x659B7B5Dd7936BF2f2d198A87C1583049D1D91d3" as Address,
  crvusdIndex: 0,
  svusdIndex: 1,
};

// ── Curve router (chains both hops in one call) ──────────────────────────────
/** CurveRouterNG (Router v1.2): the swap `target`/`approveTarget` for the native-Curve entry. */
export const CURVE_ROUTER: Address = "0x16C6521Dff6baB339122a0FE25a9116693265353";

/**
 * Fixed VUSD→sVUSD route for the router's `exchange`, as the exact-length tuples
 * (address[11], uint256[5][5], address[5]) the ABI demands. Each `_swap_params`
 * row is [i, j, swap_type, pool_type, n_coins]; both legs are StableSwap plain
 * pools quoting coin0→coin1, so [0, 1, 1, 1, 2] twice, then zero-padding.
 */
export const CURVE_ROUTE = [
  VUSD_ADDRESS,
  POOL_VUSD_CRVUSD.address,
  CRVUSD_ADDRESS,
  POOL_CRVUSD_SVUSD.address,
  SVUSD_ADDRESS,
  zeroAddress,
  zeroAddress,
  zeroAddress,
  zeroAddress,
  zeroAddress,
  zeroAddress,
] as const satisfies readonly Address[];
export const CURVE_SWAP_PARAMS = [
  [0n, 1n, 1n, 1n, 2n],
  [0n, 1n, 1n, 1n, 2n],
  [0n, 0n, 0n, 0n, 0n],
  [0n, 0n, 0n, 0n, 0n],
  [0n, 0n, 0n, 0n, 0n],
] as const;
export const CURVE_ROUTE_POOLS = [
  POOL_VUSD_CRVUSD.address,
  POOL_CRVUSD_SVUSD.address,
  zeroAddress,
  zeroAddress,
  zeroAddress,
] as const satisfies readonly Address[];

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

// ── Deployment (Ethereum mainnet) ─────────────────────────────────────────────
/** The deployed SVusdArbitrage custody contract. Runtime `ARBITRAGE_ADDRESS` overrides it (e.g. a redeploy). */
export const ARBITRAGE_ADDRESS: Address = "0x2B66E41fE0Be93c7f68B8fB2F2d9274f2Bc73aE6";
/** The keeper EOA the bot signs as. On-chain `getKeepers()` is authoritative; update here if rotated. */
export const KEEPER_ADDRESS: Address = "0x30719E2c487e1367cF99d200F376CeE21839b5dB";
