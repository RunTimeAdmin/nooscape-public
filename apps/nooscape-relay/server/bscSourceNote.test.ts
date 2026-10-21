import { describe, expect, it } from "vitest";
import { sanitizeDirectoryEntry } from "./db";
import { BNB_FETCH_SENTENCE, currentBnbSourceNote } from "./bscSourceNote";

// What an entry stored before 2026-10-17 carries, word for word (server/ingestion/bscChain.ts at 26f2cfa).
const STORED_WEB = "BNB Smart Chain ERC-8004 registration. The registry-recorded URI is a web link; Nooscape did not fetch it. The event records owner 0xabc; current ownership is not verified.";
const STORED_IPFS = "BNB Smart Chain ERC-8004 registration. The registry-recorded URI is an IPFS reference; Nooscape did not fetch it. The event records owner 0xabc; current ownership is not verified.";
// What an entry stored on 2026-10-17, before the registration-file step, carries.
const STORED_PREVIOUS = "BNB Smart Chain ERC-8004 registration. The registry-recorded URI is a web link. The directory pass records chain data only and did not fetch it. A one-off census on 2026-10-16 fetched some registration links that were on the chain that day; which ones is not recorded. The event records owner 0xabc; current ownership is not verified.";

describe("the BNB source note about fetching", () => {
  it("is read as the current sentence when it was stored with the old one", () => {
    expect(currentBnbSourceNote(STORED_WEB)).toBe(
      `BNB Smart Chain ERC-8004 registration. The registry-recorded URI is a web link. ${BNB_FETCH_SENTENCE} The event records owner 0xabc; current ownership is not verified.`
    );
    expect(currentBnbSourceNote(STORED_IPFS)).toContain(`an IPFS reference. ${BNB_FETCH_SENTENCE}`);
    expect(currentBnbSourceNote(STORED_WEB)).not.toContain("Nooscape did not fetch it");
  });

  it("is read as the current sentence when it was stored with the sentence of 2026-10-17 too", () => {
    expect(currentBnbSourceNote(STORED_PREVIOUS)).toBe(
      `BNB Smart Chain ERC-8004 registration. The registry-recorded URI is a web link. ${BNB_FETCH_SENTENCE} The event records owner 0xabc; current ownership is not verified.`
    );
    expect(currentBnbSourceNote(STORED_PREVIOUS)).not.toContain("did not fetch it");
  });

  it("says what happens: the pass reads chain data and the file behind an https or ipfs link, keeps only a key and a host, and a dated census had read some links earlier", () => {
    expect(BNB_FETCH_SENTENCE).toContain("The directory pass reads chain data and, for a listed entry's https or ipfs link, the file behind it, to group look-alike entries");
    expect(BNB_FETCH_SENTENCE).toContain("it keeps only a grouping key and a host");
    expect(BNB_FETCH_SENTENCE).toContain("A one-off census on 2026-10-16 had read some links earlier.");
    expect(BNB_FETCH_SENTENCE).not.toContain("did not fetch");
  });

  it("leaves a note already in the current wording alone, so reading it twice changes nothing", () => {
    const once = currentBnbSourceNote(STORED_WEB)!;
    expect(currentBnbSourceNote(once)).toBe(once);
  });

  it("does not touch a note that has no fetch sentence, another source's note, or nothing", () => {
    const inline = "BNB Smart Chain ERC-8004 registration. The registry-recorded URI is inline registration JSON, decoded locally; the name is self-asserted. The event records owner 0xabc; current ownership is not verified.";
    expect(currentBnbSourceNote(inline)).toBe(inline);
    // Robinhood's retained signal says the same old words about its observation and stays as it is.
    const robinhood = "Registry-recorded URI is a web link; Nooscape did not fetch it.";
    expect(currentBnbSourceNote(robinhood)).toBe(robinhood);
    expect(currentBnbSourceNote(null)).toBeNull();
    expect(currentBnbSourceNote("")).toBe("");
  });

  it("is applied where entries are served, to the note and to nothing else", () => {
    const served = sanitizeDirectoryEntry({ displayName: "Agent #1", protocol: "erc8004_bsc", sourceSignalNote: STORED_WEB });
    expect(served.sourceSignalNote).toContain(BNB_FETCH_SENTENCE);
    expect(served.displayName).toBe("Agent #1");
    expect(served.protocol).toBe("erc8004_bsc");
    // An entry with no note, as in the lists that carry only a name, gets none added.
    expect("sourceSignalNote" in sanitizeDirectoryEntry({ displayName: "Agent #2" })).toBe(false);
  });
});
