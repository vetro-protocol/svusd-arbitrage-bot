# sVUSD Arbitrage Bot

A keeper bot that buys **sVUSD** below fair value on Curve, redeems it through the
sVUSD `StakingVault` 7-day cooldown, and captures the spread. The two legs are 7
days apart, so the trade is **non-atomic** and **capital-holding**: a custody
contract holds the VUSD reserves and its open positions on-chain, and the bot just
triggers the two actions. It is **VUSD-native** (VUSD in, VUSD out).

## How it works

sVUSD is an ERC4626 `StakingVault` over VUSD with a request/claim cooldown:

| Step | Call | Notes |
| --- | --- | --- |
| 1. Buy | Curve `VUSD → crvUSD → sVUSD` | sVUSD trades below its `previewRedeem` fair value. |
| 2. Request | `requestRedeem(shares, owner)` | Locks the VUSD payout at the current rate for the cooldown. |
| 3. Wait | (no call) | 7-day cooldown (admin-settable). |
| 4. Settle | `claimWithdraw(requestId, receiver)` | Pays out the locked VUSD; principal recycles as reserves, profit goes to the beneficiary. |

Because the redeem rate is snapshotted at request time, the profit is fixed the
moment you buy, and the contract enforces it at entry. The only sVUSD pool is thin
(~$43k), so price impact caps trade size to roughly 5k-10k VUSD per trade.

## Custody

The `SVusdArbitrage` contract holds the VUSD reserves and open positions. The
keeper key only triggers guarded actions and can never move funds out; withdrawals
are owner-only. Swaps are passed in as pre-built calldata, confined to an
owner-curated allowlist.

## Quick start (dry-run monitor)

```bash
npm install
cp .env.example .env
# set ETHEREUM_RPC_URL; leave PRIVATE_KEY empty for dry-run
npm run dev
```

The monitor quotes the real pools each tick and flags profitable opportunities; it
never submits a transaction. `npm run typecheck` and `npm run build` must pass, and
`forge test` runs the contract's fork suite against mainnet.

## Deploy (Render)

[`render.yaml`](render.yaml) is a one-service blueprint: a single `web` instance
that runs the poll loop and serves `GET /status` for the health check.

- **One instance, always.** The bot signs from a single EOA, so `numInstances` is
  pinned to `1` and must stay there; a second instance would double-broadcast on
  the same nonce.
- **Health check.** `/status` returns `200` with a JSON snapshot (mode, tick count,
  open positions, last error) while the loop is live, and `503` if a tick hangs, so
  Render restarts a stalled keeper. The body carries no key or RPC URL, so it is
  safe on the public URL.
- **Secrets** (`ETHEREUM_RPC_URL`, `PRIVATE_KEY`, `ARBITRAGE_ADDRESS`) are
  `sync:false`: set them in the Render dashboard, never in git.
- **Operational toggles** (`TX_MODE`, `PAUSED`) are also `sync:false`, so they are
  dashboard-owned and a deploy never reverts a hand-flip. Both default safe when
  unset (dry-run, unpaused); set `TX_MODE=live` once you have watched a dry-run tick.

