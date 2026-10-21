import { afterEach, describe, expect, it, vi } from "vitest";
import { USAGE, keyFrom, main, parseArgs } from "../src/cli.js";
import { VERSION } from "../src/version.js";

afterEach(() => vi.restoreAllMocks());

describe("the command line", () => {
  it("serves over stdio by default", () => {
    expect(parseArgs([])).toEqual({ mode: "stdio" });
  });

  it("serves over HTTP behind a flag, on this machine by default", () => {
    expect(parseArgs(["--http"])).toEqual({ mode: "http", port: 8787, host: "127.0.0.1" });
    expect(parseArgs(["--http", "--port", "0"])).toEqual({ mode: "http", port: 0, host: "127.0.0.1" });
    expect(parseArgs(["--http", "--port", "9000", "--host", "0.0.0.0"])).toEqual({ mode: "http", port: 9000, host: "0.0.0.0" });
  });

  it("refuses what it does not know, and a port or host without the HTTP flag", () => {
    for (const args of [["--nope"], ["--http", "--port"], ["--http", "--port", "abc"], ["--http", "--port", "70000"], ["--http", "--port", "1.5"], ["--http", "--host"], ["--port", "80"], ["--host", "x"], ["extra"]]) {
      expect(parseArgs(args).mode, args.join(" ")).toBe("error");
    }
  });

  it("answers help and version", () => {
    expect(parseArgs(["--help"])).toEqual({ mode: "help" });
    expect(parseArgs(["-h"])).toEqual({ mode: "help" });
    expect(parseArgs(["--version"])).toEqual({ mode: "version" });
    expect(parseArgs(["-v"])).toEqual({ mode: "version" });
  });

  it("prints the help and the version to stdout and exits 0", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await main(["--help"], {})).toBe(0);
    expect(await main(["--version"], {})).toBe(0);
    expect(write.mock.calls.map(call => String(call[0])).join("")).toContain(USAGE);
    expect(write.mock.calls.map(call => String(call[0])).join("")).toContain(`${VERSION}\n`);
  });

  it("explains a mistake on stderr and exits 2, with nothing on stdout", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main(["--bogus"], {})).toBe(2);
    expect(out).not.toHaveBeenCalled();
    expect(String(err.mock.calls[0]![0])).toContain("Unknown option --bogus.");
  });

  it("says how the key is given, and that it is never echoed", () => {
    expect(USAGE).toContain("NOOSCAPE_API_KEY");
    expect(USAGE).toContain("Never logged or echoed");
    expect(USAGE).toContain("--http");
  });

  it("reads the key from NOOSCAPE_API_KEY, and treats empty or an unfilled placeholder as no key", () => {
    expect(keyFrom({ NOOSCAPE_API_KEY: "  nsk_abc  " })).toBe("nsk_abc");
    expect(keyFrom({})).toBeUndefined();
    expect(keyFrom({ NOOSCAPE_API_KEY: "" })).toBeUndefined();
    expect(keyFrom({ NOOSCAPE_API_KEY: "   " })).toBeUndefined();
    expect(keyFrom({ NOOSCAPE_API_KEY: "${user_config.api_key}" })).toBeUndefined();
  });

  it("reports the version from package.json", () => {
    expect(VERSION).toMatch(/^[0-9]+[.][0-9]+[.][0-9]+/);
  });
});
