import type {PublicClient} from "viem";

/**
 * Per-gas price (wei): EIP-1559 `maxFeePerGas`, falling back to legacy `gasPrice` so the estimate
 * never disengages on an RPC that omits 1559 fees. Shared by the monitor's gate and the executor's cap.
 */
export async function perGasWei(client: PublicClient): Promise<bigint> {
  const fees = await client.estimateFeesPerGas();
  return fees.maxFeePerGas ?? (await client.getGasPrice());
}
