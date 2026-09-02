import type {Address, Hex} from "viem";

/**
 * DEX aggregator adapters for the entry leg (VUSD -> sVUSD). Each adapter quotes a
 * price and builds swap calldata for an allowlisted aggregator router, so the bot can
 * source sVUSD from any venue the aggregator indexes, not just the native Curve pool.
 *
 * The output shape (target, approveTarget, calldata) matches the contract's SwapParams;
 * the router sets the final minAmountOut from the bot's own fresh-quote floor.
 */
const FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {...init, signal: controller.signal});
  } finally {
    clearTimeout(timer);
  }
}

export interface QuoteParams {
  srcToken: Address;
  destToken: Address;
  amount: bigint;
  chainId: number;
}

export interface SwapBuildParams extends QuoteParams {
  receiver: Address;
  slippageBps: number;
}

/** Raw swap the aggregator returns; the caller supplies the authoritative minAmountOut. */
export interface AggregatorSwap {
  target: Address;
  approveTarget: Address;
  swapCalldata: Hex;
}

export interface AggregatorAdapter {
  readonly name: string;
  /** Destination amount for `amount` of srcToken, or null if the pair is unroutable. */
  getQuote(p: QuoteParams): Promise<bigint | null>;
  buildSwap(p: SwapBuildParams): Promise<AggregatorSwap>;
}

// Minimal shapes of the aggregator responses this bot reads (their payloads carry much more).
interface OneInchQuoteResponse {
  dstAmount: string;
}
interface OneInchSwapResponse {
  tx?: {to?: Address; data?: Hex};
}
interface LiFiQuoteResponse {
  estimate: {toAmount: string; approvalAddress?: Address};
  transactionRequest?: {to?: Address; data?: Hex};
}

// ── 1inch ────────────────────────────────────────────────────────────────────

export class OneInchAdapter implements AggregatorAdapter {
  readonly name = "1inch";

  constructor(private apiKey: string) {}

  private baseUrl(chainId: number): string {
    return `https://api.1inch.com/swap/v6.1/${chainId}`;
  }

  private headers(): Record<string, string> {
    return {Authorization: `Bearer ${this.apiKey}`, Accept: "application/json"};
  }

  async getQuote(p: QuoteParams): Promise<bigint | null> {
    try {
      const url = new URL(`${this.baseUrl(p.chainId)}/quote`);
      url.searchParams.set("src", p.srcToken);
      url.searchParams.set("dst", p.destToken);
      url.searchParams.set("amount", p.amount.toString());

      const res = await fetchWithTimeout(url.toString(), {headers: this.headers()});
      if (!res.ok) return null;
      const data = (await res.json()) as OneInchQuoteResponse;
      return BigInt(data.dstAmount);
    } catch {
      return null;
    }
  }

  async buildSwap(p: SwapBuildParams): Promise<AggregatorSwap> {
    const url = new URL(`${this.baseUrl(p.chainId)}/swap`);
    url.searchParams.set("src", p.srcToken);
    url.searchParams.set("dst", p.destToken);
    url.searchParams.set("amount", p.amount.toString());
    url.searchParams.set("from", p.receiver);
    url.searchParams.set("receiver", p.receiver);
    url.searchParams.set("slippage", (p.slippageBps / 100).toString());
    // The taker is a contract with no VUSD until the tx runs, so skip 1inch's balance simulation.
    url.searchParams.set("disableEstimate", "true");

    const res = await fetchWithTimeout(url.toString(), {headers: this.headers()});
    if (!res.ok) throw new Error(`1inch swap build failed: ${res.status}`);
    const data = (await res.json()) as OneInchSwapResponse;
    if (!data.tx?.to || !data.tx?.data) throw new Error("1inch swap response missing tx");
    return {
      target: data.tx.to,
      approveTarget: data.tx.to,
      swapCalldata: data.tx.data,
    };
  }
}

// ── LiFi (works keyless; a key only raises rate limits) ──────────────────────

export class LiFiAdapter implements AggregatorAdapter {
  readonly name = "lifi";

  constructor(private apiKey?: string) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {Accept: "application/json"};
    if (this.apiKey) h["x-lifi-api-key"] = this.apiKey;
    return h;
  }

  private url(p: QuoteParams): URL {
    const url = new URL("https://li.quest/v1/quote");
    url.searchParams.set("fromChain", p.chainId.toString());
    url.searchParams.set("toChain", p.chainId.toString());
    url.searchParams.set("fromToken", p.srcToken);
    url.searchParams.set("toToken", p.destToken);
    url.searchParams.set("fromAmount", p.amount.toString());
    return url;
  }

  async getQuote(p: QuoteParams): Promise<bigint | null> {
    try {
      const url = this.url(p);
      // A placeholder caller is enough for a price-only quote.
      url.searchParams.set("fromAddress", "0x0000000000000000000000000000000000000001");
      const res = await fetchWithTimeout(url.toString(), {headers: this.headers()});
      if (!res.ok) return null;
      const data = (await res.json()) as LiFiQuoteResponse;
      return BigInt(data.estimate.toAmount);
    } catch {
      return null;
    }
  }

  async buildSwap(p: SwapBuildParams): Promise<AggregatorSwap> {
    const url = this.url(p);
    url.searchParams.set("fromAddress", p.receiver);
    url.searchParams.set("toAddress", p.receiver);
    url.searchParams.set("slippage", (p.slippageBps / 10_000).toFixed(4));

    const res = await fetchWithTimeout(url.toString(), {headers: this.headers()});
    if (!res.ok) throw new Error(`LiFi swap build failed: ${res.status}`);
    const data = (await res.json()) as LiFiQuoteResponse;
    // Require the real spender for an ERC20-in swap; never fall back to approving the tx target.
    if (!data.estimate.approvalAddress) throw new Error("LiFi response missing approvalAddress");
    if (!data.transactionRequest?.to || !data.transactionRequest?.data)
      throw new Error("LiFi response missing transactionRequest");
    return {
      target: data.transactionRequest.to,
      approveTarget: data.estimate.approvalAddress,
      swapCalldata: data.transactionRequest.data,
    };
  }
}
