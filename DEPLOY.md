# Deploying SVusdArbitrage (mainnet)

Runbook for deploying the custody contract and bringing the keeper live. The contract is
VUSD-native and holds the reserves; the bot only triggers guarded actions. Read
[README.md](README.md) for the mechanism and custody model.

## 0. Decide the three addresses

| Role | Who | Key needed at deploy? | Powers |
| --- | --- | --- | --- |
| `OWNER` | a cold EOA or a Safe (governance) | no (only to accept if handed off) | `sweep`, `cancelPosition`, `addKeeper`/`removeKeeper`, `setBeneficiary`, `setMinProfitBps` |
| `BENEFICIARY` | a cold EOA or a Safe | no | receives realized profit auto-pushed at settle |
| `KEEPER` | the bot's hot EOA | no (the bot signs later) | `openPosition` / `settlePosition` only, cannot move funds out |
| deployer | a funded EOA (gas only) | yes (`DEPLOYER_KEY`) | becomes owner if `OWNER == deployer` |

Notes:
- Ideal: have the `KEEPER` address ready before deploy. Generate the bot's hot EOA with
  `cast wallet new`, pass its address as `KEEPER`, and keep the private key as a bot secret (never
  committed). The constructor rejects a zero `KEEPER`. If the key is not ready, pass any controlled
  address as a placeholder and rotate later (`addKeeper(bot)` then `removeKeeper(placeholder)`).
- Deploying from an EOA with `OWNER` set to that same EOA keeps ownership immediately (no
  `acceptOwnership` step); the script skips the self-transfer in that case.
- If `OWNER` is a separate EOA or a Safe, it must send one `acceptOwnership()` tx to finish the
  Ownable2Step handoff (from the Safe UI when it is a Safe).
- Never make the keeper the owner. The hot key is assumed compromisable; owner powers on it throw
  away the fund-safety model.

## 1. Pre-deploy checklist

- [ ] `forge test` green (deterministic suite) and `npm run typecheck` clean.
- [ ] `KEEPER` EOA created; address in hand, private key stored as a secret (not committed).
- [ ] `MIN_PROFIT_BPS > 0` (default 30 = 0.30%). At 0 the profit guarantee rests entirely on the
      keeper's per-call floor.
- [ ] Deployer EOA funded with ETH for gas.
- [ ] `ETHEREUM_RPC_URL` and `ETHERSCAN_API_KEY` set.

## 2. Fork rehearsal (no broadcast)

Dry-run the exact script against a mainnet fork first:

```sh
export BENEFICIARY=0x...   # cold EOA or Safe
export KEEPER=0x...        # bot EOA, or a placeholder to rotate later
export OWNER=0x...         # cold EOA or Safe
export MIN_PROFIT_BPS=30
forge script script/Deploy.s.sol:Deploy --rpc-url "$ETHEREUM_RPC_URL"
```

Confirm the console prints the expected owner/keeper/beneficiary and `minProfitBps`.

## 3. Deploy + verify (broadcast)

```sh
forge script script/Deploy.s.sol:Deploy --rpc-url "$ETHEREUM_RPC_URL" \
  --private-key "$DEPLOYER_KEY" --broadcast --verify --etherscan-api-key "$ETHERSCAN_API_KEY"
```

The deployed address, tx hash, block, and constructor args land in
`broadcast/Deploy.s.sol/1/run-latest.json` (local only; `broadcast/` is gitignored). If
`OWNER != deployer`, `OWNER` must send `acceptOwnership()` to finish the handoff.

## 4. Post-deploy wiring

1. **Record the address.** Set `ARBITRAGE_ADDRESS` in `src/constants.ts` to the deployed address and
   commit it. That committed constant is the default the bot reads; env only overrides it.
2. **Fund reserves.** Transfer VUSD directly to the deployed address. The contract custodies
   reserves; there is no deposit function. With no VUSD it cannot open a position.
3. **Gas the keeper.** Send a little ETH to the `KEEPER` EOA (it signs txs; it never holds VUSD).
4. **Point the bot at it.** The address is baked into `src/constants.ts`, so the bot already knows
   it; just set `PRIVATE_KEY` (keeper key) in the bot env / Render secrets. Set `ARBITRAGE_ADDRESS`
   env only to override the constant (e.g. a redeploy before constants is updated).
5. **Rotate the keeper if a placeholder was used.** `addKeeper(botEOA)` then
   `removeKeeper(placeholder)`.

## 5. Go live safely

1. Start the bot in `TX_MODE=dry-run` (leave `PRIVATE_KEY` set, `TX_MODE=dry-run`). Watch it quote
   and simulate at least one full tick with no revert.
2. Flip `TX_MODE=live` only after a clean dry-run tick.
3. `PAUSED=true` is the kill switch: the executor simulates but refuses to broadcast.
4. Expect a quiet keeper when the spread is under `minProfitBps`; that is correct, not stuck.
