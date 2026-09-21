import "dotenv/config";
import {type Address, createPublicClient, createWalletClient, formatEther, http} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {mainnet} from "viem/chains";
import {type AggregatorAdapter, LiFiAdapter, OneInchAdapter} from "./aggregators.js";
import {Arbitrage} from "./arbitrage.js";
import {loadConfig} from "./config.js";
import {CurveQuoter} from "./curve.js";
import {Executor} from "./executor.js";
import {Jobs} from "./jobs.js";
import {Monitor} from "./monitor.js";
import {errorText} from "./redact.js";
import {EntryRouter} from "./router.js";
import {Health, startHealthServer} from "./server.js";
import {StakingVault} from "./stakingVault.js";
import type {Opportunity} from "./types.js";

const ts = () => new Date().toISOString().slice(11, 19);

function banner(mode: string, cfg: ReturnType<typeof loadConfig>, floor: string) {
  console.log("──────────────────────────────────────────────────────────────");
  console.log("  sVUSD Arbitrage Bot (VUSD-native)");
  console.log(`  Mode:        ${mode}`);
  console.log(`  Floor:       ${floor}`);
  console.log(`  Buffer:      ${cfg.bufferBps} bps | slippage ${cfg.entrySlippageBps} bps`);
  const venues = ["curve", ...buildAggregators(cfg).map((a) => a.name)];
  console.log(`  Venues:      ${venues.join(", ")}`);
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

/** Aggregator adapters to quote alongside native Curve; empty unless ENABLE_AGGREGATORS. */
function buildAggregators(cfg: ReturnType<typeof loadConfig>): AggregatorAdapter[] {
  if (!cfg.enableAggregators) return [];
  const adapters: AggregatorAdapter[] = [new LiFiAdapter(cfg.lifiApiKey)];
  if (cfg.oneinchApiKey) adapters.push(new OneInchAdapter(cfg.oneinchApiKey));
  return adapters;
}

async function main() {
  const cfg = loadConfig();
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(cfg.rpcUrl),
    batch: {multicall: true},
  });
  const vault = new StakingVault(publicClient);
  const aggregators = buildAggregators(cfg);
  const router = new EntryRouter(new CurveQuoter(publicClient), aggregators, cfg.entrySlippageBps);
  const monitor = new Monitor(cfg, router, vault, publicClient);

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
  // The gate reads the live on-chain floor each tick, so show that rather than the env
  // fallback it ignores whenever a contract is wired.
  let floor = `${cfg.minProfitBps} bps (env fallback)`;
  if (arb) {
    try {
      floor = `${Number(await arb.minProfitBps())} bps (on-chain)`;
    } catch {
      floor = `${cfg.minProfitBps} bps (env fallback; on-chain read failed)`;
    }
  }
  banner(mode, cfg, floor);

  const health = new Health(mode, cfg.txMode, cfg.paused, cfg.healthStaleMs);
  startHealthServer(health, cfg.port);

  // Returns the current open-position count (or null when running monitor-only).
  const tick = async (): Promise<number | null> => {
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
      const gasCostVusd = await monitor.currentGasCostVusd();
      console.log(
        gasCostVusd === null
          ? `  gas: unpriceable this tick, opens paused (settles still run)`
          : `  gas: ~${Number(formatEther(gasCostVusd)).toFixed(2)} VUSD/round-trip (live)`,
      );
      const opps = await monitor.scan(minProfitBps, gasCostVusd);
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
        // The contract can only open through the cooldown path; if the vault ever disables it,
        // opens would revert, so skip them and let settle keep clearing matured requests.
        // Settle realizes funds, so an open-side throw (e.g. an aggregator build erroring) must
        // never skip it: contain the open here so settle always runs.
        if (state.cooldownEnabled) {
          try {
            await jobs.open(opps, minProfitBps, gasCostVusd);
          } catch (e) {
            console.warn(`  open failed: ${errorText(e)}`);
          }
        } else {
          console.log(`  vault cooldown disabled; skipping opens`);
        }
        return await jobs.settle();
      }
      return null;
    } catch (e) {
      const msg = errorText(e);
      console.error(`[${ts()}] tick error:`, msg);
      health.recordError(msg);
      return null;
    }
  };

  // Serialize ticks: schedule the next only after the current resolves, so a slow tick (a live tx
  // blocks until mined) can never overlap and broadcast a duplicate open/settle. tickStart/tickEnd
  // stamp liveness for /status.
  const loop = async () => {
    health.tickStart();
    const openPositions = await tick();
    health.tickEnd(openPositions);
    setTimeout(loop, cfg.pollIntervalMs);
  };
  await loop();
}

main().catch((e) => {
  console.error("fatal:", errorText(e));
  process.exit(1);
});
