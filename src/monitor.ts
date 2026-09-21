import {type Address, formatEther, type PublicClient, parseAbi} from "viem";
import type {Config} from "./config.js";
import {ETH_USD_FEED} from "./constants.js";
import {perGasWei} from "./gas.js";
import {quoteEntry} from "./quote.js";
import {errorText} from "./redact.js";
import type {EntryPlan, EntryRouter} from "./router.js";
import type {StakingVault} from "./stakingVault.js";
import type {Opportunity, VaultState} from "./types.js";

/** Chainlink ETH/USD, 8 decimals; `updatedAt` feeds the staleness check. */
const ETH_USD_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);
/** Reject an ETH/USD reading older than this; well past the feed's ~1h heartbeat. */
const ETH_USD_MAX_STALENESS_S = 3 * 3600;

/** An opportunity plus the winning venue's plan, so the open job can rebuild the exact swap. */
export interface EvaluatedOpportunity extends Opportunity {
  plan: EntryPlan;
}

/**
 * The economic core. For each probe size it simulates the VUSD-native round trip
 * through real on-chain quotes and reports the NET spread:
 *
 *   VUSD  --best venue--> sVUSD                        (entry, impact included)
 *   sVUSD --requestRedeem--> VUSD locked at rate       (fixed for 7 days)
 *   VUSD  --claimWithdraw--> reserves                  (no exit swap, no Gateway)
 *
 * Profit (VUSD) = vusdLocked − vusdAmount − gas, then minus a prudence buffer. The
 * spread is VUSD-denominated and fixed at open, so VUSD depeg does not erode it.
 *
 * The gate mirrors the contract's `open` floor (spent + max(minProfit, bps)), so
 * the monitor never flags an opportunity the on-chain contract would reject.
 */
export class Monitor {
  constructor(
    private config: Config,
    private router: EntryRouter,
    private vault: StakingVault,
    private publicClient?: PublicClient,
  ) {}

  async readVault(): Promise<VaultState> {
    return this.vault.readState(this.config.arbitrageAddress as Address | undefined);
  }

  /**
   * Live round-trip gas cost in VUSD: `gasPrice * gasUnitsPerRoundTrip * ETH/USD` (gas is paid in
   * ETH, profit is VUSD). Returns null when it can't be priced safely; null pauses opens while
   * settles, which never price gas, keep running. No guessed static fallback.
   */
  async currentGasCostVusd(): Promise<bigint | null> {
    if (!this.publicClient) return null;
    try {
      const [gasPriceWei, round] = await Promise.all([
        perGasWei(this.publicClient),
        this.publicClient.readContract({
          address: ETH_USD_FEED,
          abi: ETH_USD_ABI,
          functionName: "latestRoundData",
        }),
      ]);
      const [, ethUsd, , updatedAt] = round;
      if (gasPriceWei <= 0n || ethUsd <= 0n) return null;
      // Mirror the executor's broadcast cap so the two never disagree on what's actionable.
      if (gasPriceWei > BigInt(this.config.maxGasPriceGwei) * 1_000_000_000n) return null;
      const ageS = Math.floor(Date.now() / 1000) - Number(updatedAt);
      if (ageS > ETH_USD_MAX_STALENESS_S) return null;
      // gasPriceWei (1e18 ETH) * gasUnits = wei of ETH; * ethUsd (1e8) / 1e8 = VUSD base units (1e18).
      const gasCostWei = gasPriceWei * BigInt(this.config.gasUnitsPerRoundTrip);
      return (gasCostWei * ethUsd) / 100_000_000n;
    } catch (e) {
      console.warn(`  gas price/ETH-USD read failed, pausing opens: ${errorText(e)}`);
      return null;
    }
  }

  /**
   * Simulate one probe size. Returns null with no venue quote or unpriceable gas. Prices gas live
   * unless a cost is passed (explicit null = unpriceable).
   */
  async evaluate(
    vusdAmount: bigint,
    minProfitBps: number,
    gasCostVusd?: bigint | null,
  ): Promise<EvaluatedOpportunity | null> {
    // Buy sVUSD on the best venue (impact included), then the VUSD requestRedeem would lock for it.
    const quote = await quoteEntry(this.router, this.vault, vusdAmount);
    if (!quote) return null;
    const {shares: sharesOut, locked: vusdLocked, plan} = quote;
    if (sharesOut <= 0n || vusdLocked <= 0n) return null;

    // Money math in base units so the gate is bit-exact with the contract; only prices and
    // bps (ratios, not amounts) are floats, derived for display.
    const gasCost = gasCostVusd === undefined ? await this.currentGasCostVusd() : gasCostVusd;
    if (gasCost === null) return null;
    const grossProfitVusd = vusdLocked - vusdAmount;
    const netProfitVusd = grossProfitVusd - gasCost;
    const buffer = (vusdAmount * BigInt(this.config.bufferBps)) / 10_000n;
    const netProfitAfterBufferVusd = netProfitVusd - buffer;

    // Mirror the contract's static floor exactly: spent + ceilDiv(spent*bps, 1e4). The per-open
    // minProfit the job derives from a fresh quote is self-consistent with this, so it never binds here.
    const bpsFloor = (vusdAmount * BigInt(minProfitBps) + 9_999n) / 10_000n;
    const contractFloorVusd = vusdAmount + bpsFloor;
    const meetsContractFloor = vusdLocked >= contractFloorVusd;

    const size = Number(formatEther(vusdAmount));
    const dexBuyPrice = size / Number(formatEther(sharesOut));
    const grossSpreadBps = (Number(formatEther(grossProfitVusd)) / size) * 10_000;

    return {
      vusdAmount,
      sharesOut,
      dexBuyPrice,
      vusdLocked,
      grossProfitVusd,
      grossSpreadBps,
      netProfitVusd,
      netProfitAfterBufferVusd,
      contractFloorVusd,
      profitable: meetsContractFloor && netProfitAfterBufferVusd >= 0n,
      plan,
    };
  }

  /** Evaluate every configured probe size against `minProfitBps`. Best (highest buffered net) first. */
  async scan(minProfitBps: number, gasCostVusd?: bigint | null): Promise<EvaluatedOpportunity[]> {
    // Price gas once per tick; all probes share it.
    const gasCost = gasCostVusd === undefined ? await this.currentGasCostVusd() : gasCostVusd;
    const results = await Promise.all(
      this.config.probeAmounts.map((a) =>
        this.evaluate(a, minProfitBps, gasCost).catch((e) => {
          console.warn(`  probe ${formatEther(a)}: quote failed: ${errorText(e)}`);
          return null;
        }),
      ),
    );
    return results
      .filter((o): o is EvaluatedOpportunity => o !== null)
      .sort((a, b) => Number(b.netProfitAfterBufferVusd - a.netProfitAfterBufferVusd));
  }
}
