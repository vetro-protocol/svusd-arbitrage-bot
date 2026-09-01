import "dotenv/config";
import {type Address, createPublicClient, createWalletClient, formatEther, http} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {mainnet} from "viem/chains";
import {Arbitrage} from "./arbitrage.js";
import {loadConfig} from "./config.js";
import {CurveQuoter} from "./curve.js";
import {Executor} from "./executor.js";
import {Jobs} from "./jobs.js";
import {Monitor} from "./monitor.js";
import {StakingVault} from "./stakingVault.js";
import type {Opportunity} from "./types.js";

const ts = () => new Date().toISOString().slice(11, 19);

function banner(mode: string, cfg: ReturnType<typeof loadConfig>) {
  console.log("──────────────────────────────────────────────────────────────");
  console.log("  sVUSD Arbitrage Bot (VUSD-native)");
  console.log(`  Mode:        ${mode}`);
  console.log(`  Floor:       ${cfg.minProfitBps} bps`);
  console.log(`  Buffer:      ${cfg.bufferBps} bps | slippage ${cfg.entrySlippageBps} bps`);
  console.log(`  Probe sizes: ${cfg.probeAmounts.map((a) => formatEther(a)).join(", ")} VUSD`);
  console.log("──────────────────────────────────────────────────────────────");
}

function fmt(o: Opportunity): string {
  const flag = o.profitable ? "✅ PROFITABLE" : "  below-gate ";
  const vusd = (raw: bigint) => Number(formatEther(raw)).toFixed(2);
  return (
    `${flag} ${formatEther(o.vusdAmount)}→${vusd(o.vusdLocked)} VUSD ` +
    `buyPrice ${o.dexBuyPrice.toFixed(4)} | ` +
    `profit ${vusd(o.grossProfitVusd)} gross (${o.grossSpreadBps.toFixed(1)} profit bps) ` +
    `→ ${vusd(o.netProfitVusd)} after gas ` +
    `→ ${vusd(o.netProfitAfterBufferVusd)} after buffer`
  );
}

/** The keeper key is stored without a 0x prefix (see .env.example); viem needs it. */
function normalizeKey(key: string): `0x${string}` {
  return (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
}

async function main() {
  const cfg = loadConfig();
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(cfg.rpcUrl),
    batch: {multicall: true},
  });
  const vault = new StakingVault(publicClient);
  const monitor = new Monitor(cfg, new CurveQuoter(publicClient), vault);

  // A contract (read-only) whenever one is configured, so the bot reads the live on-chain
  // floor as the source of truth even in dry-run. Jobs need a signer on top of that.
  let arb: Arbitrage | undefined;
  let jobs: Jobs | undefined;
  if (cfg.arbitrageAddress) {
    const account = cfg.privateKey ? privateKeyToAccount(normalizeKey(cfg.privateKey)) : undefined;
    const walletClient = account
      ? createWalletClient({account, chain: mainnet, transport: http(cfg.rpcUrl)})
      : undefined;
    arb = new Arbitrage(cfg.arbitrageAddress as Address, publicClient, walletClient, account);
    if (account) {
      const executor = new Executor(cfg, publicClient, account);
      jobs = new Jobs(cfg, publicClient, vault, arb, executor, monitor);
      const isKeeper = await arb.isKeeper(account.address);
      console.log(`  executor: ${account.address} keeper=${isKeeper} arb=${cfg.arbitrageAddress}`);
      if (!isKeeper)
        console.warn(
          "  ⚠ signer is NOT an enrolled keeper; opens/settles will revert in simulation",
        );
    }
  }

  const mode = jobs
    ? `${cfg.txMode.toUpperCase()}${cfg.paused ? " (PAUSED)" : ""}`
    : "DRY-RUN (monitor-only)";
  banner(mode, cfg);

  const tick = async () => {
    try {
      const state = await monitor.readVault();
      const atomic = state.instantWithdrawAvailable
        ? " | ⚡ INSTANT redeem available (atomic!)"
        : "";
      console.log(
        `[${ts()}] fair=${state.fairValueVusdPerShare.toFixed(4)} VUSD/sVUSD ` +
          `| cooldown=${(state.cooldownSeconds / 86400).toFixed(1)}d${atomic}`,
      );

      const minProfitBps = arb ? Number(await arb.minProfitBps()) : cfg.minProfitBps;
      const opps = await monitor.scan(minProfitBps);
      if (!opps.length) console.log(`  no quotable opportunities this tick`);
      for (const o of opps) console.log(`  ${fmt(o)}`);

      const best = opps[0];
      if (best?.profitable) {
        console.log(
          `  → best actionable: size=${formatEther(best.vusdAmount)}VUSD ` +
            `net(after buffer)=${Number(formatEther(best.netProfitAfterBufferVusd)).toFixed(2)}VUSD`,
        );
      }

      // Jobs run every tick: open acts only on an affordable profitable opp; settle
      // sweeps matured requests regardless of whether any opportunity quoted.
      if (jobs) {
        const block = await publicClient.getBlock();
        const nowSec = Number(block.timestamp);
        // The contract can only open through the cooldown path; if the vault ever disables it,
        // opens would revert, so skip them and let settle keep clearing matured requests.
        if (state.cooldownEnabled) await jobs.open(opps, minProfitBps);
        else console.log(`  vault cooldown disabled; skipping opens`);
        await jobs.settle(nowSec);
      }
    } catch (e) {
      console.error(`[${ts()}] tick error:`, e instanceof Error ? e.message : e);
    }
  };

  // Serialize ticks: schedule the next only after the current resolves, so a slow tick (a live tx
  // blocks until mined) can never overlap and broadcast a duplicate open/settle.
  const loop = async () => {
    await tick();
    setTimeout(loop, cfg.pollIntervalMs);
  };
  await loop();
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
