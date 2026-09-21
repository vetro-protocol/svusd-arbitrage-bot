import {type Account, formatEther, formatGwei, type Hash, type PublicClient} from "viem";
import type {Config} from "./config.js";
import {perGasWei} from "./gas.js";
import {errorSummary} from "./redact.js";

/**
 * The single choke point every state-changing call passes through. In order it:
 * honors PAUSED, enforces the per-tx VUSD spend ceiling, enforces the gas cap,
 * simulates (so a revert is never broadcast), and only then, in TX_MODE=live
 * with an account, broadcasts. Anything short of that logs and returns without
 * touching the chain.
 */
export interface TxPlan {
  label: string;
  simulate: () => Promise<unknown>;
  send: () => Promise<Hash>;
  /** VUSD this call spends (base units), checked against the ceiling. Omit for non-spending calls (settle). */
  spendVusd?: bigint;
}

export type ExecStatus =
  | "sent"
  | "simulated"
  | "skipped-paused"
  | "skipped-spend-cap"
  | "skipped-gas-cap"
  | "revert";

export interface ExecOutcome {
  status: ExecStatus;
  detail?: string;
  hash?: string;
}

export class Executor {
  constructor(
    private config: Config,
    private client: PublicClient,
    private account?: Account,
  ) {}

  private log(label: string, msg: string) {
    console.log(`  [exec ${label}] ${msg}`);
  }

  /** Per-gas price in gwei via the shared `perGasWei`, so the cap and the monitor's gate agree. */
  private async gasPriceGwei(): Promise<number> {
    return Number(formatGwei(await perGasWei(this.client)));
  }

  async run(plan: TxPlan): Promise<ExecOutcome> {
    if (this.config.paused) {
      this.log(plan.label, "PAUSED, not broadcasting");
      return {status: "skipped-paused"};
    }

    if (plan.spendVusd != null && plan.spendVusd > this.config.maxTxSpendVusd) {
      const detail = `spend ${formatEther(plan.spendVusd)} VUSD > ceiling ${formatEther(this.config.maxTxSpendVusd)} VUSD`;
      this.log(plan.label, `skip: ${detail}`);
      return {status: "skipped-spend-cap", detail};
    }

    const gwei = await this.gasPriceGwei();
    if (gwei > this.config.maxGasPriceGwei) {
      const detail = `gas ${gwei.toFixed(2)} gwei > cap ${this.config.maxGasPriceGwei} gwei`;
      this.log(plan.label, `skip: ${detail}`);
      return {status: "skipped-gas-cap", detail};
    }

    // Simulate first: never broadcast a call that would revert.
    try {
      await plan.simulate();
    } catch (e) {
      const detail = errorSummary(e);
      this.log(plan.label, `revert in simulation, not sending: ${detail}`);
      return {status: "revert", detail};
    }

    if (this.config.txMode !== "live" || !this.account) {
      this.log(plan.label, `simulation ok, would broadcast (TX_MODE=${this.config.txMode})`);
      return {status: "simulated"};
    }

    const hash = await plan.send();
    this.log(plan.label, `broadcast ${hash}, waiting…`);
    const receipt = await this.client.waitForTransactionReceipt({hash});
    this.log(plan.label, `mined in block ${receipt.blockNumber} (status ${receipt.status})`);
    // Simulation passing does not guarantee inclusion succeeds: state can move under the tx.
    if (receipt.status !== "success") {
      return {status: "revert", detail: `reverted on-chain in block ${receipt.blockNumber}`, hash};
    }
    return {status: "sent", hash};
  }
}
