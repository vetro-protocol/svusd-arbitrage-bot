import {formatEther, maxUint256, type PublicClient, parseAbi} from "viem";
import type {Arbitrage} from "./arbitrage.js";
import type {Config} from "./config.js";
import {VUSD_ADDRESS} from "./constants.js";
import type {Executor} from "./executor.js";
import type {Monitor} from "./monitor.js";
import type {StakingVault} from "./stakingVault.js";
import {buildEntrySwap} from "./swapBuilder.js";
import type {Opportunity} from "./types.js";

/**
 * The two keeper jobs, both stateless: every tick they re-derive what to do from
 * chain state (contract reserves + open requests + vault maturity), build a plan,
 * and hand it to the executor, which owns all the safety gates. No local store.
 */
const ERC20_ABI = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

export class Jobs {
  constructor(
    private config: Config,
    private client: PublicClient,
    private vault: StakingVault,
    private arb: Arbitrage,
    private executor: Executor,
    private monitor: Monitor,
  ) {}

  /** Open the best profitable opportunity the contract can afford, at most one per tick. */
  async open(opps: Opportunity[], minProfitBps: number): Promise<void> {
    const reserves = await this.client.readContract({
      address: VUSD_ADDRESS,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [this.arb.address],
    });
    const cap = reserves < this.config.maxTxSpendVusd ? reserves : this.config.maxTxSpendVusd;

    const candidate = opps.find((o) => o.profitable && o.vusdAmount <= cap);
    if (!candidate) return;

    // Re-evaluate the chosen size on-chain right now: the tick's quote may be stale, and we must
    // not open on an edge that has since vanished. Bail unless it STILL clears the full gate.
    const fresh = await this.monitor.evaluate(candidate.vusdAmount, minProfitBps);
    if (!fresh?.profitable) return;

    // Both floors are a tight discount of this fresh, still-profitable simulation, so a sandwich can
    // only push the fill down to our tolerance. The contract enforces max(minProfit, minProfitBps).
    const tolerance = BigInt(10_000 - this.config.entrySlippageBps);
    const minShares = (fresh.sharesOut * tolerance) / 10_000n;
    const minProfit = ((fresh.vusdLocked - fresh.vusdAmount) * tolerance) / 10_000n;

    // A break-even quote (no edge after the discount) is not worth a tx: bail rather than open at 0.
    if (minProfit <= 0n) return;

    const buy = buildEntrySwap({
      amountVusd: fresh.vusdAmount,
      minSvusdOut: minShares,
      receiver: this.arb.address,
    });
    const plan = this.arb.openPosition(fresh.vusdAmount, buy, minProfit);
    await this.executor.run({
      label: `open ${formatEther(fresh.vusdAmount)}VUSD`,
      spendVusd: fresh.vusdAmount,
      simulate: plan.simulate,
      send: plan.send,
    });
  }

  /** Settle every matured request in one tx; returns the total open-position count (for /status). */
  async settle(): Promise<number> {
    // The vault filters to matured ids for us; openRequestIds is only for the count. Both batch into one
    // multicall round trip. We gate on the off-chain claimable read so an empty tick sends no tx.
    const [openIds, claimableIds] = await Promise.all([
      this.arb.openRequestIds(),
      this.vault.getClaimableRequests(this.arb.address),
    ]);
    if (claimableIds.length > 0) {
      // Settle the whole matured set in one tx. The contract re-reads it and floors each payout to the
      // amount locked at open, so there is no keeper-side floor to pass.
      const batch = this.arb.settleClaimablePositions(maxUint256);
      const label = `settle ${claimableIds.length} matured`;
      const outcome = await this.executor.run({label, simulate: batch.simulate, send: batch.send});

      // The batch is all-or-nothing: if one matured id can't settle it reverts the lot. Fall back to
      // per-id so one bad position can't wedge the healthy ones (the executor skips the reverting id).
      if (outcome.status === "revert") {
        console.warn(`  batch settle reverted (${outcome.detail ?? ""}); retrying per-id`);
        for (const id of claimableIds) {
          const one = this.arb.settlePosition(id);
          await this.executor.run({label: `settle #${id}`, simulate: one.simulate, send: one.send});
        }
      }
    }
    return openIds.length;
  }
}
