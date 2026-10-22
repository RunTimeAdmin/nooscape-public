import { createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from "node:crypto";

/**
 * Coinbase's CDP facilitator, which settles the Base payments and catalogues the endpoint in the Bazaar (docs/x402-base-bazaar-2026-10-21.md).
 * It takes a bearer token that is a JWT signed with a CDP Secret API key and made for one request: it names the method, the host and the
 * path it is good for, it lasts two minutes, and it is sent to one address only, so it cannot be used for anything else
 * (https://docs.cdp.coinbase.com/api-reference/v2/authentication). The token is made here from the key and nothing else is installed.
 *
 * The portal makes two kinds of key, and both are read: Ed25519 (a base64 string of 64 bytes, the seed and then the public half) and
 * ECDSA P-256 (a PEM). Nothing here puts the secret in an error, a log or a token.
 */

export const CDP_HOST = "api.cdp.coinbase.com";
export const CDP_X402_PATH = "/platform/v2/x402";
/** The only address a token is sent to. */
export const CDP_FACILITATOR_URL = `https://${CDP_HOST}${CDP_X402_PATH}`;

const TOKEN_SECONDS = 120;
const BACKSLASH = String.fromCharCode(92);
const NEWLINE = String.fromCharCode(10);
/** The fixed bytes that turn a 32-byte Ed25519 seed into a PKCS#8 private key. */
const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

export type CdpKey = { id: string; algorithm: "EdDSA" | "ES256"; key: KeyObject };

/** A key id as the portal shows it: a UUID, or organizations/<organization>/apiKeys/<id>. */
export const isCdpKeyId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9/_.-]{7,199}$/.test(value);

/**
 * The signing key from the two settings. Throws with a sentence that never contains the secret: a half-set or wrong key keeps the Base
 * rail off and says why, and is never allowed to turn anything else off.
 */
export function loadCdpKey(id: string, secret: string): CdpKey {
  if (!isCdpKeyId(id)) throw new Error("CDP_API_KEY_ID is not a key id the CDP portal makes");
  const text = secret.trim();
  if (text.includes("-----BEGIN")) {
    // A PEM pasted into a one-line setting arrives with the two characters backslash and n where each line break was.
    const pem = text.split(BACKSLASH + "n").join(NEWLINE);
    let key: KeyObject;
    try {
      key = createPrivateKey(pem);
    } catch {
      throw new Error("CDP_API_KEY_SECRET is not a private key that can be read");
    }
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error("CDP_API_KEY_SECRET must be an ECDSA P-256 or an Ed25519 key");
    }
    return { id, algorithm: "ES256", key };
  }
  if (!/^[A-Za-z0-9+/]{86}(==)?$/.test(text) || Buffer.from(text, "base64").length !== 64) {
    throw new Error("CDP_API_KEY_SECRET must be an ECDSA P-256 key (a PEM) or an Ed25519 key (base64, 64 bytes)");
  }
  const bytes = Buffer.from(text, "base64");
  const key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, bytes.subarray(0, 32)]), format: "der", type: "pkcs8" });
  // The secret is the seed and then the public half. A secret whose halves do not match was damaged in the copying, and would sign tokens Coinbase refuses.
  if (!createPublicKey(key).export({ type: "spki", format: "der" }).subarray(-32).equals(bytes.subarray(32))) throw new Error("CDP_API_KEY_SECRET is not a consistent Ed25519 key");
  return { id, algorithm: "EdDSA", key };
}

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * The bearer token for one request to the facilitator. `path` is the full path ("/platform/v2/x402/settle"). The claim that names the
 * request is `uris` in Coinbase's own SDK and `uri` in the examples in its documentation, so the token carries both.
 */
export function cdpBearer(cdp: CdpKey, method: "GET" | "POST", path: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = { alg: cdp.algorithm, typ: "JWT", kid: cdp.id, nonce: randomBytes(16).toString("hex") };
  const uri = `${method} ${CDP_HOST}${path}`;
  const claims = { sub: cdp.id, iss: "cdp", iat: nowSeconds, nbf: nowSeconds, exp: nowSeconds + TOKEN_SECONDS, uris: [uri], uri };
  const signingInput = Buffer.from(`${part(header)}.${part(claims)}`);
  // ES256 is the raw 64 bytes (r then s) a JWT carries, not the DER form Node gives by default.
  const signature = cdp.algorithm === "EdDSA" ? sign(null, signingInput, cdp.key) : sign("sha256", signingInput, { key: cdp.key, dsaEncoding: "ieee-p1363" });
  return `${signingInput.toString("utf8")}.${signature.toString("base64url")}`;
}
