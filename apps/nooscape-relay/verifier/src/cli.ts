import { readFile } from "node:fs/promises";
import { readKeyManifest, readPacket, verifyEvidencePacket, type RelayKey, type VerifyResult } from "./verify.js";

export const DEFAULT_KEYS_URL = "https://nooscape.si/.well-known/nooscape-keys.json";

/** What the command reads and writes, so a test can run it without a disk, a terminal or a network. */
export type CliIo = {
  readFile: (path: string) => Promise<string>;
  readStdin: () => Promise<string>;
  /** Only used with --fetch-keys. */
  fetchText: (url: string) => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
};

const USAGE = `Usage: nooscape-verify <packet.json | -> [options]

Checks a Nooscape signed evidence packet: that it is unchanged since it was signed, and which key signed it.
A packet is the file the site's "download evidence" button saves. Use - to read it from standard input.

Options:
  --keys <file>        The key list to trust: a saved copy of ${DEFAULT_KEYS_URL}
  --fetch-keys [url]   Fetch the key list now (default ${DEFAULT_KEYS_URL}).
                       The only thing this tool ever sends over the network.
  --json               Print the result as JSON
  -h, --help           This text

Without a key list the digest and the signature are still checked, but nothing says whose key signed
the packet, so it is reported as not verified.

Exit status: 0 verified, 1 not verified, 2 the input could not be read.
`;

type Options = { packet: string; keysFile?: string; fetchKeys?: string; json: boolean };

function parseArgs(argv: readonly string[]): Options | { help: true } | { error: string } {
  let packet: string | undefined;
  let keysFile: string | undefined;
  let fetchKeys: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--json") json = true;
    else if (arg === "--keys") {
      const value = argv[(i += 1)];
      if (!value) return { error: "--keys needs a file name" };
      keysFile = value;
    } else if (arg === "--fetch-keys") {
      const next = argv[i + 1];
      if (next !== undefined && /^https?:\/\//i.test(next)) {
        fetchKeys = next;
        i += 1;
      } else fetchKeys = DEFAULT_KEYS_URL;
    } else if (arg === "-" || !arg.startsWith("-")) {
      if (packet !== undefined) return { error: "give one packet" };
      packet = arg;
    } else return { error: `unknown option ${arg}` };
  }
  if (packet === undefined) return { error: "give the packet to check" };
  if (keysFile !== undefined && fetchKeys !== undefined) return { error: "use --keys or --fetch-keys, not both" };
  // A key list over plain http could be changed on the way, and the list is what the whole check rests on.
  if (fetchKeys !== undefined && !/^https:\/\//i.test(fetchKeys) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(fetchKeys)) {
    return { error: "the key list must be fetched over https" };
  }
  return { packet, keysFile, fetchKeys, json };
}

function describeKey(result: VerifyResult, keyId: string | undefined, listGiven: boolean) {
  const id = keyId ? ` (${keyId})` : "";
  if (result.keyStatus === "unknown") return listGiven ? `not in the key list${id}` : "no key list was given";
  return `${result.keyStatus}${id}`;
}

/** Runs the command and returns its exit status. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  const options = parseArgs(argv);
  if ("help" in options) {
    io.out(USAGE.trimEnd());
    return 0;
  }
  if ("error" in options) {
    io.err(`nooscape-verify: ${options.error}\n\n${USAGE.trimEnd()}`);
    return 2;
  }

  let packetText: string;
  try {
    packetText = options.packet === "-" ? await io.readStdin() : await io.readFile(options.packet);
  } catch (error) {
    io.err(`nooscape-verify: cannot read ${options.packet === "-" ? "standard input" : options.packet}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  let packetJson: unknown;
  try {
    packetJson = JSON.parse(packetText);
  } catch {
    io.err(`nooscape-verify: ${options.packet === "-" ? "the input" : options.packet} is not JSON`);
    return 2;
  }
  const read = readPacket(packetJson);
  if (!read.ok) {
    io.err(`nooscape-verify: this is not a Nooscape evidence packet: ${read.error}`);
    return 2;
  }

  let keys: RelayKey[] = [];
  let ignored: string[] = [];
  const listGiven = options.keysFile !== undefined || options.fetchKeys !== undefined;
  if (listGiven) {
    const source = options.keysFile ?? options.fetchKeys!;
    let manifestText: string;
    try {
      manifestText = options.keysFile !== undefined ? await io.readFile(options.keysFile) : await io.fetchText(options.fetchKeys!);
    } catch (error) {
      io.err(`nooscape-verify: cannot read the key list ${source}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
    let manifestJson: unknown;
    try {
      manifestJson = JSON.parse(manifestText);
    } catch {
      io.err(`nooscape-verify: the key list ${source} is not JSON`);
      return 2;
    }
    ({ keys, ignored } = readKeyManifest(manifestJson));
    for (const reason of ignored) io.err(`nooscape-verify: key list: ${reason}; that line is not trusted`);
  }

  const result = verifyEvidencePacket(read.packet, keys);
  if (options.json) {
    io.out(JSON.stringify({ result, keys: { count: keys.length, ignored } }, null, 2));
    return result.valid ? 0 : 1;
  }

  const ok = (good: boolean) => (good ? "ok" : "FAILED");
  io.out(`Packet for agent ${result.agentId}`);
  io.out(`  observed ${result.observedAt}, sequence ${result.sequence}, ${result.entryCount} ${result.entryCount === 1 ? "entry" : "entries"}`);
  io.out("");
  io.out(`  digest (SHA-256)      ${ok(result.hashValid)}`);
  io.out(`  signature (Ed25519)   ${ok(result.signatureValid)}`);
  io.out(`  signed fields         ${result.payloadMatchesEnvelopeFields ? "match the displayed fields" : "DO NOT match the displayed fields"}`);
  io.out(`  key                   ${describeKey(result, read.packet.envelope.relayKeyId, listGiven)}`);
  io.out("");
  if (result.valid) {
    io.out("VERIFIED: the packet is unchanged since a key in the key list signed it.");
  } else {
    io.out("NOT VERIFIED");
    for (const issue of result.issues) io.out(`  - ${issue}`);
    if (!listGiven) io.out("  - No key list was given, so nothing says whose key signed this. Use --keys <file> or --fetch-keys.");
  }
  io.out("");
  io.out("This checks the packet and who signed it. It says nothing about the agent: not that it works, and not that it is safe.");
  return result.valid ? 0 : 1;
}

/** The command's real reading, writing and network. */
export function nodeIo(): CliIo {
  return {
    readFile: path => readFile(path, "utf8"),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    },
    fetchText: async url => {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "error", headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`the server answered ${response.status}`);
      const text = await response.text();
      if (text.length > 1_000_000) throw new Error("the key list is larger than 1 MB");
      return text;
    },
    out: line => process.stdout.write(`${line}\n`),
    err: line => process.stderr.write(`${line}\n`),
  };
}
