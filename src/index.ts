import "dotenv/config";
import {ethers} from "ethers";
import {loadConfig} from "./config.js";
import {CurveQuoter} from "./curve.js";
import {Monitor} from "./monitor.js";
import {StakingVault} from "./stakingVault.js";
import type {Opportunity} from "./types.js";

const ts = () => new Date().toISOString().slice(11, 19);

function banner(mode: string, cfg: ReturnType<typeof loadConfig>) {
  console.log("──────────────────────────────────────────────────────────────");
  console.log("  sVUSD Arbitrage Bot (VUSD-native)");
  console.log(`  Mode:        ${mode}`);
  console.log(`  Min profit:  ${cfg.minProfitVusd} VUSD (floor ${cfg.minProfitBps} bps)`);
  console.log(`  Buffer:      ${cfg.bufferBps} bps`);
  console.log(`  Probe sizes: ${cfg.probeSizesVusd.join(", ")} VUSD`);
  console.log("──────────────────────────────────────────────────────────────");
}

function fmt(o: Opportunity): string {
  const flag = o.profitable ? "✅ PROFITABLE" : "  below-gate ";
  return (
    `${flag} size=${o.sizeVusd}VUSD ` +
    `buy=${o.dexBuyPrice.toFixed(4)} ` +
    `gross=${o.grossSpreadBps.toFixed(1)}bps ` +
    `locked=${o.grossProfitVusd.toFixed(2)}VUSD ` +
    `net=${o.netProfitVusd.toFixed(2)} ` +
    `netAfterBuf=${o.netProfitAfterBufferVusd.toFixed(2)}VUSD`
  );
}

async function main() {
  const cfg = loadConfig();
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);

  // Monitor-only: even with a key present we never submit here yet.
  banner(cfg.live ? "LIVE (execution not wired — monitor)" : "DRY-RUN", cfg);

  const monitor = new Monitor(cfg, new CurveQuoter(provider), new StakingVault(provider));

  const tick = async () => {
    try {
      const vault = await monitor.readVault();
      const atomic = vault.instantWithdrawAvailable
        ? " | ⚡ INSTANT redeem available (atomic!)"
        : "";
      console.log(
        `[${ts()}] fair=${vault.fairValueVusdPerShare.toFixed(4)} VUSD/sVUSD ` +
          `| cooldown=${(vault.cooldownSeconds / 86400).toFixed(1)}d` +
          `${atomic}`,
      );

      const opps = await monitor.scan();
      if (!opps.length) {
        console.log(`  no quotable opportunities this tick`);
        return;
      }
      for (const o of opps) console.log(`  ${fmt(o)}`);

      const best = opps[0];
      if (best.profitable) {
        console.log(
          `  → best actionable: size=${best.sizeVusd}VUSD ` +
            `net(after buffer)=${best.netProfitAfterBufferVusd.toFixed(2)}VUSD ` +
            `[monitor — would open position]`,
        );
      }
    } catch (e) {
      console.error(`[${ts()}] tick error:`, e instanceof Error ? e.message : e);
    }
  };

  await tick();
  setInterval(tick, cfg.pollIntervalMs);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
