#!/usr/bin/env bash
# Boot an anvil mainnet fork, run the end-to-end bot rehearsal against it, tear anvil down.
# Needs ETHEREUM_RPC_URL (mainnet archive/full node) in the environment.
set -euo pipefail

PORT=8546
RPC="http://127.0.0.1:${PORT}"

: "${ETHEREUM_RPC_URL:?set ETHEREUM_RPC_URL to a mainnet RPC}"

command -v anvil >/dev/null || { echo "anvil not found (install Foundry)"; exit 1; }

echo "building contracts…"
forge build >/dev/null

echo "starting anvil fork on :${PORT}…"
anvil --fork-url "$ETHEREUM_RPC_URL" --chain-id 1 --port "$PORT" --silent &
ANVIL_PID=$!
trap 'kill "$ANVIL_PID" 2>/dev/null || true' EXIT

# Wait for the fork to answer before driving it.
for _ in $(seq 1 30); do
  if cast block-number --rpc-url "$RPC" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
cast block-number --rpc-url "$RPC" >/dev/null 2>&1 || { echo "anvil did not come up"; exit 1; }

ANVIL_RPC="$RPC" npx tsx scripts/rehearse.mts
