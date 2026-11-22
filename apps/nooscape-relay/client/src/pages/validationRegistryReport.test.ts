import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { describe, expect, it } from "vitest";
import { DERIVED as d, DOC, EARLIER, MEASURED, REGISTRY, RUN, SCRIPT, type ChainRow } from "@/lib/validationRegistryReport";
import ValidationRegistryReport from "./ValidationRegistryReport";

/**
 * The Validation Registry note states numbers that people will quote, so they are held to their source. The page reads
 * lib/validationRegistryReport.ts and nothing else. These render it, check that every number on it is one of that file's figures, check each
 * row of that file against the measurement record, check the totals add up and the checks held, and keep the page to the rules the other
 * reports set: no agent, validator or wallet named, no ranking, no score.
 */
const here = import.meta.dirname;
const read = (...parts: string[]) => readFileSync(path.resolve(here, ...parts), "utf8").replace(/\r\n/g, "\n");
const docs = (name: string) => read("..", "..", "..", "docs", name);

const ROUTE = "/field/validation-registry-2026-11-20";
const markup = renderToStaticMarkup(createElement(Router, { ssrPath: ROUTE, children: createElement(ValidationRegistryReport) }));
const decode = (value: string) => value.replace(/&rsquo;/g, "’").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const textOf = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const text = textOf(markup);
const doc = docs("validation-registry-census-2026-11-20.md");
const script = docs("validation-registry-census-2026-11-20.mjs");
const n = (value: number) => value.toLocaleString("en-US");

const readRows = MEASURED.filter(row => row.status === "read");
const notReadRows = MEASURED.filter(row => row.status === "not-read");
const sum = (values: ReadonlyArray<number | null>) => values.reduce<number>((total, value) => total + (value ?? 0), 0);
const ownerCell = (row: ChainRow) => (row.requests ? `${n(row.ownerAtRequest!.validator)} of ${n(row.requests)}` : "none");

describe("the figures file", () => {
  it("holds one row for each chain, in one of three states, and the states carry the right fields", () => {
    expect(new Set(MEASURED.map(row => row.key)).size).toBe(MEASURED.length);
    expect(new Set(MEASURED.map(row => row.chainId)).size).toBe(MEASURED.length);
    for (const row of MEASURED) {
      if (row.status === "read") {
        expect(row.reason, row.key).toBeNull();
        for (const value of [row.headBlock, row.requests, row.responses, row.agentsAsked, row.validatorsNamed]) expect(Number.isInteger(value), row.key).toBe(true);
        expect(row.controls, row.key).not.toBeNull();
        const own = row.ownerAtRequest!;
        expect(own.validator + own.other + own.unknown, `${row.key}: every request has an owner reading`).toBe(row.requests);
        // A date only where there is an event.
        const any = (row.requests ?? 0) + (row.responses ?? 0) > 0;
        expect(row.first !== null && row.last !== null, row.key).toBe(any);
        if (any) expect(row.first! <= row.last!, row.key).toBe(true);
        for (const date of [row.first, row.last]) if (date !== null) expect(date).toMatch(/^2026-\d{2}-\d{2}$/);
      } else if (row.status === "not-read") {
        // A chain that was not read has a reason and no figure: not read is never the same as none.
        expect(row.reason, row.key).toMatch(/\S/);
        for (const value of [row.headBlock, row.requests, row.responses, row.agentsAsked, row.validatorsNamed, row.ownerAtRequest, row.first, row.last, row.controls]) expect(value, row.key).toBeNull();
      } else {
        // No registry at the address: nothing was counted. A reason is there only when another contract holds the address.
        if (row.reason !== null) expect(row.reason, row.key).toMatch(/not this registry/);
        for (const value of [row.headBlock, row.requests, row.responses, row.agentsAsked, row.validatorsNamed, row.ownerAtRequest, row.first, row.last, row.controls]) expect(value, row.key).toBeNull();
      }
    }
  });

  it("adds up", () => {
    expect(d.asked).toBe(MEASURED.length);
    expect(d.read + d.notRead + d.noRegistry).toBe(d.asked);
    expect(d.withRegistry).toBe(d.read + d.notRead);
    expect(d.requests).toBe(sum(readRows.map(row => row.requests)));
    expect(d.responses).toBe(sum(readRows.map(row => row.responses)));
    expect(d.chainsWithAny + d.chainsWithNone).toBe(d.read);
    expect(d.ownerNamed + d.ownerOther + d.ownerUnknown).toBe(d.requests);
    expect(d.agreement.same + d.agreement.higher + d.agreement.lower).toBe(d.agreement.compared);
  });

  it("holds the checks: every chain that was read passed all three, and the count is never lower than the earlier reader's", () => {
    expect(d.controlsHeld).toBe(true);
    for (const row of readRows) expect(row.controls, row.key).toEqual({ a: true, b: true, c: true });
    expect(d.agreement.lower).toBe(0);
  });

  it("read Base and BNB Chain, which the page says were read through archive endpoints", () => {
    for (const key of ["base", "bnb"]) expect(MEASURED.find(row => row.key === key)?.status, key).toBe("read");
  });

  it("names the earlier reader's chains, each once", () => {
    const keys = [...EARLIER.active.map(entry => entry.key), ...EARLIER.none];
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(MEASURED.some(row => row.key === key), key).toBe(true);
  });
});

