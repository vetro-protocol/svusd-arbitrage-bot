// Health: the /status liveness contract that decides whether Render restarts a wedged bot. A tick or
// a caught error stamps activity; if nothing stamps within staleMs, ok flips false (503). Fake timers
// drive the clock the source reads via Date.now().

import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {Health} from "../../src/server.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Health", () => {
  it("is fresh within the window and goes stale (503) once staleMs elapses", () => {
    const h = new Health("live-bot", "dry-run", false, 1_000);
    expect(h.snapshot().ok).toBe(true);
    vi.advanceTimersByTime(1_001);
    expect(h.snapshot().ok).toBe(false);
  });

  it("tickEnd refreshes the clock, counts ticks, and records open positions", () => {
    const h = new Health("live-bot", "live", false, 1_000);
    vi.advanceTimersByTime(900);
    h.tickEnd(3);
    vi.advanceTimersByTime(900); // 900 since the tick, still inside the 1000 window
    const s = h.snapshot();
    expect(s.ok).toBe(true);
    expect(s.ticks).toBe(1);
    expect(s.openPositions).toBe(3);
  });

  it("tickEnd(null) preserves the last known open-position count", () => {
    const h = new Health("m", "t", false, 1_000);
    h.tickEnd(5);
    h.tickEnd(null);
    const s = h.snapshot();
    expect(s.openPositions).toBe(5);
    expect(s.ticks).toBe(2);
  });

  it("recordError stamps activity so a caught error still reads as alive", () => {
    const h = new Health("m", "t", false, 1_000);
    vi.advanceTimersByTime(900);
    h.recordError("rpc timeout");
    vi.advanceTimersByTime(900);
    const s = h.snapshot();
    expect(s.ok).toBe(true); // the error refreshed the clock
    expect(s.lastError).toBe("rpc timeout");
  });

  it("snapshot reflects mode, txMode, paused, and a null lastTickAt before any tick", () => {
    const s = new Health("live-bot", "live", true, 1_000).snapshot();
    expect(s.mode).toBe("live-bot");
    expect(s.txMode).toBe("live");
    expect(s.paused).toBe(true);
    expect(s.lastTickAt).toBeNull();
  });
});
