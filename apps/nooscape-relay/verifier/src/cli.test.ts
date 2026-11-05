import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listedFixture, packetFixture } from "../test/fixture";
import { DEFAULT_KEYS_URL, main, type CliIo } from "./cli";
import { KEY_MANIFEST_FORMAT } from "./verify";

/** The command with a disk, a standard input and a network that are all made up, so each case says exactly what it was given. */
function run(argv: string[], files: Record<string, string> = {}, options: { stdin?: string; fetched?: Record<string, string | Error> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const fetchedUrls: string[] = [];
  const io: CliIo = {
    readFile: async path => {
      if (path in files) return files[path]!;
      throw new Error(`ENOENT: no such file ${path}`);
    },
    readStdin: async () => options.stdin ?? "",
    fetchText: async url => {
      fetchedUrls.push(url);
      const answer = options.fetched?.[url];
      if (answer === undefined) throw new Error("the server answered 404");
      if (answer instanceof Error) throw answer;
      return answer;
    },
    out: line => out.push(line),
    err: line => err.push(line),
  };
  return main(argv, io).then(code => ({ code, out: out.join("\n"), err: err.join("\n"), fetchedUrls }));
}

describe("nooscape-verify", () => {
  const fixture = packetFixture();
  const good = JSON.stringify(fixture.packet);
  const keys = JSON.stringify(fixture.manifest);

  it("verifies a packet against a key list from a file, says what it checked, and exits 0", async () => {
    const result = await run(["packet.json", "--keys", "keys.json"], { "packet.json": good, "keys.json": keys });
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(result.out).toContain("Packet for agent agent-under-test");
    expect(result.out).toContain("sequence 4, 1 entry");
    expect(result.out).toContain("digest (SHA-256)      ok");
    expect(result.out).toContain("signature (Ed25519)   ok");
    expect(result.out).toContain("signed fields         match the displayed fields");
    expect(result.out).toContain("key                   active (key-1)");
    expect(result.out).toContain("VERIFIED: the packet is unchanged since a key in the key list signed it.");
    expect(result.out).toContain("It says nothing about the agent: not that it works, and not that it is safe.");
    expect(result.fetchedUrls).toEqual([]);
  });

  it("never touches the network unless it is asked to", async () => {
    const result = await run(["packet.json"], { "packet.json": good });
    expect(result.fetchedUrls).toEqual([]);
  });

  it("checks the digest and the signature without a key list, but does not call the packet verified and says why", async () => {
    const result = await run(["packet.json"], { "packet.json": good });
    expect(result.code).toBe(1);
    expect(result.out).toContain("digest (SHA-256)      ok");
    expect(result.out).toContain("signature (Ed25519)   ok");
    expect(result.out).toContain("key                   no key list was given");
    expect(result.out).toContain("NOT VERIFIED");
    expect(result.out).toContain("Use --keys <file> or --fetch-keys.");
    expect(result.out).not.toContain("VERIFIED: the packet");
  });

  it("reports a displayed field changed after signing, with the reason, and exits 1", async () => {
    const tampered = fixture.copy();
    tampered.envelope.entries[0]!.detail = "Changed after signing.";
    const result = await run(["packet.json", "--keys", "keys.json"], { "packet.json": JSON.stringify(tampered), "keys.json": keys });
    expect(result.code).toBe(1);
    expect(result.out).toContain("signed fields         DO NOT match the displayed fields");
    expect(result.out).toContain("NOT VERIFIED");
    expect(result.out).toContain("  - The signed canonical payload does not match the envelope's displayed fields.");
  });

  it("reports a key the list has retired or revoked", async () => {
    const retired = JSON.stringify({ format: KEY_MANIFEST_FORMAT, keys: [listedFixture(fixture, "retired", "2026-10-01T00:00:00.000Z")] });
    const late = await run(["packet.json", "--keys", "keys.json"], { "packet.json": good, "keys.json": retired });
    expect(late.code).toBe(1);
    expect(late.out).toContain("key                   retired (key-1)");
    expect(late.out).toContain("dated after the key that signed it was retired");
    const revoked = JSON.stringify({ format: KEY_MANIFEST_FORMAT, keys: [listedFixture(fixture, "revoked")] });
    const gone = await run(["packet.json", "--keys", "keys.json"], { "packet.json": good, "keys.json": revoked });
    expect(gone.code).toBe(1);
    expect(gone.out).toContain("key                   revoked (key-1)");
    expect(gone.out).toContain("revoked by Nooscape");
  });

  it("says a key is not in the list when a list was given and does not have it", async () => {
    const other = JSON.stringify({ format: KEY_MANIFEST_FORMAT, keys: [] });
    const result = await run(["packet.json", "--keys", "keys.json"], { "packet.json": good, "keys.json": other });
    expect(result.code).toBe(1);
    expect(result.out).toContain("key                   not in the key list (key-1)");
    expect(result.out).not.toContain("Use --keys");
  });

  it("prints the result as JSON on request, with the exit status of the check", async () => {
    const ok = await run(["packet.json", "--keys", "keys.json", "--json"], { "packet.json": good, "keys.json": keys });
    expect(ok.code).toBe(0);
    const parsed = JSON.parse(ok.out);
    expect(parsed.result).toMatchObject({ valid: true, verifiedByNooscape: true, keyStatus: "active", issues: [] });
    expect(parsed.keys).toEqual({ count: 1, ignored: [] });
    const bad = await run(["packet.json", "--json"], { "packet.json": good });
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out).result).toMatchObject({ valid: false, keyStatus: "unknown" });
  });

  it("reads the packet from standard input with -", async () => {
    const result = await run(["-", "--keys", "keys.json"], { "keys.json": keys }, { stdin: good });
    expect(result.code).toBe(0);
    expect(result.out).toContain("VERIFIED:");
  });

  it("fetches the key list only with --fetch-keys, from the published address unless another is given", async () => {
    const fetched = { [DEFAULT_KEYS_URL]: keys, "https://keys.example.test/nooscape-keys.json": keys };
    const byDefault = await run(["packet.json", "--fetch-keys"], { "packet.json": good }, { fetched });
    expect(byDefault.code).toBe(0);
    expect(byDefault.fetchedUrls).toEqual([DEFAULT_KEYS_URL]);
    const named = await run(["packet.json", "--fetch-keys", "https://keys.example.test/nooscape-keys.json"], { "packet.json": good }, { fetched });
    expect(named.code).toBe(0);
    expect(named.fetchedUrls).toEqual(["https://keys.example.test/nooscape-keys.json"]);
    const local = await run(["packet.json", "--fetch-keys", "http://localhost:3000/keys.json"], { "packet.json": good }, { fetched: { "http://localhost:3000/keys.json": keys } });
    expect(local.code).toBe(0);
  });

  it("will not fetch the key list over plain http from anywhere but this machine", async () => {
    const result = await run(["packet.json", "--fetch-keys", "http://keys.example.test/keys.json"], { "packet.json": good });
    expect(result.code).toBe(2);
    expect(result.err).toContain("the key list must be fetched over https");
    expect(result.fetchedUrls).toEqual([]);
  });

  it("exits 2 with the reason when the key list cannot be fetched or is not JSON", async () => {
    const down = await run(["packet.json", "--fetch-keys"], { "packet.json": good }, { fetched: { [DEFAULT_KEYS_URL]: new Error("the server answered 503") } });
    expect(down.code).toBe(2);
    expect(down.err).toContain(`cannot read the key list ${DEFAULT_KEYS_URL}: the server answered 503`);
    const junk = await run(["packet.json", "--keys", "keys.json"], { "packet.json": good, "keys.json": "<html>" });
    expect(junk.code).toBe(2);
    expect(junk.err).toContain("the key list keys.json is not JSON");
    const missing = await run(["packet.json", "--keys", "nope.json"], { "packet.json": good });
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("cannot read the key list nope.json");
  });

  it("names a line of the key list it does not trust and goes on with the rest", async () => {
    const mixed = JSON.stringify({ format: KEY_MANIFEST_FORMAT, keys: [{ keyId: "junk", publicKeyPem: "not a key", status: "active" }, ...fixture.manifest.keys] });
    const result = await run(["packet.json", "--keys", "keys.json"], { "packet.json": good, "keys.json": mixed });
    expect(result.code).toBe(0);
    expect(result.err).toContain("key list: entry 0 has a publicKeyPem that does not parse; that line is not trusted");
  });

  it("exits 2, and says what was wrong, for input that is not a packet", async () => {
    const none = await run(["nope.json"]);
    expect(none.code).toBe(2);
    expect(none.err).toContain("cannot read nope.json");
    const junk = await run(["packet.json"], { "packet.json": "not json" });
    expect(junk.code).toBe(2);
    expect(junk.err).toContain("packet.json is not JSON");
    const other = await run(["packet.json"], { "packet.json": JSON.stringify({ hello: "world" }) });
    expect(other.code).toBe(2);
    expect(other.err).toContain('this is not a Nooscape evidence packet: format must be "Nooscape Signed Evidence Envelope v1"');
    const stdin = await run(["-"], {}, { stdin: "nope" });
    expect(stdin.code).toBe(2);
    expect(stdin.err).toContain("the input is not JSON");
  });

  it("fetches the key list from the address Nooscape publishes it at, and with no redirect, a time limit and a size limit", () => {
    expect(DEFAULT_KEYS_URL).toBe("https://nooscape.si/.well-known/nooscape-keys.json");
    const source = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");
    expect(source).toContain('redirect: "error"');
    expect(source).toContain("AbortSignal.timeout(10_000)");
    expect(source).toContain("text.length > 1_000_000");
  });

  it("shows how to use it, exits 0 for --help and 2 for a wrong command line", async () => {
    for (const flag of ["--help", "-h"]) {
      const help = await run([flag]);
      expect(help.code).toBe(0);
      for (const word of ["Usage: nooscape-verify", "--keys <file>", "--fetch-keys [url]", "--json", DEFAULT_KEYS_URL, "Exit status: 0 verified, 1 not verified, 2 the input could not be read."]) expect(help.out).toContain(word);
    }
    const cases: Array<[string[], string]> = [
      [[], "give the packet to check"],
      [["a.json", "b.json"], "give one packet"],
      [["--bogus"], "unknown option --bogus"],
      [["a.json", "--keys"], "--keys needs a file name"],
      [["a.json", "--keys", "k.json", "--fetch-keys"], "use --keys or --fetch-keys, not both"],
    ];
    for (const [argv, message] of cases) {
      const wrong = await run(argv);
      expect(wrong.code, argv.join(" ")).toBe(2);
      expect(wrong.err, argv.join(" ")).toContain(`nooscape-verify: ${message}`);
      expect(wrong.err).toContain("Usage:");
    }
  });
});
