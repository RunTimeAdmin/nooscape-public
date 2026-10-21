import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { parse as parseCookie } from "cookie";
import type { Request, Response } from "express";
import type { User } from "../drizzle/schema";
import { getUserByOpenId } from "./db";

const SECURE_COOKIE_NAME = "__Host-nooscape_operator";
const LOCAL_COOKIE_NAME = "nooscape_operator";
/**
 * Operator browser sessions live server-side: the cookie carries a random
 * single-purpose id that this process can revoke (logout) and that expires
 * with the window. The master token itself is never stored in a cookie, so a
 * leaked cookie is revocable and logout means logout (review 2026-10-12).
 */
export const OPERATOR_SESSION_MS = 8 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
/**
 * Global cap across all requesters: bounds total guesses even when sockets cannot be distinguished.
 * It only ever refuses a wrong token. A correct token passes it (see assertOperatorLoginAllowed), so anyone
 * who sends 20 bad guesses blocks other guessers and never the operator.
 */
const MAX_GLOBAL_FAILURES = 20;
const WINDOW_MS = 15 * 60 * 1000;

type AttemptWindow = { count: number; startedAt: number };
const attemptsByRequester = new Map<string, AttemptWindow>();
const globalAttempts: { current: AttemptWindow | null } = { current: null };
/** Live operator sessions: cookie id → expiry. Restarting the app clears the map (operator re-logs in). */
const sessionsById = new Map<string, { expiresAt: number }>();

function isSecureRequest(req: Request) {
  if (req.protocol === "https") return true;
  const forwarded = req.headers["x-forwarded-proto"];
  const values = Array.isArray(forwarded) ? forwarded : (forwarded ?? "").split(",");
  return values.some(value => value.trim().toLowerCase() === "https");
}

function activeCookieName(req: Request) {
  return isSecureRequest(req) ? SECURE_COOKIE_NAME : LOCAL_COOKIE_NAME;
}

function requesterKey(req: Request) {
  // The socket address only. X-Forwarded-For is client-supplied: keying the
  // lockout on it let a guesser rotate the header per attempt and dodge the
  // counter entirely (operator report 2026-10-11). Behind a trusted proxy all
  // requesters share one socket key, which is why the global cap backs this up.
  return req.socket?.remoteAddress ?? req.ip ?? "unknown";
}

function windowExpired(record: AttemptWindow) {
  return Date.now() - record.startedAt >= WINDOW_MS;
}

function activeGlobalFailures(): number {
  const record = globalAttempts.current;
  if (!record) return 0;
  if (windowExpired(record)) {
    globalAttempts.current = null;
    return 0;
  }
  return record.count;
}

function expectedToken() {
  return process.env.NOOSCAPE_OPERATOR_TOKEN?.trim() ?? "";
}

export function isOperatorAuthConfigured() {
  return expectedToken().length >= 32;
}

function digestOf(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

export function isValidOperatorToken(candidate: string) {
  const expected = expectedToken();
  if (expected.length < 32) return false;
  // Compare fixed-length digests. Comparing the raw bytes needed equal lengths: a guess with the
  // right character count but a different byte count made timingSafeEqual throw (a 500 that told
  // the guesser the token's length), and a length check ahead of it answered wrong lengths faster.
  return timingSafeEqual(digestOf(candidate), digestOf(expected));
}

/**
 * Throws when this login attempt should be refused for rate limiting.
 * A correct token is never refused. The lockout exists to slow guessing, and a token of 32 or more characters
 * cannot be guessed, so letting the right one through costs nothing. Behind the reverse proxy every visitor
 * shares one socket address, so without this exemption 20 bad guesses from anyone locked the operator out of
 * their own login for 15 minutes, as often as the attacker liked (consulting review 2026-10-16, M1).
 */
export function assertOperatorLoginAllowed(req: Request, candidate = "") {
  if (candidate && isValidOperatorToken(candidate)) return;
  if (activeGlobalFailures() >= MAX_GLOBAL_FAILURES) {
    throw new Error("Too many operator login attempts. Try again in a few minutes.");
  }
  const key = requesterKey(req);
  const record = attemptsByRequester.get(key);
  if (!record) return;
  if (windowExpired(record)) {
    attemptsByRequester.delete(key);
    return;
  }
  if (record.count >= MAX_FAILURES) {
    throw new Error("Too many operator login attempts. Try again in a few minutes.");
  }
}

export function recordOperatorLoginFailure(req: Request) {
  const now = Date.now();
  const global = globalAttempts.current;
  globalAttempts.current =
    !global || windowExpired(global)
      ? { count: 1, startedAt: now }
      : { ...global, count: global.count + 1 };
  const key = requesterKey(req);
  const current = attemptsByRequester.get(key);
  if (!current || windowExpired(current)) {
    attemptsByRequester.set(key, { count: 1, startedAt: now });
    return;
  }
  attemptsByRequester.set(key, { ...current, count: current.count + 1 });
}

export function clearOperatorLoginFailures(req: Request) {
  attemptsByRequester.delete(requesterKey(req));
  // A successful login proves the token is known, so the accumulated
  // failures were almost certainly the legitimate operator: the global
  // window resets together with the per-address one.
  globalAttempts.current = null;
}

function pruneExpiredSessions(now = Date.now()) {
  sessionsById.forEach((session, id) => {
    if (session.expiresAt <= now) sessionsById.delete(id);
  });
}

function presentedSessionId(req: Request) {
  const cookies = parseCookie(req.headers.cookie ?? "");
  return cookies[SECURE_COOKIE_NAME] ?? cookies[LOCAL_COOKIE_NAME] ?? null;
}

/** True when the request presents a live, unexpired operator session cookie. */
export function hasValidOperatorSession(req: Request) {
  const id = presentedSessionId(req);
  if (!id) return false;
  const session = sessionsById.get(id);
  if (!session) return false;
  if (session.expiresAt <= Date.now()) {
    sessionsById.delete(id);
    return false;
  }
  return true;
}

function readPresentedHeaderToken(req: Request) {
  const header = req.headers["x-nooscape-operator-token"];
  return typeof header === "string" && header.length > 0 ? header : "";
}

/** Resolves a server-side operator identity via the header master token or a live session cookie. */
export async function getAuthenticatedOperator(req: Request): Promise<User | null> {
  const presented = readPresentedHeaderToken(req);
  const byMasterToken = isValidOperatorToken(presented);
  // A wrong header token is a guess like a wrong login, so it is counted the same way. It used to cost nothing.
  if (presented && !byMasterToken) recordOperatorLoginFailure(req);
  if (!byMasterToken && !hasValidOperatorSession(req)) return null;
  return (await getUserByOpenId("nooscape-production-operator")) ?? null;
}

export function establishOperatorSession(req: Request, res: Response) {
  if (!isOperatorAuthConfigured()) throw new Error("Operator authentication is not configured.");
  pruneExpiredSessions();
  const sessionId = randomBytes(32).toString("hex");
  sessionsById.set(sessionId, { expiresAt: Date.now() + OPERATOR_SESSION_MS });
  const secure = isSecureRequest(req);
  res.cookie(activeCookieName(req), sessionId, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure,
    maxAge: OPERATOR_SESSION_MS,
  });
}

export function clearOperatorSession(req: Request, res: Response) {
  const id = presentedSessionId(req);
  if (id) sessionsById.delete(id);
  const secure = isSecureRequest(req);
  for (const name of [SECURE_COOKIE_NAME, LOCAL_COOKIE_NAME]) {
    res.clearCookie(name, { httpOnly: true, path: "/", sameSite: "lax", secure, maxAge: -1 });
  }
}