describe("the measurement record", () => {
  const cells = (label: string) => {
    const line = doc.split("\n").find(row => row.startsWith(`| ${label} |`));
    expect(line, `${label} has a row in the record`).toBeDefined();
    return line!.split("|").slice(1, -1).map(cell => cell.trim());
  };

  it("has a row for each chain that says the same as the figures file", () => {
    for (const row of MEASURED) {
      const c = cells(row.label);
      expect(c[1], `${row.label} chain id`).toBe(String(row.chainId));
      if (row.status === "read") {
        const own = row.ownerAtRequest!;
        expect(c.slice(2), row.label).toEqual(["read", n(row.requests!), n(row.responses!), n(row.agentsAsked!), n(row.validatorsNamed!), n(own.validator), n(own.other), n(own.unknown), row.first ?? "none", row.last ?? "none", n(row.headBlock!)]);
      } else if (row.status === "not-read") {
        expect(c[2], row.label).toBe("not read");
        expect(c[3], row.label).toBe("not read");
      } else {
        expect(c[2], row.label).toBe("no registry");
      }
    }
  });

  it("states the totals and the registry's address, the date and where the address comes from", () => {
    expect(doc).toContain(`${n(d.requests)} requests and ${n(d.responses)} responses`);
    expect(doc).toContain(REGISTRY.address);
    expect(doc).toContain(REGISTRY.implementation);
    expect(doc).toContain(REGISTRY.testnetAddress);
    expect(doc).toContain(REGISTRY.source.split(",")[0]);
    expect(doc).toContain(RUN.date);
    expect(doc).toContain(EARLIER.url);
    for (const entry of EARLIER.active) expect(doc, entry.key).toContain(`${entry.requests} requests`);
    expect(doc).toContain(`${n(d.requests)} requests and ${n(d.responses)} responses were found on the chains that were read. ${n(d.chainsWithAny)} of those ${n(d.read)} chains hold any; the other ${n(d.chainsWithNone)} hold none.`);
    expect(doc).toContain(`In ${n(d.ownerNamed)} of the ${n(d.requests)} requests the validator named was that owner.`);
    expect(doc).toContain(`Of the ${n(d.agreement.compared)} chains both counts cover, they agree on ${n(d.agreement.same)}${d.agreement.higher > 0 ? `, and this count is higher on ${n(d.agreement.higher)}` : ""}`);
    expect(doc).toContain(`on ${n(d.asked)} chains, from ${RUN.from} to the newest block`);
    expect(doc).toContain(d.controlsHeld ? `All three held on each of the ${n(d.read)} chains that were read.` : "Not all three held");
  });

  it("is the one the script's header names, and the script counts the registry and the date the page says", () => {
    expect(script).toContain(`docs/${DOC.split("/").pop()}`);
    expect(DOC).toBe("docs/validation-registry-census-2026-11-20.md");
    expect(SCRIPT).toBe("docs/validation-registry-census-2026-11-20.mjs");
    expect(script).toContain(`REGISTRY = "${REGISTRY.address}"`);
    expect(script).toContain("Date.UTC(2026, 0, 1)");
    expect(RUN.from).toBe("2026-01-01");
  });
});

