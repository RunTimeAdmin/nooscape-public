import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import {
  assertOperatorLoginAllowed,
  clearOperatorLoginFailures,
  clearOperatorSession,
  establishOperatorSession,
  getAuthenticatedOperator,
  hasValidOperatorSession,
  isOperatorAuthConfigured,
  isValidOperatorToken,
  OPERATOR_SESSION_MS,
  recordOperatorLoginFailure,
} from "./operatorAuth";

const originalToken = process.env.NOOSCAPE_OPERATOR_TOKEN;

/** Minimal Express-shaped request: the lockout must key on the socket address alone. */
function fakeRequest(socketAddress: string, headers: Record<string, string> = {}) {
  return {
    headers,
    socket: { remoteAddress: socketAddress },
    ip: socketAddress,
  } as unknown as Request;
}

const usedSockets = new Set<string>();

/** Minimal Express-shaped response capturing Set-Cookie calls in memory. */
function fakeResponse() {
  const cookies = new Map<string, { value: string; options: Record<string, unknown> }>();
  return {
    cookies,
    cookie(name: string, value: string, options: Record<string, unknown> = {}) {
      cookies.set(name, { value, options });
      return this;
    },
    clearCookie(name: string) {
      cookies.delete(name);
      return this;
    },
  };
}

type EstablishedSession = { socket: string; cookieName: string; sessionId: string };
const established: EstablishedSession[] = [];

/** Establishes a session through the real code path and records it for cleanup. */
function establish(socket: string, headers: Record<string, string> = {}) {
  const req = fakeRequest(socket, headers);
  const res = fakeResponse();
  establishOperatorSession(req, res as unknown as Response);
  const cookieName = res.cookies.has("__Host-nooscape_operator")
    ? "__Host-nooscape_operator"
    : "nooscape_operator";
  const entry = { socket, cookieName, sessionId: res.cookies.get(cookieName)!.value };
  established.push(entry);
  return entry;
}

afterEach(() => {
  vi.useRealTimers();
  if (originalToken === undefined) delete process.env.NOOSCAPE_OPERATOR_TOKEN;
  else process.env.NOOSCAPE_OPERATOR_TOKEN = originalToken;
  // The failure counters are module state; reset every socket this file
  // touched plus the global window so tests stay order-independent.
  for (const socket of usedSockets) clearOperatorLoginFailures(fakeRequest(socket));
  clearOperatorLoginFailures(fakeRequest("cleanup"));
  usedSockets.clear();
  // Sessions are module state too: revoke every session a test created so a
  // later test cannot inherit a live cookie id.
  for (const session of established) {
    clearOperatorSession(
      fakeRequest(session.socket, { cookie: `${session.cookieName}=${session.sessionId}` }),
      fakeResponse() as unknown as Response
    );
  }
  established.length = 0;
});

describe("production operator token", () => {
  it("requires a sufficiently strong configured token", () => {
    process.env.NOOSCAPE_OPERATOR_TOKEN = "too-short";
    expect(isOperatorAuthConfigured()).toBe(false);
    expect(isValidOperatorToken("too-short")).toBe(false);
  });

  it("accepts only the exact configured token", () => {
    process.env.NOOSCAPE_OPERATOR_TOKEN = "a".repeat(48);
    expect(isOperatorAuthConfigured()).toBe(true);
    expect(isValidOperatorToken("a".repeat(48))).toBe(true);
    expect(isValidOperatorToken("b".repeat(48))).toBe(false);
    expect(isValidOperatorToken("a".repeat(47))).toBe(false);
  });

  it("answers false, never throws, for a guess that is the right length in characters but not in bytes", () => {
    process.env.NOOSCAPE_OPERATOR_TOKEN = "a".repeat(48);
    // 47 ASCII characters plus one two-byte character: 48 UTF-16 units, 49 UTF-8 bytes.
    // A byte comparison that assumed equal lengths threw here, and the 500 told a guesser the token length.
    expect(() => isValidOperatorToken("a".repeat(47) + "\u00e9")).not.toThrow();
    expect(isValidOperatorToken("a".repeat(47) + "\u00e9")).toBe(false);
    expect(isValidOperatorToken("\u{1F989}".repeat(24))).toBe(false);
  });

  it("answers false for guesses of any length, so no length gets a different kind of answer", () => {
    process.env.NOOSCAPE_OPERATOR_TOKEN = "a".repeat(48);
    for (const length of [0, 1, 31, 47, 49, 64, 4096]) {
      expect(isValidOperatorToken("a".repeat(length))).toBe(false);
    }
  });

  it("still accepts a configured token that holds a multi-byte character", () => {
    const token = "caf\u00e9-".repeat(8);
    process.env.NOOSCAPE_OPERATOR_TOKEN = token;
    expect(isOperatorAuthConfigured()).toBe(true);
    expect(isValidOperatorToken(token)).toBe(true);
    expect(isValidOperatorToken(token.replace("\u00e9", "e"))).toBe(false);
  });
});

