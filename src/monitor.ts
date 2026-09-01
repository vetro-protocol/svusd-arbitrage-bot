import {type Address, formatUnits, parseUnits} from "viem";
import type {Config} from "./config.js";
import {VUSD_DECIMALS} from "./constants.js";
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
 * Profit (VUSD) = vusdLocked − sizeVusd − gas, then minus a prudence buffer. The
 * spread is VUSD-denominated and fixed at open, so VUSD depeg does not erode it.
 *
 * The gate mirrors the contract's `open` floor (spent + max(minProfit, bps)), so
 * the monitor never flags an opportunity the on-chain contract would reject.
 */
export class Monitor {
  private toVusd: (raw: bigint) => number;
  private toVusdUnits: (human: number) => bigint;

  constructor(
    private config: Config,
    private curve: CurveQuoter,
    private vault: StakingVault,
  ) {
    this.toVusd = (raw) => Number(formatUnits(raw, VUSD_DECIMALS));
    this.toVusdUnits = (human) => parseUnits(human.toFixed(VUSD_DECIMALS), VUSD_DECIMALS);
  }

  async readVault(): Promise<VaultState> {
    return this.vault.readState(this.config.arbitrageAddress as Address | undefined);
  }

  /** Simulate one probe size. Returns null if any leg fails to quote. */
  async evaluate(sizeVusd: number, minProfitBps: number): Promise<Opportunity | null> {
    const sizeUnits = this.toVusdUnits(sizeVusd);

    // Buy sVUSD (impact included), then the VUSD requestRedeem would lock for it (rate fixed at request).
    const {shares: sharesOut, locked: vusdLocked} = await quoteEntry(
      this.curve,
      this.vault,
      sizeUnits,
    );
    if (sharesOut <= 0n || vusdLocked <= 0n) return null;

    const vusdLockedHuman = this.toVusd(vusdLocked);
    const dexBuyPrice = sizeVusd / (Number(sharesOut) / 1e18);

    const grossProfitVusd = vusdLockedHuman - sizeVusd;
    const grossSpreadBps = (grossProfitVusd / sizeVusd) * 10000;

    const netProfitVusd = grossProfitVusd - this.config.estimatedGasCostVusd;
    const buffer = (this.config.bufferBps / 10000) * sizeVusd;
    const netProfitAfterBufferVusd = netProfitVusd - buffer;

    // Mirror the contract's static floor: spent + ceil(spent*bps/1e4). The per-open minProfit the
    // job derives from a fresh simulation is self-consistent with this quote, so it never binds here.
    const contractFloorVusd = sizeVusd + Math.ceil((sizeVusd * minProfitBps) / 10000);

    const meetsContractFloor = vusdLockedHuman >= contractFloorVusd;

    return {
      sizeVusd,
      sharesOut,
      dexBuyPrice,
      vusdLocked,
      grossProfitVusd,
      grossSpreadBps,
      netProfitVusd,
      netProfitAfterBufferVusd,
      contractFloorVusd,
      profitable: meetsContractFloor && netProfitAfterBufferVusd >= 0,
    };
  }

  /** Evaluate every configured probe size against `minProfitBps`. Best (highest buffered net) first. */
  async scan(minProfitBps: number): Promise<Opportunity[]> {
    const results = await Promise.all(
      this.config.probeSizesVusd.map((s) =>
        this.evaluate(s, minProfitBps).catch((e) => {
          console.warn(`  probe ${s}: quote failed: ${e instanceof Error ? e.message : e}`);
          return null;
        }),
      ),
    );
    return results
      .filter((o): o is Opportunity => o !== null)
      .sort((a, b) => b.netProfitAfterBufferVusd - a.netProfitAfterBufferVusd);
  }
}
