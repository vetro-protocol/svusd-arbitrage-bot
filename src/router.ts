import type {Address} from "viem";
import type {AggregatorAdapter} from "./aggregators.js";
import {CHAIN_ID, SVUSD_ADDRESS, VUSD_ADDRESS} from "./constants.js";
import type {CurveQuoter} from "./curve.js";
import {buildEntrySwap, type EntrySwap} from "./swapBuilder.js";

/**
 * Best-venue entry router. Quotes VUSD -> sVUSD across native Curve (trusted, on-chain
 * exact) and every enabled aggregator in parallel, and returns the plan with the most
 * sVUSD out. Native Curve is always present, so an aggregator being down or unrouted
 * (common for VUSD today) just drops that source; there is no single point of failure.
 */
export interface EntryPlan {
  venue: string;
  sharesOut: bigint;
  /** Build the on-chain swap for this venue; `minSharesOut` is the contract-enforced floor. */
  build(minSharesOut: bigint, receiver: Address): Promise<EntrySwap>;
}

export class EntryRouter {
  constructor(
    private curve: CurveQuoter,
    private aggregators: AggregatorAdapter[],
    private entrySlippageBps: number,
  ) {}

  async bestEntry(vusdIn: bigint): Promise<EntryPlan | null> {
    const plans = await Promise.all([
      this.curvePlan(vusdIn),
      ...this.aggregators.map((a) => this.aggregatorPlan(a, vusdIn)),
    ]);
    const valid = plans.filter((p): p is EntryPlan => p !== null && p.sharesOut > 0n);
    if (valid.length === 0) return null;
    return valid.reduce((a, b) => (b.sharesOut > a.sharesOut ? b : a));
  }

  private async curvePlan(vusdIn: bigint): Promise<EntryPlan | null> {
    try {
      const sharesOut = await this.curve.vusdToSvusd(vusdIn);
      if (sharesOut <= 0n) return null;
      return {
        venue: "curve",
        sharesOut,
        build: (minSharesOut, receiver) =>
          Promise.resolve(
            buildEntrySwap({amountVusd: vusdIn, minSvusdOut: minSharesOut, receiver}),
          ),
      };
    } catch {
      return null;
    }
  }

  private async aggregatorPlan(
    adapter: AggregatorAdapter,
    vusdIn: bigint,
  ): Promise<EntryPlan | null> {
    try {
      const sharesOut = await adapter.getQuote({
        srcToken: VUSD_ADDRESS,
        destToken: SVUSD_ADDRESS,
        amount: vusdIn,
        chainId: CHAIN_ID,
      });
      if (sharesOut === null || sharesOut <= 0n) return null;
      return {
        venue: adapter.name,
        sharesOut,
        build: async (minSharesOut, receiver) => {
          const swap = await adapter.buildSwap({
            srcToken: VUSD_ADDRESS,
            destToken: SVUSD_ADDRESS,
            amount: vusdIn,
            chainId: CHAIN_ID,
            receiver,
            slippageBps: this.entrySlippageBps,
          });
          // The bot's fresh-quote floor is authoritative; the contract enforces this minAmountOut.
          return {...swap, minAmountOut: minSharesOut};
        },
      };
    } catch {
      return null;
    }
  }
}