describe("operator login lockout", () => {
  it("keys failures on the socket address, not the spoofable X-Forwarded-For header", () => {
    usedSockets.add("10.0.0.1");
    usedSockets.add("10.0.0.2");
    // Five failures whose XFF header rotates every call: the old keying would
    // have seen five different requesters and never locked anything.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      recordOperatorLoginFailure(fakeRequest("10.0.0.1", { "x-forwarded-for": `9.9.9.${attempt}` }));
    }
    expect(() =>
      assertOperatorLoginAllowed(fakeRequest("10.0.0.1", { "x-forwarded-for": "9.9.9.99" }))
    ).toThrow(/Too many operator login attempts/);
    // A genuinely different socket is judged on its own record.
    expect(() => assertOperatorLoginAllowed(fakeRequest("10.0.0.2"))).not.toThrow();
  });

  it("caps total failures globally so rotating sockets cannot out-guess the window", () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const socket = `172.16.0.${attempt}`;
      usedSockets.add(socket);
      recordOperatorLoginFailure(fakeRequest(socket));
    }
    // Each socket is individually clean, but the global window is exhausted.
    expect(() => assertOperatorLoginAllowed(fakeRequest("172.16.0.999"))).toThrow(
      /Too many operator login attempts/
    );
  });

  it("resets the global window together with the per-address one on success", () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const socket = `192.168.0.${attempt}`;
      usedSockets.add(socket);
      recordOperatorLoginFailure(fakeRequest(socket));
    }
    expect(() => assertOperatorLoginAllowed(fakeRequest("192.168.0.999"))).toThrow(
      /Too many operator login attempts/
    );
    // A successful login (the legitimate operator) clears everything.
    clearOperatorLoginFailures(fakeRequest("192.168.0.999"));
    expect(() => assertOperatorLoginAllowed(fakeRequest("192.168.0.999"))).not.toThrow();
  });
});

