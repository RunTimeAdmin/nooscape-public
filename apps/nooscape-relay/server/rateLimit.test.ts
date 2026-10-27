import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import express from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { clientBucketKey, clientKeyFrom, consumeRateLimit, MAX_TRACKED_KEYS, peekRateLimit, rateLimitExpress, resetRateLimits, retryAfterSeconds, sweepExpiredRateLimits } from "./rateLimit";

describe("fixed-window rate limiting", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("allows requests up to the limit, then denies with a retry hint", () => {
    const start = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect(consumeRateLimit("a", 3, 1000, start + i).allowed).toBe(true);
    }
    const denied = consumeRateLimit("a", 3, 1000, start + 4);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(996);
    expect(denied.remaining).toBe(0);
  });

  it("resets the window after it elapses", () => {
    expect(consumeRateLimit("a", 1, 1000, 0).allowed).toBe(true);
    expect(consumeRateLimit("a", 1, 1000, 999).allowed).toBe(false);
    expect(consumeRateLimit("a", 1, 1000, 1000).allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    expect(consumeRateLimit("a", 1, 1000, 0).allowed).toBe(true);
    expect(consumeRateLimit("b", 1, 1000, 0).allowed).toBe(true);
    expect(consumeRateLimit("a", 1, 1000, 1).allowed).toBe(false);
  });

  it("reports remaining budget", () => {
    expect(consumeRateLimit("a", 5, 1000, 0).remaining).toBe(4);
    expect(consumeRateLimit("a", 5, 1000, 1).remaining).toBe(3);
  });

  it("peeks at a window without taking a place in it, and answers as the next consume would", () => {
    expect(peekRateLimit("a", 2, 1000, 0)).toEqual({ allowed: true, retryAfterMs: 0, remaining: 2 });
    expect(consumeRateLimit("a", 2, 1000, 0).allowed).toBe(true);
    // Any number of peeks leaves the count where it was.
    for (let index = 0; index < 5; index += 1) expect(peekRateLimit("a", 2, 1000, 1).allowed).toBe(true);
    expect(peekRateLimit("a", 2, 1000, 1).remaining).toBe(1);
    expect(consumeRateLimit("a", 2, 1000, 2).allowed).toBe(true);
    expect(peekRateLimit("a", 2, 1000, 3)).toEqual({ allowed: false, retryAfterMs: 997, remaining: 0 });
    expect(consumeRateLimit("a", 2, 1000, 3).allowed).toBe(false);
    // A window that has run out has room again, and a key nobody used has all of it.
    expect(peekRateLimit("a", 2, 1000, 1000).allowed).toBe(true);
    expect(peekRateLimit("b", 2, 1000, 3).remaining).toBe(2);
  });

  it("peeks where a full table would count a client it has no room for", () => {
    for (let index = 0; index < MAX_TRACKED_KEYS; index += 1) consumeRateLimit(`filler-${index}`, 10, 60_000, 0);
    // The table is full, so a new key shares one window with every other new key; once that window is used up the peek says so.
    for (let index = 0; index < 3; index += 1) consumeRateLimit(`newcomer-${index}`, 3, 60_000, 1);
    expect(peekRateLimit("newcomer-9", 3, 60_000, 2).allowed).toBe(false);
    expect(consumeRateLimit("newcomer-9", 3, 60_000, 2).allowed).toBe(false);
  });
});

describe("the wait a refused caller is told", () => {
  it("is whole seconds, rounded up, and never less than one (a Retry-After of 0 invites an immediate retry)", () => {
    for (const [milliseconds, seconds] of [[-5, 1], [0, 1], [1, 1], [1000, 1], [1001, 2], [59_001, 60]] as const) {
      expect(retryAfterSeconds(milliseconds), String(milliseconds)).toBe(seconds);
    }
  });
});

