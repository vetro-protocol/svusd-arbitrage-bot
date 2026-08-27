import {ethers} from "ethers";
import type {Config} from "./config.js";
import {VUSD_DECIMALS} from "./constants.js";
import type {CurveQuoter} from "./curve.js";
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
    this.toVusd = (raw) => Number(ethers.formatUnits(raw, VUSD_DECIMALS));
    this.toVusdUnits = (human) => ethers.parseUnits(human.toFixed(VUSD_DECIMALS), VUSD_DECIMALS);
  }

  async readVault(): Promise<VaultState> {
    return this.vault.readState(this.config.arbitrageAddress);
  }

  /** Simulate one probe size. Returns null if any leg fails to quote. */
  async evaluate(sizeVusd: number): Promise<Opportunity | null> {
    const sizeUnits = this.toVusdUnits(sizeVusd);

    // Entry: VUSD → sVUSD (Curve, impact included).
    const sharesOut = await this.curve.vusdToSvusd(sizeUnits);
    if (sharesOut <= 0n) return null;

    // requestRedeem locks this VUSD amount for the shares (rate fixed at request).
    const vusdLocked = await this.vault.previewRedeem(sharesOut);
    if (vusdLocked <= 0n) return null;

    const vusdLockedHuman = this.toVusd(vusdLocked);
    const dexBuyPrice = sizeVusd / (Number(sharesOut) / 1e18);

    const grossProfitVusd = vusdLockedHuman - sizeVusd;
    const grossSpreadBps = (grossProfitVusd / sizeVusd) * 10000;

    const netProfitVusd = grossProfitVusd - this.config.estimatedGasCostVusd;
    const buffer = (this.config.bufferBps / 10000) * sizeVusd;
    const netProfitAfterBufferVusd = netProfitVusd - buffer;

    // Mirror the contract's open floor: spent + max(minProfit, ceil(spent*bps/1e4)).
    const bpsFloor = Math.ceil((sizeVusd * this.config.minProfitBps) / 10000);
    const contractFloorVusd = sizeVusd + Math.max(this.config.minProfitVusd, bpsFloor);

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

  /** Evaluate every configured probe size. Best (highest buffered net) first. */
  async scan(): Promise<Opportunity[]> {
    const results = await Promise.all(
      this.config.probeSizesVusd.map((s) =>
        this.evaluate(s).catch((e) => {
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