describe("operator lockout cannot be used against the operator", () => {
  it("lets the correct token through a full global window", () => {
    process.env.NOOSCAPE_OPERATOR_TOKEN = "a".repeat(48);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const socket = `198.51.100.${attempt}`;
      usedSockets.add(socket);
      recordOperatorLoginFailure(fakeRequest(socket));
    }
    const operator = fakeRequest("198.51.100.200");
    expect(() => assertOperatorLoginAllowed(operator)).toThrow(/Too many operator login attempts/);
    expect(() => assertOperatorLoginAllowed(operator, "b".repeat(48))).toThrow(/Too many operator login attempts/);
    expect(() => assertOperatorLoginAllowed(operator, "a".repeat(48))).not.toThrow();
  });

  it("lets the correct token through a locked address, and still locks the guesser", () => {
    process.env.NOOSCAPE_OPERATOR_TOKEN = "a".repeat(48);
    usedSockets.add("203.0.113.50");
    for (let attempt = 0; attempt < 5; attempt += 1) recordOperatorLoginFailure(fakeRequest("203.0.113.50"));
    expect(() => assertOperatorLoginAllowed(fakeRequest("203.0.113.50"), "c".repeat(48))).toThrow(/Too many/);
    expect(() => assertOperatorLoginAllowed(fakeRequest("203.0.113.50"), "a".repeat(48))).not.toThrow();
  });

  it("counts a wrong header token as a failure, and never counts a correct one", async () => {
    process.env.NOOSCAPE_OPERATOR_TOKEN = "a".repeat(48);
    usedSockets.add("192.0.2.77");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const req = fakeRequest("192.0.2.77", { "x-nooscape-operator-token": "z".repeat(48) });
      expect(await getAuthenticatedOperator(req)).toBeNull();
    }
    expect(() => assertOperatorLoginAllowed(fakeRequest("192.0.2.77"), "z".repeat(48))).toThrow(/Too many/);
  });
});

describe("operator session cookies", () => {
  it("issues a random server-side session id — never the master token itself", () => {
    process.env.NOOSCAPE_OPERATOR_TOKEN = "s".repeat(48);
    const { cookieName, sessionId } = establish("10.1.0.1");
    // A 64-hex random id, not the configured token the cookie used to carry.
    expect(sessionId).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionId).not.toBe(process.env.NOOSCAPE_OPERATOR_TOKEN);
    expect(hasValidOperatorSession(fakeRequest("10.1.0.1", { cookie: `${cookieName}=${sessionId}` }))).toBe(true);
  });

  it("clear revokes the server-side session so a stolen cookie stops authenticating", () => {
    process.env.NOOSCAPE_OPERATOR_TOKEN = "r".repeat(48);
    const { cookieName, sessionId, socket } = establish("10.1.0.2");
    const authed = () => fakeRequest(socket, { cookie: `${cookieName}=${sessionId}` });
    expect(hasValidOperatorSession(authed())).toBe(true);
    clearOperatorSession(authed(), fakeResponse() as unknown as Response);
    expect(hasValidOperatorSession(authed())).toBe(false);
  });

  it("rejects unknown ids and a cookie that merely echoes the master token", () => {
    process.env.NOOSCAPE_OPERATOR_TOKEN = "t".repeat(48);
    expect(hasValidOperatorSession(fakeRequest("10.1.0.3", { cookie: `nooscape_operator=${"f".repeat(64)}` }))).toBe(false);
    expect(
      hasValidOperatorSession(
        fakeRequest("10.1.0.3", { cookie: `nooscape_operator=${process.env.NOOSCAPE_OPERATOR_TOKEN}` })
      )
    ).toBe(false);
    expect(hasValidOperatorSession(fakeRequest("10.1.0.3"))).toBe(false);
  });

  it("expires sessions server-side after OPERATOR_SESSION_MS", () => {
    vi.useFakeTimers();
    process.env.NOOSCAPE_OPERATOR_TOKEN = "e".repeat(48);
    const { cookieName, sessionId, socket } = establish("10.1.0.4");
    const authed = () => fakeRequest(socket, { cookie: `${cookieName}=${sessionId}` });
    expect(hasValidOperatorSession(authed())).toBe(true);
    vi.advanceTimersByTime(OPERATOR_SESSION_MS);
    expect(hasValidOperatorSession(authed())).toBe(false);
  });

  it("sets the __Host- cookie with secure flags on https requests", () => {
    process.env.NOOSCAPE_OPERATOR_TOKEN = "h".repeat(48);
    const { cookieName, sessionId } = establish("10.1.0.5", { "x-forwarded-proto": "https" });
    expect(cookieName).toBe("__Host-nooscape_operator");
    expect(
      hasValidOperatorSession(fakeRequest("10.1.0.5", { cookie: `__Host-nooscape_operator=${sessionId}` }))
    ).toBe(true);
  });
});
