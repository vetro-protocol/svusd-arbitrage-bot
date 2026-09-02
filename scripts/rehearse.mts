// End-to-end rehearsal of the live bot against an anvil mainnet fork.
//
// Exercises the real src/ modules (Monitor, CurveQuoter, StakingVault, Arbitrage, Executor, Jobs,
// buildEntrySwap) the way production runs them: deploy the contract, allowlist the Curve router,
// fund it with VUSD, then drive one full open -> 7-day cooldown -> settle round trip and assert the
// executor's PAUSED / spend-cap / gas-cap gates. This is the one path the Foundry suite cannot cover,
// since those gates and the calldata builder live in TypeScript.
//
// Run via scripts/rehearse.sh, which boots anvil and sets ANVIL_RPC.

import {readFileSync} from "node:fs";
import {
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  type Hash,
  http,
  keccak256,
  parseAbi,
  parseEther,
  toHex,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {mainnet} from "viem/chains";
import {Arbitrage} from "../src/arbitrage.js";
import type {Config} from "../src/config.js";
import {SVUSD_ADDRESS, VUSD_ADDRESS} from "../src/constants.js";
import {CurveQuoter} from "../src/curve.js";
import {Executor, type TxPlan} from "../src/executor.js";
import {Jobs} from "../src/jobs.js";
import {Monitor} from "../src/monitor.js";
import {StakingVault} from "../src/stakingVault.js";

const RPC = process.env.ANVIL_RPC ?? "http://127.0.0.1:8546";
const CURVE_ROUTER: Address = "0x16C6521Dff6baB339122a0FE25a9116693265353";

// Deterministic anvil dev accounts. [0] deploys and owns, [1] is the keeper, [2] is the beneficiary.
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const KEEPER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const BENEFICIARY: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

const FUND = parseEther("2000"); // a size with a live spread at head; the open phase needs a real edge

const owner = privateKeyToAccount(OWNER_KEY);
const keeper = privateKeyToAccount(KEEPER_KEY);

const publicClient = createPublicClient({chain: mainnet, transport: http(RPC), batch: {multicall: true}});
const testClient = createTestClient({chain: mainnet, mode: "anvil", transport: http(RPC)});
const ownerWallet = createWalletClient({account: owner, chain: mainnet, transport: http(RPC)});
const keeperWallet = createWalletClient({account: keeper, chain: mainnet, transport: http(RPC)});

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
}
function section(title: string) {
  console.log(`\n── ${title} ──`);
}

function balanceOf(holder: Address): Promise<bigint> {
  return publicClient.readContract({address: VUSD_ADDRESS, abi: ERC20, functionName: "balanceOf", args: [holder]});
}

/** Mint VUSD into `holder` by overwriting its balances slot, so no pool or the vault is perturbed. */
async function dealVusd(holder: Address, amount: bigint): Promise<void> {
  const value = toHex(amount, {size: 32});
  for (let i = 0n; i < 30n; i++) {
    const slot = keccak256(
      encodeAbiParameters([{type: "address"}, {type: "uint256"}], [holder, i]),
    );
    const prev = (await publicClient.getStorageAt({address: VUSD_ADDRESS, slot})) ?? toHex(0n, {size: 32});
    await testClient.setStorageAt({address: VUSD_ADDRESS, index: slot, value});
    if ((await balanceOf(holder)) === amount) return;
    await testClient.setStorageAt({address: VUSD_ADDRESS, index: slot, value: prev});
  }
  throw new Error("dealVusd: could not locate VUSD balance slot");
}

/** Base config; each phase overrides only the field whose gate it exercises. */
function makeConfig(over: Partial<Config>): Config {
  return {
    rpcUrl: RPC,
    txMode: "live",
    paused: false,
    privateKey: KEEPER_KEY,
    arbitrageAddress: undefined,
    maxTxSpendVusd: parseEther("1000000"),
    entrySlippageBps: 50,
    minProfitBps: 0,
    estimatedGasCostVusd: 0n,
    bufferBps: 0,
    maxGasPriceGwei: 1_000_000,
    probeAmounts: [FUND],
    pollIntervalMs: 0,
    settleBatchCap: 20,
    port: 0,
    healthStaleMs: 0,
    ...over,
  };
}

async function deploy(): Promise<Address> {
  const artifact = JSON.parse(
    readFileSync(new URL("../out/SVusdArbitrage.sol/SVusdArbitrage.json", import.meta.url), "utf8"),
  );
  const hash = await ownerWallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object as `0x${string}`,
    args: [SVUSD_ADDRESS, BENEFICIARY, keeper.address, owner.address],
  });
  const receipt = await publicClient.waitForTransactionReceipt({hash});
  if (!receipt.contractAddress) throw new Error("deploy: no contract address in receipt");
  return receipt.contractAddress;
}

