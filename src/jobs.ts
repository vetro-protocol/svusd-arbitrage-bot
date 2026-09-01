import {formatEther, type PublicClient, parseAbi} from "viem";
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

  /** Settle every open request whose cooldown has matured; returns the open-position count. */
  async settle(nowSec: number): Promise<number> {
    const ids = await this.arb.openRequestIds();
    for (const id of ids) {
      const claimableAt = await this.vault.claimableAt(id);
      if (claimableAt === 0) {
        // A tracked-open id the vault reports as unknown: never happens for a normal open; surface it.
        console.warn(`  settle: request #${id} has no claimableAt; skipping`);
        continue;
      }
      if (nowSec < claimableAt) continue;

      // minVusdOut left at 0: the contract holds the settle to at least the locked payout.
      const plan = this.arb.settlePosition(id, 0n);
      await this.executor.run({label: `settle #${id}`, simulate: plan.simulate, send: plan.send});
    }
    return ids.length;
  }
}
