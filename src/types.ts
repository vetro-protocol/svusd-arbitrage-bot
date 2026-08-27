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
  /** VUSD notional spent on the entry (probe size). */
  sizeVusd: number;
  /** sVUSD shares the entry buys (after Curve price impact), 1e18. */
  sharesOut: bigint;
  /** Effective DEX buy price of sVUSD, in VUSD per share. */
  dexBuyPrice: number;
  /** VUSD locked by requestRedeem for those shares (fixed at request), 1e18. */
  vusdLocked: bigint;
  /** Gross profit over cost, before gas and buffer (VUSD). */
  grossProfitVusd: number;
  /** Gross spread over cost, before gas and buffer (bps of size). */
  grossSpreadBps: number;
  /** Net profit after gas, in VUSD. */
  netProfitVusd: number;
  /** Net profit after gas AND the prudence buffer, in VUSD. The gate uses this. */
  netProfitAfterBufferVusd: number;
  /** Minimum VUSD payout the contract's `open` floor would demand for this size. */
  contractFloorVusd: number;
  /** True when the contract would accept the open AND the buffered net clears the gate. */
  profitable: boolean;
}
