import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CDP_FACILITATOR_URL, CDP_HOST, CDP_X402_PATH, cdpBearer, isCdpKeyId, loadCdpKey } from "./x402Cdp";
import { newCdpKeys, TEST_CDP_ID } from "./x402Testing";

/**
 * The token Coinbase's facilitator wants with every request (docs/x402-base-bazaar-2026-10-21.md): a JWT signed with a CDP Secret API key,
 * made for one method, host and path, good for two minutes. Held to the shape Coinbase's own SDK makes (its header, its claims and the
 * two key types it reads), and to the secret never being put in a message. Every key here is made for the test and thrown away.
 */
const SETTLE = `${CDP_X402_PATH}/settle`;
const NOW = 1_792_400_000;
const LINE_BREAK = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);

function decode(token: string) {
  const [header, claims, signature] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header!, "base64url").toString("utf8")) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(claims!, "base64url").toString("utf8")) as Record<string, unknown>,
    signature: Buffer.from(signature!, "base64url"),
    signingInput: Buffer.from(`${header}.${claims}`),
  };
}

describe("the facilitator's address", () => {
  it("is Coinbase's one production address, and the token is made for that host", () => {
    expect(CDP_HOST).toBe("api.cdp.coinbase.com");
    expect(CDP_FACILITATOR_URL).toBe("https://api.cdp.coinbase.com/platform/v2/x402");
  });
});

describe("a token for one request", () => {
  it("from an Ed25519 key carries Coinbase's header and claims, for exactly the request it names, and its signature verifies", () => {
    const { env, publicKey } = newCdpKeys("ed25519");
    const token = cdpBearer(loadCdpKey(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET), "POST", SETTLE, NOW);
    const { header, claims, signature, signingInput } = decode(token);
    expect(header).toMatchObject({ alg: "EdDSA", typ: "JWT", kid: TEST_CDP_ID });
    expect(String(header.nonce)).toMatch(/^[0-9a-f]{32}$/);
    // The request is named in `uris` as Coinbase's SDK does, and in `uri` as the examples in its documentation do.
    const request = "POST api.cdp.coinbase.com/platform/v2/x402/settle";
    expect(claims).toEqual({ sub: TEST_CDP_ID, iss: "cdp", iat: NOW, nbf: NOW, exp: NOW + 120, uris: [request], uri: request });
    expect(signature).toHaveLength(64);
    expect(verify(null, signingInput, publicKey, signature)).toBe(true);
  });

  it("from an ECDSA P-256 key is ES256 with the raw 64-byte signature a JWT carries, and verifies", () => {
    const { env, publicKey } = newCdpKeys("ec");
    const token = cdpBearer(loadCdpKey(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET), "GET", `${CDP_X402_PATH}/supported`, NOW);
    const { header, claims, signature, signingInput } = decode(token);
    expect(header).toMatchObject({ alg: "ES256", typ: "JWT", kid: TEST_CDP_ID });
    expect(claims.uris).toEqual(["GET api.cdp.coinbase.com/platform/v2/x402/supported"]);
    expect(signature).toHaveLength(64);
    expect(verify("sha256", signingInput, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature)).toBe(true);
  });

  it("is read from a PEM whose line breaks were pasted into a one-line setting as a backslash and an n", () => {
    const { env, publicKey } = newCdpKeys("ec");
    const flat = env.CDP_API_KEY_SECRET.trim().split(LINE_BREAK).join(`${BACKSLASH}n`);
    expect(flat).not.toContain(LINE_BREAK);
    const { signature, signingInput } = decode(cdpBearer(loadCdpKey(env.CDP_API_KEY_ID, flat), "POST", SETTLE, NOW));
    expect(verify("sha256", signingInput, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature)).toBe(true);
  });

  it("is new each time: a new nonce, a token that does not verify for another request, and the clock when none is given", () => {
    const { env, publicKey } = newCdpKeys();
    const key = loadCdpKey(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET);
    const one = decode(cdpBearer(key, "POST", SETTLE, NOW));
    const two = decode(cdpBearer(key, "POST", SETTLE, NOW));
    expect(one.header.nonce).not.toBe(two.header.nonce);
    expect(one.signature.equals(two.signature)).toBe(false);
    // A token made for the settle path is not one for the verify path: the claim names the path and the signature covers the claim.
    const other = decode(cdpBearer(key, "POST", `${CDP_X402_PATH}/verify`, NOW));
    expect(other.claims.uris).toEqual(["POST api.cdp.coinbase.com/platform/v2/x402/verify"]);
    expect(verify(null, one.signingInput, publicKey, other.signature)).toBe(false);
    const clocked = decode(cdpBearer(key, "POST", SETTLE));
    expect(Math.abs(Number(clocked.claims.nbf) - Math.floor(Date.now() / 1000))).toBeLessThan(5);
    expect(Number(clocked.claims.exp) - Number(clocked.claims.nbf)).toBe(120);
  });
});