async function ownerCall(address: Address, abi: readonly string[], fn: string, args: unknown[]): Promise<void> {
  const hash = await ownerWallet.writeContract({
    address,
    // biome-ignore lint/suspicious/noExplicitAny: parseAbi over a narrow admin signature
    abi: parseAbi(abi) as any,
    // biome-ignore lint/suspicious/noExplicitAny: admin fn name is dynamic here
    functionName: fn as any,
    args,
    account: owner,
    chain: mainnet,
  });
  await publicClient.waitForTransactionReceipt({hash});
}

async function main() {
  console.log(`sVUSD arb rehearsal on anvil fork (${RPC})`);

  section("deploy + configure");
  const arbAddress = await deploy();
  await ownerCall(arbAddress, ["function setAllowedSwapAddress(address,bool)"], "setAllowedSwapAddress", [
    CURVE_ROUTER,
    true,
  ]);
  console.log(`  contract ${arbAddress}, keeper ${keeper.address}`);

  const vault = new StakingVault(publicClient);
  const arb = new Arbitrage(arbAddress, publicClient, keeperWallet, keeper);
  check("keeper enrolled", await arb.isKeeper(keeper.address));
  check("router allowlisted", await arb.allowedSwapAddress(CURVE_ROUTER));

  // A send that throws proves the gate short-circuited before broadcast.
  section("executor safety gates");
  const boom = async (): Promise<Hash> => {
    throw new Error("gate should have blocked broadcast");
  };
  const gatePlan = (over: Partial<TxPlan>): TxPlan => ({
    label: "gate",
    simulate: async () => {},
    send: boom,
    ...over,
  });

  const paused = new Executor(makeConfig({paused: true}), publicClient, keeper);
  check("PAUSED blocks broadcast", (await paused.run(gatePlan({spendVusd: FUND}))).status === "skipped-paused");

  const capped = new Executor(makeConfig({maxTxSpendVusd: parseEther("100")}), publicClient, keeper);
  const capOut = await capped.run(gatePlan({spendVusd: FUND}));
  check("spend-cap blocks oversized open", capOut.status === "skipped-spend-cap", capOut.detail);

  const gasCapped = new Executor(makeConfig({maxGasPriceGwei: 0}), publicClient, keeper);
  const gasOut = await gasCapped.run(gatePlan({spendVusd: FUND}));
  check("gas-cap blocks when fee over ceiling", gasOut.status === "skipped-gas-cap", gasOut.detail);

  // The per-open minProfit floor comes from a fresh sim, so any positive spread opens.
  section("open -> cooldown -> settle round trip");
  await dealVusd(arbAddress, FUND);
  check("funded with VUSD", (await balanceOf(arbAddress)) === FUND);

  const cfg = makeConfig({arbitrageAddress: arbAddress});
  const monitor = new Monitor(cfg, new CurveQuoter(publicClient), vault);
  const executor = new Executor(cfg, publicClient, keeper);
  const jobs = new Jobs(cfg, publicClient, vault, arb, executor, monitor);

  const minProfitBps = Number(await arb.minProfitBps());
  const opps = await monitor.scan(minProfitBps);
  await jobs.open(opps, minProfitBps);

  const ids = await arb.openRequestIds();
  check("one position opened", ids.length === 1, `ids=[${ids.join(",")}]`);
  check("reserves fully spent on entry", (await balanceOf(arbAddress)) === 0n);
  if (ids.length !== 1) throw new Error("open did not create a position; cannot rehearse settle");

  const locked = await arb.lockedVusdOf(ids[0]);
  const claimableAt = await vault.claimableAt(ids[0]);

  await testClient.increaseTime({seconds: 7 * 86_400 + 60});
  await testClient.mine({blocks: 1});
  const now = Number((await publicClient.getBlock()).timestamp);
  check("cooldown elapsed", now > claimableAt, `now=${now} claimableAt=${claimableAt}`);

  await jobs.settle();

  const reserves = await balanceOf(arbAddress);
  const profit = await balanceOf(BENEFICIARY);
  check("position closed", (await arb.openRequestIds()).length === 0);
  check("principal recycled to reserves", reserves === FUND, `${reserves}`);
  check("profit pushed to beneficiary", profit > 0n, `${profit}`);
  check("locked == principal + profit", locked === reserves + profit);

  section(failures === 0 ? "REHEARSAL PASSED" : `REHEARSAL FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("rehearsal error:", e);
  process.exit(1);
});
