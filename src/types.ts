/** Live state read from the sVUSD StakingVault each poll. */
export interface VaultState {
  /** Assets (VUSD, 1e18) claimable per 1e18 sVUSD at the current rate. */
  fairValueVusdPerShare: number;
  /** Cooldown seconds (re-read live; admin can change it). */
  cooldownSeconds: number;
  cooldownEnabled: boolean;
  /** True if the arbitrage contract is whitelisted for instant (atomic) redeem. */
  instantWithdrawAvailable: boolean;
}

/**
 * One simulated round trip at a given probe size, quoted through the real pools.
 * The strategy is VUSD-native, so every monetary field is in VUSD (human units,
 * 1e18 on-chain). There is no exit leg: the profit is the difference between the
 * VUSD the redemption locks and the VUSD spent, and it is fixed at open.
 */
export interface Opportunity {
  /** VUSD notional spent on the entry (base units, the probe size). */
  vusdAmount: bigint;
  /** sVUSD shares the entry buys (after Curve price impact), 1e18. */
  sharesOut: bigint;
  /** Effective DEX buy price of sVUSD, in VUSD per share (a ratio, display only). */
  dexBuyPrice: number;
  /** VUSD locked by requestRedeem for those shares (fixed at request), 1e18. */
  vusdLocked: bigint;
  /** Gross profit over cost, before gas and buffer (VUSD, base units). */
  grossProfitVusd: bigint;
  /** Gross spread over cost, before gas and buffer (bps of size, a ratio, display only). */
  grossSpreadBps: number;
  /** Net profit after gas (VUSD, base units). */
  netProfitVusd: bigint;
  /** Net profit after gas AND the prudence buffer (VUSD, base units). The gate uses this. */
  netProfitAfterBufferVusd: bigint;
  /** Minimum VUSD payout the contract's `open` floor would demand for this size (base units). */
  contractFloorVusd: bigint;
  /** True when the contract would accept the open AND the buffered net clears the gate. */
  profitable: boolean;
}