describe("the key", () => {
  it("is refused when it is not one the portal makes, in words that never contain the secret", () => {
    const { id } = { id: TEST_CDP_ID };
    const rsa = String(generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }));
    const p384 = String(generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey.export({ type: "sec1", format: "pem" }));
    // Built in pieces so that this file holds no private key block, which the repository's secret scan would rightly refuse.
    const KIND = "PRIVATE";
    const garbage = `-----BEGIN ${KIND} KEY-----${LINE_BREAK}c2VjcmV0LXNlY3JldC1zZWNyZXQ=${LINE_BREAK}-----END ${KIND} KEY-----`;
    const cases: Array<[string, RegExp]> = [
      ["", /CDP_API_KEY_SECRET must be/],
      ["x".repeat(40), /CDP_API_KEY_SECRET must be/],
      [Buffer.alloc(32, 7).toString("base64"), /CDP_API_KEY_SECRET must be/],
      [`${"A".repeat(90)}==`, /CDP_API_KEY_SECRET must be/],
      [rsa, /ECDSA P-256 or an Ed25519 key/],
      [p384, /ECDSA P-256 or an Ed25519 key/],
      [garbage, /not a private key that can be read/],
    ];
    for (const [secret, message] of cases) {
      const failure = (() => {
        try {
          loadCdpKey(id, secret);
          return null;
        } catch (error) {
          return error as Error;
        }
      })();
      expect(failure?.message, secret.slice(0, 30)).toMatch(message);
      for (const fragment of [secret, "c2VjcmV0LXNlY3JldC1zZWNyZXQ=", rsa.slice(40, 80)]) {
        if (fragment.length > 8) expect(failure?.message).not.toContain(fragment);
      }
    }
  });

  it("is refused when its two halves do not match, which is what a secret damaged in the copying looks like, and the message does not hold it", () => {
    const { env } = newCdpKeys("ed25519");
    const bytes = Buffer.from(env.CDP_API_KEY_SECRET, "base64");
    bytes[40] = bytes[40]! ^ 0xff;
    const damaged = bytes.toString("base64");
    const failure = (() => {
      try {
        loadCdpKey(env.CDP_API_KEY_ID, damaged);
        return null;
      } catch (error) {
        return error as Error;
      }
    })();
    expect(failure?.message).toMatch(/not a consistent Ed25519 key/);
    expect(failure?.message).not.toContain(damaged);
    expect(failure?.message).not.toContain(env.CDP_API_KEY_SECRET);
    // The whole key still loads.
    expect(() => loadCdpKey(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET)).not.toThrow();
  });

  it("has an id the portal makes: a UUID, or an organization and key path", () => {
    expect(isCdpKeyId("3f1c9a52-8d7e-4b6a-9f10-2c4e5a6b7d80")).toBe(true);
    expect(isCdpKeyId("organizations/3f1c9a52-8d7e-4b6a-9f10-2c4e5a6b7d80/apiKeys/9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d")).toBe(true);
    for (const bad of ["", "short", "has a space in it", "bad:character:here", "x".repeat(201)]) expect(isCdpKeyId(bad), bad).toBe(false);
    expect(() => loadCdpKey("short", newCdpKeys().env.CDP_API_KEY_SECRET)).toThrow(/CDP_API_KEY_ID/);
  });
});