describe("the page", () => {
  it("has a row for each chain that says what the figures file says", () => {
    for (const row of MEASURED) {
      if (row.status === "read") {
        expect(text, row.key).toContain([row.label, n(row.requests!), n(row.responses!), n(row.agentsAsked!), n(row.validatorsNamed!), ownerCell(row), row.last ?? "none"].join(" "));
      } else if (row.status === "not-read") {
        expect(text, row.key).toContain(`${row.label} Not read. ${row.reason}`);
      } else {
        expect(text, row.key).toContain(`${row.label} No registry at this address.${row.reason ? ` ${row.reason}` : ""}`);
      }
    }
  });

  it("states the totals, who was asked and the other reader's count from the figures file", () => {
    expect(text).toContain(`${n(d.asked)} chains were asked. ${n(d.withRegistry)} have the registry at that address`);
    expect(text).toContain(`${n(d.requests)} requests and ${n(d.responses)} responses were found on the chains that were read. ${n(d.chainsWithAny)} of those ${n(d.read)} chains hold any; the other ${n(d.chainsWithNone)} hold none.`);
    expect(text).toContain(`In ${n(d.ownerNamed)} of the ${n(d.requests)} requests the validator named was that owner`);
    expect(text).toContain(`Of the ${n(d.agreement.compared)} chains both counts cover, they agree on ${n(d.agreement.same)}`);
    expect(text).toContain("all three held");
    expect(text).toContain(`as of 13 October 2026`);
    expect(EARLIER.asOf).toBe("2026-10-13");
  });

  it("carries no number that is not one of the figures, a date or an address", () => {
    const withoutCode = textOf(markup.replace(/<code[^>]*>[\s\S]*?<\/code>/g, " "))
      .replace(/\d{4}-\d{2}-\d{2}/g, " ")
      .replace(/\b\d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\b/g, " ")
      .replace(/ERC-8004/g, " ")
      .replace(/erc-8004-contracts/g, " ")
      .replace(/commit [0-9a-f]{12}/g, " ");
    // A number in a sentence can be followed by a comma, which is the sentence's and not the number's.
    const numbersIn = (text: string) => (text.match(/\d[\d,]*/g) ?? []).map(digits => digits.replace(/,+$/, ""));
    const found = numbersIn(withoutCode);
    const figures = new Set<string>();
    const collect = (value: unknown) => {
      if (typeof value === "number") figures.add(n(value));
      else if (typeof value === "string") for (const digits of numbersIn(value)) figures.add(digits);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === "object") Object.values(value).forEach(collect);
    };
    collect(MEASURED.map(row => [row.requests, row.responses, row.agentsAsked, row.validatorsNamed, row.ownerAtRequest, row.reason]));
    collect(d);
    for (const number of found) expect(figures.has(number), `the page shows ${number}, which is not one of the figures`).toBe(true);
  });

  it("names no agent, validator or wallet: the only addresses are the two registry addresses", () => {
    const addresses = (markup.match(/0x[0-9a-fA-F]{6,}/g) ?? []).map(address => address.toLowerCase());
    for (const address of addresses) expect([REGISTRY.address, REGISTRY.testnetAddress].map(value => value.toLowerCase()), address).toContain(address);
    expect(new Set(addresses).size).toBe(2);
  });

  it("gives no score, ranks nothing and has no long dash", () => {
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      if (/\bscore/i.test(sentence)) expect(sentence, sentence).toMatch(/no score|not a score/i);
    }
    expect(text).not.toMatch(/\b(rank|ranked|ranking|leaderboard|top \d)\b/i);
    expect(text).not.toMatch(/\b(trusted|trustworthy|safe|verified|certified)\b/i);
    expect(text).not.toMatch(/[\u2013\u2014]/);
    expect(textOf(markup)).toContain("lists no agent, ranks nothing, names no wallet and gives no score");
  });

  it("says that a chain not read is not a chain with none, and what a request and a response are not", () => {
    expect(text).toContain("A chain that was not read is not a chain with none.");
    expect(text).toContain("A request is not a result, and a response is not an endorsement.");
    expect(text).toContain("Only the events were read. No request document was fetched, and no validator was called.");
    expect(text).toContain("A chain that is not in the table was not asked.");
  });
});