describe("client key derivation", () => {
  it("uses req.ip (Express handles X-Forwarded-For via trust proxy)", () => {
    // With trust proxy, Express extracts the client IP and sets req.ip.
    // clientKeyFrom no longer parses X-Forwarded-For directly.
    expect(
      clientKeyFrom({ headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" }, ip: "203.0.113.7" })
    ).toBe("203.0.113.7");
    expect(clientKeyFrom({ headers: { "x-forwarded-for": ["203.0.113.8"] }, ip: "203.0.113.8" })).toBe(
      "203.0.113.8"
    );
  });

  it("falls back to unknown when req.ip is not available", () => {
    expect(clientKeyFrom({ headers: {}, ip: "10.0.0.1" })).toBe("10.0.0.1");
    expect(clientKeyFrom({ ip: null })).toBe("unknown");
    expect(clientKeyFrom({})).toBe("unknown");
  });
});

describe("client bucket keys", () => {
  it("leave an IPv4 address and a non-address alone", () => {
    expect(clientBucketKey("203.0.113.7")).toBe("203.0.113.7");
    expect(clientBucketKey("unknown")).toBe("unknown");
    expect(clientBucketKey(null)).toBe("unknown");
    expect(clientBucketKey("")).toBe("unknown");
  });

  it("turn an IPv4-mapped IPv6 address into its IPv4 form, written either way", () => {
    expect(clientBucketKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(clientBucketKey("::ffff:cb00:7107")).toBe("203.0.113.7");
  });

  it("collapse an IPv6 address to its /64, however it is written", () => {
    const key = "2001:0db8:0001:0002::/64";
    expect(clientBucketKey("2001:db8:1:2:3:4:5:6")).toBe(key);
    expect(clientBucketKey("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).toBe(key);
    expect(clientBucketKey("2001:DB8:1:2::1")).toBe(key);
    expect(clientBucketKey("2001:db8:1:2::")).toBe(key);
  });

  it("give two networks two keys, and a short address its zero groups", () => {
    expect(clientBucketKey("2001:db8:1:3::1")).not.toBe(clientBucketKey("2001:db8:1:2::1"));
    expect(clientBucketKey("::1")).toBe("0000:0000:0000:0000::/64");
    expect(clientBucketKey("2001:db8::1")).toBe("2001:0db8:0000:0000::/64");
  });

  it("ignore a zone id", () => {
    expect(clientBucketKey("fe80::1%eth0")).toBe(clientBucketKey("fe80::2"));
  });

  it("cut something that is not an address to 64 characters", () => {
    expect(clientBucketKey("x".repeat(500))).toHaveLength(64);
  });

  it("are what clientKeyFrom returns", () => {
    expect(clientKeyFrom({ ip: "2001:db8:1:2:3:4:5:6" })).toBe("2001:0db8:0001:0002::/64");
  });
});

describe("a flood of new keys", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  const fill = (count: number, now: number, windowMs = 1000) => {
    for (let i = 0; i < count; i += 1) consumeRateLimit(`fill:${i}`, 5, windowMs, now);
  };

  it("does not slow the limiter down (the earlier version took 29 seconds for 50,000 keys and grew from there)", () => {
    const started = Date.now();
    for (let i = 0; i < MAX_TRACKED_KEYS * 3; i += 1) consumeRateLimit(`flood:${i}`, 600, 300_000, 1_000_000 + i);
    // A generous bound for a loaded machine: the quadratic version needs minutes for this.
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("counts a client the full table has not seen in one shared window, and keeps known clients separate", () => {
    consumeRateLimit("known", 2, 60_000, 0);
    fill(MAX_TRACKED_KEYS, 1, 60_000);
    const verdicts = [1, 2, 3, 4].map(i => consumeRateLimit(`new:${i}`, 3, 60_000, 2).allowed);
    expect(verdicts).toEqual([true, true, true, false]);
    expect(consumeRateLimit("known", 2, 60_000, 3).allowed).toBe(true);
    expect(consumeRateLimit("known", 2, 60_000, 4).allowed).toBe(false);
  });

  it("keeps a separate shared window for each limit", () => {
    fill(MAX_TRACKED_KEYS, 0, 60_000);
    expect(consumeRateLimit("a:1", 1, 60_000, 1).allowed).toBe(true);
    expect(consumeRateLimit("a:2", 1, 60_000, 2).allowed).toBe(false);
    expect(consumeRateLimit("b:1", 1, 300_000, 3).allowed).toBe(true);
  });

  it("lets go of expired windows before it falls back to the shared window", () => {
    fill(MAX_TRACKED_KEYS, 0, 1000);
    // Two seconds later every window in the table has run out, so new clients are tracked one by one.
    const first = consumeRateLimit("late:1", 1, 1000, 2000);
    const second = consumeRateLimit("late:2", 1, 1000, 2001);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(consumeRateLimit("late:1", 1, 1000, 2002).allowed).toBe(false);
  });

  it("sweeps only what has expired", () => {
    consumeRateLimit("short", 1, 1000, 0);
    consumeRateLimit("long", 1, 60_000, 0);
    sweepExpiredRateLimits(5000);
    expect(consumeRateLimit("short", 1, 1000, 5001).allowed).toBe(true);
    expect(consumeRateLimit("long", 1, 60_000, 5001).allowed).toBe(false);
  });
});

/**
 * The limiter refuses a client before its body is read. Mounted after express.json, a client over its limit still had
 * every body of up to 1 MB parsed before the 429, so the limit did not bound what the flood cost.
 */
describe("the tRPC limiter and the body parser", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("is mounted ahead of the body parsers in the server", () => {
    const source = readFileSync(new URL("./_core/index.ts", import.meta.url), "utf8");
    const limiter = source.indexOf('app.use("/api/trpc", rateLimitExpress(');
    expect(limiter).toBeGreaterThan(-1);
    expect(limiter).toBeLessThan(source.indexOf("app.use(express.json("));
    expect(limiter).toBeLessThan(source.indexOf("app.use(express.urlencoded("));
  });

  it("answers a client over its limit with 429 without parsing the body", async () => {
    let parsedBodies = 0;
    const app = express();
    app.use("/api/trpc", rateLimitExpress("order-test", 1, 60_000));
    app.use(express.json({ limit: "1mb" }));
    app.use((_req, _res, next) => {
      parsedBodies += 1;
      next();
    });
    app.use("/api/trpc", (_req, res) => {
      res.json({ ok: true });
    });
    const server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const address = server.address();
      const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/trpc/x`;
      const post = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
      // The first request is within the limit, so its malformed body reaches the parser and is refused there.
      expect((await post()).status).toBe(400);
      expect((await post()).status).toBe(429);
      expect(parsedBodies).toBe(0);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
