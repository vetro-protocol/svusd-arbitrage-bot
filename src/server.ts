import {createServer, type Server} from "node:http";

/**
 * Liveness for Render's /status health check. The loop stamps activity each tick;
 * if nothing stamps within `staleMs`, /status returns 503 and Render restarts a
 * wedged bot (a hung RPC stops the loop silently). Body is chain-derivable only,
 * no secrets, so it is safe on the public URL.
 */
export interface HealthSnapshot {
  ok: boolean;
  mode: string;
  txMode: string;
  paused: boolean;
  uptimeSec: number;
  lastTickAt: string | null;
  ticks: number;
  openPositions: number | null;
  lastError: string | null;
}

export class Health {
  private readonly startedAt = Date.now();
  private lastActivityAt = Date.now();
  private lastTickAt: number | null = null;
  private ticks = 0;
  private lastError: string | null = null;
  private openPositions: number | null = null;

  constructor(
    private readonly mode: string,
    private readonly txMode: string,
    private readonly paused: boolean,
    private readonly staleMs: number,
  ) {}

  /** Reset the freshness clock so the tick has a full window to complete. */
  tickStart(): void {
    this.lastActivityAt = Date.now();
  }

  tickEnd(openPositions: number | null): void {
    const now = Date.now();
    this.lastActivityAt = now;
    this.lastTickAt = now;
    this.ticks += 1;
    if (openPositions !== null) this.openPositions = openPositions;
  }

  /** An error is still progress: the loop caught it and will reschedule, so stamp activity. */
  recordError(message: string): void {
    this.lastError = message;
    this.lastActivityAt = Date.now();
  }

  private isFresh(now: number): boolean {
    return now - this.lastActivityAt <= this.staleMs;
  }

  snapshot(): HealthSnapshot {
    const now = Date.now();
    return {
      ok: this.isFresh(now),
      mode: this.mode,
      txMode: this.txMode,
      paused: this.paused,
      uptimeSec: Math.floor((now - this.startedAt) / 1000),
      lastTickAt: this.lastTickAt ? new Date(this.lastTickAt).toISOString() : null,
      ticks: this.ticks,
      openPositions: this.openPositions,
      lastError: this.lastError,
    };
  }
}

/** A Render web service must bind $PORT, so this runs in every mode, dry-run included. */
export function startHealthServer(health: Health, port: number): Server {
  const server = createServer((req, res) => {
    if (
      req.method === "GET" &&
      (req.url === "/status" || req.url === "/" || req.url === "/healthz")
    ) {
      const snap = health.snapshot();
      res.writeHead(snap.ok ? 200 : 503, {"content-type": "application/json"});
      res.end(JSON.stringify(snap));
      return;
    }
    res.writeHead(404, {"content-type": "application/json"});
    res.end(JSON.stringify({error: "not found"}));
  });
  server.listen(port, () => console.log(`  health server on :${port} (GET /status)`));
  return server;
}
