import {type Address, formatEther} from "viem";
import type {Config} from "./config.js";
import type {CurveQuoter} from "./curve.js";
import {quoteEntry} from "./quote.js";
import type {StakingVault} from "./stakingVault.js";
import type {Opportunity, VaultState} from "./types.js";

/**
 * The economic core. For each probe size it simulates the VUSD-native round trip
 * through real on-chain quotes and reports the NET spread:
 *
 *   VUSD  --Curve--> crvUSD --Curve--> sVUSD          (entry, impact included)
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
    private curve: CurveQuoter,
    private vault: StakingVault,
  ) {}

  async readVault(): Promise<VaultState> {
    return this.vault.readState(this.config.arbitrageAddress as Address | undefined);
  }

  /** Simulate one probe size. Returns null if any leg fails to quote. */
  async evaluate(vusdAmount: bigint, minProfitBps: number): Promise<Opportunity | null> {
    // Buy sVUSD (impact included), then the VUSD requestRedeem would lock for it (rate fixed at request).
    const {shares: sharesOut, locked: vusdLocked} = await quoteEntry(
      this.curve,
      this.vault,
      vusdAmount,
    );
    if (sharesOut <= 0n || vusdLocked <= 0n) return null;

    // Money math in base units so the gate is bit-exact with the contract; only prices and
    // bps (ratios, not amounts) are floats, derived for display.
    const grossProfitVusd = vusdLocked - vusdAmount;
    const netProfitVusd = grossProfitVusd - this.config.estimatedGasCostVusd;
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
    };
  }

  /** Evaluate every configured probe size against `minProfitBps`. Best (highest buffered net) first. */
  async scan(minProfitBps: number): Promise<Opportunity[]> {
    const results = await Promise.all(
      this.config.probeAmounts.map((a) =>
        this.evaluate(a, minProfitBps).catch((e) => {
          console.warn(
            `  probe ${formatEther(a)}: quote failed: ${e instanceof Error ? e.message : e}`,
          );
          return null;
        }),
      ),
    );
    return results
      .filter((o): o is Opportunity => o !== null)
      .sort((a, b) => Number(b.netProfitAfterBufferVusd - a.netProfitAfterBufferVusd));
  }
}
